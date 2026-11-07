import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, runTransaction, addDoc, collection, query, orderBy, limit, getDocs, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { REWARDS, BINS } from "./store.js";

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
  document.addEventListener("DOMContentLoaded", () => {
    const error = document.getElementById("auth-error");
    if (error) error.textContent = "firebase-config.js still has placeholder values. Paste your real config and save the file.";
  });
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---- Settings ---- */
const $ = id => document.getElementById(id);
let mode = "login";
let user = null;
let data = null;

/* ---- Auth UI ---- */
function setMode(nextMode) {
  mode = nextMode;
  $("tab-login").classList.toggle("active", mode === "login");
  $("tab-signup").classList.toggle("active", mode === "signup");
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("auth-error").textContent = "";
}

$("tab-login").onclick = () => setMode("login");
$("tab-signup").onclick = () => setMode("signup");

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("auth-error").textContent = "";

  const email = $("email").value.trim();
  const password = $("password").value;

  try {
    if (mode === "signup") {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, "users", credential.user.uid), {
        email,
        points: 0,
        lifetime: 0,
        items: 0,
        lastClaimId: "",
        createdAt: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (error) {
    $("auth-error").textContent = friendly(error);
  }
});

$("logout").onclick = () => signOut(auth);

function friendly(error) {
  const code = error.code || "";

  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Incorrect email or password.";
  if (code.includes("email-already-in-use")) return "That email already has an account – try logging in.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (code.includes("invalid-email")) return "Please enter a valid email.";
  if (code.includes("too-many-requests")) return "Too many attempts. Try again later.";
  if (code.includes("api-key") || code.includes("invalid-api")) return "Firebase rejected the API key (" + code + "). Re-copy apiKey from Project settings > Your apps, and check its restrictions in Google Cloud > Credentials.";
  if (code.includes("configuration-not-found") || code.includes("operation-not-allowed")) return "Email/Password sign-in isn't enabled. Firebase console > Authentication > Sign-in method > Email/Password > Enable.";
  if (code.includes("unauthorized-domain")) return "This domain isn't allowed. Firebase console > Authentication > Settings > Authorized domains > add it.";
  if (code.includes("network-request-failed")) return "Couldn't reach Firebase. Check your connection.";

  return (code ? code + ": " : "") + (error.message || "Something went wrong.");
}

/* ---- Session ---- */
onAuthStateChanged(auth, async authenticatedUser => {
  stopScan();
  user = authenticatedUser;
  $("auth-view").hidden = !!user;
  $("app-view").hidden = !user;

  if (user) {
    $("user-email").textContent = user.email || "";
    try {
      await loadUser();
      renderRewards();
      render();
      await loadHistory();
    } catch (error) {
      console.error("Could not load account:", error);
      msg("log-msg", "Couldn't load your account. Check your connection and refresh.", true);
    }
  } else {
    data = null;
    $("auth-form").reset();
  }
});

async function loadUser() {
  const userRef = doc(db, "users", user.uid);
  let snapshot = await getDoc(userRef);

  if (!snapshot.exists()) {
    await setDoc(userRef, {
      email: user.email,
      points: 0,
      lifetime: 0,
      items: 0,
      lastClaimId: ""
    });
    snapshot = await getDoc(userRef);
  }

  data = snapshot.data();
}

/* ---- Render ---- */
function render() {
  if (!data) return;

  $("points").textContent = Number(data.points || 0).toLocaleString();
  $("items").textContent = Number(data.items || 0).toLocaleString();
  $("lifetime").textContent = Number(data.lifetime || 0).toLocaleString();

  document.querySelectorAll(".reward").forEach(rewardElement => {
    const reward = REWARDS.find(item => item.id === rewardElement.dataset.id);
    if (!reward) return;

    const button = rewardElement.querySelector(".btn");
    const fill = rewardElement.querySelector(".fill");
    button.disabled = Number(data.points || 0) < reward.cost;
    fill.style.width = Math.min(100, Number(data.points || 0) / reward.cost * 100) + "%";
  });
}

function renderRewards() {
  $("rewards").innerHTML = REWARDS.map(reward =>
    '<div class="reward" data-id="' + reward.id + '">' +
      '<div style="font-size:1.8rem">' + reward.emoji + '</div>' +
      '<h3>' + reward.name + '</h3>' +
      '<div class="cost">' + reward.cost.toLocaleString() + ' pts</div>' +
      '<div class="bar"><div class="fill" style="height:100%;background:var(--g)"></div></div>' +
      '<button class="btn" type="button">Redeem</button>' +
    '</div>'
  ).join("");

  document.querySelectorAll(".reward").forEach(element => {
    element.querySelector(".btn").onclick = () => redeem(element.dataset.id);
  });
}

function msg(id, message, isError = false) {
  const element = $(id);
  if (!element) return;
  element.textContent = message;
  element.className = "msg" + (isError ? " err" : "");
}

