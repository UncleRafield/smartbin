import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, orderBy, limit, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";
import { REWARDS } from "./store.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "europe-west2");

const ensureAccount = httpsCallable(functions, "ensureAccount");
const claimBin = httpsCallable(functions, "claimBin");
const redeemRewardCall = httpsCallable(functions, "redeemReward");

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
      await createUserWithEmailAndPassword(auth, email, password);
      // The authenticated session creates its profile through ensureAccount().
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
  if (code.includes("api-key") || code.includes("invalid-api")) return "Firebase rejected the API key. Check firebase-config.js and the API key restrictions.";
  if (code.includes("configuration-not-found") || code.includes("operation-not-allowed")) return "Email/Password sign-in isn't enabled. Firebase console > Authentication > Sign-in method > Email/Password > Enable.";
  if (code.includes("unauthorized-domain")) return "This domain isn't allowed. Firebase console > Authentication > Settings > Authorized domains > add it.";
  if (code.includes("network-request-failed")) return "Couldn't reach Firebase. Check your connection.";

  return error.message || (code ? code + ": Something went wrong." : "Something went wrong.");
}

function backendMessage(error) {
  const code = error.code || "";

  if (code.includes("unauthenticated")) return "Please log in again before doing that.";
  if (code.includes("not-found")) return "That bin code isn't registered. Please ask for a valid SmartBin QR code.";
  if (code.includes("already-exists")) return "You've already claimed this bin code.";
  if (code.includes("resource-exhausted")) return error.message || "Please wait before scanning again.";
  if (code.includes("failed-precondition")) return error.message || "This action can't be completed right now.";
  if (code.includes("invalid-argument")) return error.message || "That QR code isn't a valid SmartBin code.";
  if (code.includes("permission-denied")) return "Firebase denied this action. Check that the latest backend and Firestore rules have been deployed.";
  if (code.includes("unavailable")) return "The SmartBin server is temporarily unavailable. Try again shortly.";
  if (code.includes("functions/internal") || code === "internal") {
    console.error("Firebase callable function returned INTERNAL:", {
      code: error.code,
      message: error.message,
      details: error.details
    });
    return "The SmartBin server crashed while processing this request (functions/internal). This is a backend deployment/runtime problem, not a QR-code problem. Check Firebase Console > Functions > claimBin > Logs.";
  }
  if (code.includes("functions/") && error.message) return error.message;

  return error.message || (code ? code + ": Something went wrong. Check the browser console for details." : "Something went wrong. Please try again.");
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
      await ensureAccount();
      await loadUser();
      renderRewards();
      render();
      await loadHistory();
    } catch (error) {
      console.error("Could not initialise account:", error);
      msg("log-msg", backendMessage(error), true);
    }
  } else {
    data = null;
    $("auth-form").reset();
  }
});

async function loadUser() {
  const userRef = doc(db, "users", user.uid);
  const snapshot = await getDoc(userRef);

  if (!snapshot.exists()) {
    throw new Error("Your account profile hasn't been created yet. Log out and back in.");
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

/* ---- QR claiming ----
   The server parses and validates the complete QR payload.
   Never award points in this browser file.
*/
async function claimCode(rawText) {
  if (!user) {
    stopScan();
    msg("log-msg", "Please log in before scanning a bin.", true);
    return;
  }

  try {
    const result = await claimBin({ rawText });
    await loadUser();
    stopScan();
    msg("log-msg", "+" + result.data.points + " points added. Thanks for keeping it clean! 🌍");
  } catch (error) {
    stopScan();
    console.error("Scan failed:", error);
    msg("log-msg", backendMessage(error), true);
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
      if (results.length > 0 && results[0].rawValue) return results[0].rawValue;
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

  if (scanning) setTimeout(() => requestAnimationFrame(scanLoop), 150);
}

async function openCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
  } catch (error) {
    if (error.name !== "OverconstrainedError" && error.name !== "NotFoundError") throw error;
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
  if (!user) return;

  try {
    const result = await redeemRewardCall({ rewardId: id });
    await loadUser();
    msg("reward-msg", "Redeemed: " + result.data.reward + "! We'll email your reward soon.");
    await loadHistory();
  } catch (error) {
    console.error("Redemption failed:", error);
    msg("reward-msg", backendMessage(error), true);
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
        return '<li><span>' + escapeHtml(reward.reward) + '</span><span class="muted">' +
          Number(reward.cost || 0).toLocaleString() + ' pts · ' + escapeHtml(reward.status) +
          '</span></li>';
      }).join("");
}
