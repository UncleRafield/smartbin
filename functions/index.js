const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();
const REGION = "europe-west2";
const MAX_POINTS_PER_CODE = 100;
const GLOBAL_SCAN_GAP_MS = 10_000;

const REWARDS = {
  bottle: { name: "Reusable bottle", cost: 2000 },
  gc5: { name: "£5 gift card", cost: 3000 },
  gc10: { name: "£10 gift card", cost: 6500 },
  gc25: { name: "£25 gift card", cost: 17000 },
  tree: { name: "Plant a tree", cost: 25000 }
};

function requireUser(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Please log in first.");
  }
  return request.auth.uid;
}

function parsePayload(rawText) {
  if (typeof rawText !== "string" || rawText.length > 2000) {
    throw new HttpsError("invalid-argument", "Invalid QR payload.");
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new HttpsError("invalid-argument", "This isn't a valid SmartBin QR code.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpsError("invalid-argument", "This isn't a SmartBin QR code.");
  }

  const keys = Object.keys(payload).sort();
  if (keys.length !== 3 || keys[0] !== "app" || keys[1] !== "code" || keys[2] !== "points") {
    throw new HttpsError("invalid-argument", "SmartBin QR codes must contain exactly app, code and points.");
  }

  if (payload.app !== "smartbin") {
    throw new HttpsError("invalid-argument", "This QR code belongs to a different app.");
  }

  if (typeof payload.code !== "string" || !/^BIN-\d{4}$/.test(payload.code)) {
    throw new HttpsError("invalid-argument", "The bin code format is invalid.");
  }

  if (!Number.isSafeInteger(payload.points) || payload.points < 1 || payload.points > MAX_POINTS_PER_CODE) {
    throw new HttpsError("invalid-argument", "The points value is invalid.");
  }

  return payload;
}

exports.ensureAccount = onCall({ region: REGION }, async request => {
  const uid = requireUser(request);
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists) {
      transaction.create(userRef, {
        email: request.auth.token.email || "",
        points: 0,
        lifetime: 0,
        items: 0,
        createdAt: FieldValue.serverTimestamp()
      });
    }
  });

  return { ok: true };
});

exports.claimBin = onCall({ region: REGION, enforceAppCheck: false }, async request => {
  const uid = requireUser(request);
  const payload = parsePayload(request.data && request.data.rawText);
  const userRef = db.collection("users").doc(uid);
  const codeRef = db.collection("codes").doc(payload.code);
  const claimRef = userRef.collection("binClaims").doc(payload.code);

  const result = await db.runTransaction(async transaction => {
    const [userSnapshot, codeSnapshot, claimSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(codeRef),
      transaction.get(claimRef)
    ]);

    if (!userSnapshot.exists) {
      throw new HttpsError("failed-precondition", "Your account profile is missing. Log out and back in.");
    }
    if (!codeSnapshot.exists) {
      throw new HttpsError("not-found", "That bin code isn't registered.");
    }

    const registered = codeSnapshot.data();
    if (!Number.isSafeInteger(registered.points) || registered.points < 1 || registered.points > MAX_POINTS_PER_CODE) {
      throw new HttpsError("failed-precondition", "This bin has an invalid points configuration.");
    }
    if (payload.points !== registered.points) {
      throw new HttpsError("invalid-argument", "The points in this QR code don't match the registered bin.");
    }

    const cooldownMinutes = registered.cooldownMinutes === undefined ? 1440 : registered.cooldownMinutes;
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 525600) {
      throw new HttpsError("failed-precondition", "This bin has an invalid cooldown configuration.");
    }

    const account = userSnapshot.data();
    const now = Date.now();
    const lastScanAt = account.lastScanAt instanceof Timestamp ? account.lastScanAt.toMillis() : 0;

    if (now - lastScanAt < GLOBAL_SCAN_GAP_MS) {
      throw new HttpsError("resource-exhausted", "Slow down! Wait a few seconds between scans.");
    }

    if (claimSnapshot.exists) {
      const previous = claimSnapshot.data();
      const previousAt = previous.claimedAt instanceof Timestamp ? previous.claimedAt.toMillis() : 0;
      const remainingMs = previousAt + cooldownMinutes * 60_000 - now;

      if (remainingMs > 0) {
        const wait = remainingMs >= 3_600_000
          ? Math.ceil(remainingMs / 3_600_000) + " h"
          : Math.ceil(remainingMs / 60_000) + " min";
        throw new HttpsError("resource-exhausted", "You've scanned this bin recently. Try again in " + wait + ".");
      }
    }

    const points = registered.points;
    transaction.set(claimRef, {
      code: payload.code,
      points,
      claimedAt: FieldValue.serverTimestamp()
    });

    transaction.update(userRef, {
      points: (Number(account.points) || 0) + points,
      lifetime: (Number(account.lifetime) || 0) + points,
      items: (Number(account.items) || 0) + 1,
      lastScanAt: FieldValue.serverTimestamp()
    });

    return { points };
  });

  return result;
});

exports.redeemReward = onCall({ region: REGION }, async request => {
  const uid = requireUser(request);
  const rewardId = request.data && request.data.rewardId;

  if (typeof rewardId !== "string" || !Object.prototype.hasOwnProperty.call(REWARDS, rewardId)) {
    throw new HttpsError("invalid-argument", "That reward isn't available.");
  }

  const reward = REWARDS[rewardId];
  const userRef = db.collection("users").doc(uid);
  const redemptionRef = userRef.collection("redemptions").doc();

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists) {
      throw new HttpsError("failed-precondition", "Your account profile is missing.");
    }

    const account = snapshot.data();
    const points = Number(account.points) || 0;
    if (points < reward.cost) {
      throw new HttpsError("failed-precondition", "Not enough points yet.");
    }

    transaction.update(userRef, { points: points - reward.cost });
    transaction.create(redemptionRef, {
      rewardId,
      reward: reward.name,
      cost: reward.cost,
      status: "pending",
      email: request.auth.token.email || "",
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { reward: reward.name, cost: reward.cost, status: "pending" };
});