/* ---- QR validation and claiming ----
   QR payload format:
   {"app":"smartbin","code":"BIN-0001","points":10}

   The QR must contain exactly these three fields. The registered point
   value in store.js is authoritative; the QR's points value must match it.
*/
function parseSmartBinQR(rawText) {
  let payload;

  try {
    payload = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: "This isn't a valid SmartBin QR code." };
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { ok: false, reason: "This isn't a SmartBin QR code." };
  }

  const actualKeys = Object.keys(payload).sort();
  const requiredKeys = ["app", "code", "points"];

  if (
    actualKeys.length !== requiredKeys.length ||
    requiredKeys.some((key, index) => actualKeys[index] !== key)
  ) {
    return { ok: false, reason: "SmartBin QR codes must contain exactly app, code and points." };
  }

  if (payload.app !== "smartbin") {
    return { ok: false, reason: "This QR code belongs to a different app." };
  }

  if (typeof payload.code !== "string" || !/^BIN-\d{4}$/.test(payload.code)) {
    return { ok: false, reason: "The bin code format is invalid." };
  }

  if (!Number.isSafeInteger(payload.points) || payload.points < 1 || payload.points > 100) {
    return { ok: false, reason: "The points value in this QR code is invalid." };
  }

  const bin = BINS[payload.code];
  if (!bin) {
    return { ok: false, reason: 'Bin "' + payload.code + '" is not registered in store.js.' };
  }

  const registeredPoints = Number(bin.points);
  if (!Number.isSafeInteger(registeredPoints) || registeredPoints < 1 || registeredPoints > 100) {
    return { ok: false, reason: 'Bin "' + payload.code + '" has an invalid points setting in store.js.' };
  }

  if (payload.points !== registeredPoints) {
    return { ok: false, reason: "The points in this QR code don't match the registered bin. Please ask for a replacement QR code." };
  }

  return {
    ok: true,
    code: payload.code,
    points: registeredPoints,
    cooldownMinutes: Math.max(0, Number(bin.cooldownMinutes) || 0)
  };
}

async function claimCode(rawText) {
  const parsed = parseSmartBinQR(rawText);

  if (!parsed.ok) {
    msg("log-msg", parsed.reason, true);
    return;
  }

  if (!user) {
    stopScan();
    msg("log-msg", "Please log in before scanning a bin.", true);
    return;
  }

  const code = parsed.code;
  const pointsToAward = parsed.points;
  const cooldownMinutes = parsed.cooldownMinutes;
  const userRef = doc(db, "users", user.uid);

  try {
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(userRef);

      if (!snapshot.exists()) {
        throw new Error("Your account record is missing. Log out and back in.");
      }

      const account = snapshot.data();
      const previousScan = (account.binScans || {})[code] || 0;
      const remainingMs = previousScan + cooldownMinutes * 60000 - Date.now();

      if (remainingMs > 0) {
        const wait = remainingMs > 3600000
          ? Math.ceil(remainingMs / 3600000) + " h"
          : remainingMs > 60000
            ? Math.ceil(remainingMs / 60000) + " min"
            : Math.ceil(remainingMs / 1000) + " s";

        throw new Error("You've scanned this bin recently. Try again in " + wait + ".");
      }

      const lastAnyScan = account.lastScanAt && account.lastScanAt.toMillis
        ? account.lastScanAt.toMillis()
        : 0;

      if (Date.now() - lastAnyScan < 12000) {
        throw new Error("Slow down! Wait a few seconds between scans.");
      }

      transaction.update(userRef, {
        points: Number(account.points || 0) + pointsToAward,
        lifetime: Number(account.lifetime || 0) + pointsToAward,
        items: Number(account.items || 0) + 1,
        binScans: { ...(account.binScans || {}), [code]: Date.now() },
        lastScanAt: serverTimestamp()
      });
    });

    const freshSnapshot = await getDoc(userRef);
    data = freshSnapshot.data();

    stopScan();
    msg("log-msg", "+" + pointsToAward + " points added. Thanks for keeping it clean! 🌍");
  } catch (error) {
    stopScan();
    console.error("Scan failed:", error);

    const message = error.code === "permission-denied"
      ? "Firestore refused the update (permission-denied). Check that your latest firestore.rules are published in Firebase."
      : (error.code ? error.code + ": " : "") + (error.message || "Something went wrong.");

    msg("log-msg", message, true);
  }

  render();
}

/* ---- Scanner ---- */
let stream = null;
let scanning = false;
let lastRaw = "";
let lastAt = 0;

const video = $("video");
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });

let detector = null;

if ("BarcodeDetector" in window) {
  try {
    detector = new BarcodeDetector({ formats: ["qr_code"] });
  } catch (error) {
    console.warn("Native QR detector unavailable; using jsQR instead:", error);
  }
}

async function decodeFrame(source, width, height) {
  if (detector) {
    try {
      const results = await detector.detect(source);
      if (results.length > 0 && results[0].rawValue) {
        return results[0].rawValue;
      }
    } catch (error) {
      console.warn("Native QR detection failed; trying jsQR:", error);
    }
  }

  if (!window.jsQR || !width || !height || !context) return null;

  try {
    const scale = Math.min(1, 720 / Math.max(width, height));
    const scaledWidth = Math.round(width * scale);
    const scaledHeight = Math.round(height * scale);

    canvas.width = scaledWidth;
    canvas.height = scaledHeight;
    context.drawImage(source, 0, 0, scaledWidth, scaledHeight);

    const image = context.getImageData(0, 0, scaledWidth, scaledHeight);
    const result = window.jsQR(image.data, scaledWidth, scaledHeight, {
      inversionAttempts: "attemptBoth"
    });

    return result ? result.data : null;
  } catch (error) {
    console.error("QR frame decoding failed:", error);
    return null;
  }
}

async function scanLoop() {
  if (!scanning) return;

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    const rawText = await decodeFrame(video, video.videoWidth, video.videoHeight);

    if (rawText && (rawText !== lastRaw || Date.now() - lastAt > 4000)) {
      lastRaw = rawText;
      lastAt = Date.now();
      await claimCode(rawText);
    }
  }

  if (scanning) {
    setTimeout(() => requestAnimationFrame(scanLoop), 150);
  }
}

async function openCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
  } catch (error) {
    if (error.name !== "OverconstrainedError" && error.name !== "NotFoundError") {
      throw error;
    }

    // Some Chromebooks and webcams do not expose a rear-facing camera.
    return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

async function startScan() {
  msg("log-msg", "");

  if (!window.isSecureContext) {
    msg("log-msg", "The camera only works on HTTPS or http://localhost. Open the deployed site using its HTTPS address.", true);
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg("log-msg", "This browser can't access a camera. Try an updated version of Chrome or Safari.", true);
    return;
  }

  if (!detector && !window.jsQR) {
    msg("log-msg", "The QR reader library didn't load. Check your internet connection and refresh the page.", true);
    return;
  }

  try {
    stream = await openCamera();
    video.srcObject = stream;
    $("scanner").hidden = false;
    $("scan-start").hidden = true;
    $("scan-stop").hidden = false;

    await video.play();

    scanning = true;
    lastRaw = "";
    lastAt = 0;
    msg("log-msg", "Scanning… hold a SmartBin QR code steady inside the square.");
    scanLoop();
  } catch (error) {
    stopScan();
    console.error("Camera start failed:", error);

    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      msg("log-msg", "Camera permission was blocked. Allow camera access in your browser's site settings, then try again.", true);
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      msg("log-msg", "No camera was found on this device.", true);
    } else if (error.name === "NotReadableError") {
      msg("log-msg", "The camera is already being used by another app. Close that app and try again.", true);
    } else {
      msg("log-msg", "Couldn't open the camera. Check camera permission and try again.", true);
    }
  }
}

function stopScan() {
  scanning = false;

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  if (video) video.srcObject = null;

  if ($("scanner")) $("scanner").hidden = true;
  if ($("scan-start")) $("scan-start").hidden = false;
  if ($("scan-stop")) $("scan-stop").hidden = true;
}

$("scan-start").onclick = startScan;
$("scan-stop").onclick = stopScan;

/* ---- Rewards ---- */
async function redeem(id) {
  const reward = REWARDS.find(item => item.id === id);
  if (!reward || !user) return;

  const userRef = doc(db, "users", user.uid);

  try {
    data = await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(userRef);
      if (!snapshot.exists()) throw new Error("Your account record is missing.");

      const account = snapshot.data();
      if (Number(account.points || 0) < reward.cost) {
        throw new Error("Not enough points yet.");
      }

      const nextAccount = {
        ...account,
        points: Number(account.points || 0) - reward.cost
      };

      transaction.update(userRef, { points: nextAccount.points });
      return nextAccount;
    });

    await addDoc(collection(db, "users", user.uid, "redemptions"), {
      rewardId: reward.id,
      email: user.email,
      reward: reward.name,
      cost: reward.cost,
      status: "pending",
      createdAt: serverTimestamp()
    });

    msg("reward-msg", "Redeemed: " + reward.name + "! We'll email your reward soon.");
    await loadHistory();
  } catch (error) {
    msg("reward-msg", error.message || "Couldn't redeem that reward.", true);
  }

  render();
}

async function loadHistory() {
  const historyQuery = query(
    collection(db, "users", user.uid, "redemptions"),
    orderBy("createdAt", "desc"),
    limit(20)
  );

  const snapshot = await getDocs(historyQuery);

  $("history").innerHTML = snapshot.empty
    ? '<li class="muted">Nothing yet.</li>'
    : snapshot.docs.map(document => {
        const reward = document.data();
        return '<li><span>' + reward.reward + '</span><span class="muted">' +
          Number(reward.cost || 0).toLocaleString() + ' pts · ' + reward.status +
          '</span></li>';
      }).join("");
}
