/* SmartBin local edition — no Firebase or external backend.
   Accounts, points and redemption history are stored in this browser only. */
const $ = id => document.getElementById(id);
const USERS_KEY = "smartbin.users.v1";
const SESSION_KEY = "smartbin.session.v1";
const DATA_KEY_PREFIX = "smartbin.data.v1:";
const PBKDF2_ITERATIONS = 150000;
let mode = "login";
let user = null;
let account = null;
let rewards = [];
let bins = {};
let stream = null;
let scanning = false;
let detector = null;
let lastRaw = "";
let lastAt = 0;
const video = $("video");
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });

function readJSON(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
  catch { return fallback; }
}
function writeJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function userDataKey(email) { return DATA_KEY_PREFIX + email.toLowerCase(); }
function showMessage(id, message, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = id === "auth-error" ? "error" : "msg" + (isError ? " err" : "");
}
function setMode(next) {
  mode = next;
  $("tab-login").classList.toggle("active", mode === "login");
  $("tab-signup").classList.toggle("active", mode === "signup");
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  showMessage("auth-error", "");
}
$("tab-login").addEventListener("click", () => setMode("login"));
$("tab-signup").addEventListener("click", () => setMode("signup"));

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary);
}
async function passwordHash(password, saltText) {
  const salt = saltText ? Uint8Array.from(atob(saltText), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)) };
}
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("auth-error", "");
  const email = $("email").value.trim().toLowerCase();
  const password = $("password").value;
  if (!email || password.length < 6) return showMessage("auth-error", "Enter a valid email and a password of at least 6 characters.", true);
  try {
    const users = readJSON(USERS_KEY, {});
    if (mode === "signup") {
      if (users[email]) return showMessage("auth-error", "That email already has an account. Try logging in.", true);
      const credentials = await passwordHash(password);
      users[email] = credentials;
      writeJSON(USERS_KEY, users);
      writeJSON(userDataKey(email), { points: 0, lifetime: 0, items: 0, claims: {}, redemptions: [] });
    } else {
      const saved = users[email];
      if (!saved) return showMessage("auth-error", "No account found for that email. Sign up first.", true);
      const attempted = await passwordHash(password, saved.salt);
      if (!sameText(attempted.hash, saved.hash)) return showMessage("auth-error", "Incorrect email or password.", true);
    }
    user = email;
    localStorage.setItem(SESSION_KEY, email);
    $("auth-form").reset();
    showApp();
  } catch (error) {
    console.error(error);
    showMessage("auth-error", "Couldn't create or open the local account in this browser.", true);
  }
});

function getAccount() {
  return readJSON(userDataKey(user), { points: 0, lifetime: 0, items: 0, claims: {}, redemptions: [] });
}
function saveAccount() { writeJSON(userDataKey(user), account); }
function showApp() {
  $("auth-view").hidden = !!user;
  $("app-view").hidden = !user;
  if (!user) return;
  $("user-email").textContent = user;
  account = getAccount();
  renderRewards();
  render();
  renderHistory();
}
$("logout").addEventListener("click", () => {
  stopScan();
  localStorage.removeItem(SESSION_KEY);
  user = null;
  account = null;
  $("auth-view").hidden = false;
  $("app-view").hidden = true;
});

async function loadConfiguration() {
  const [rewardResponse, binResponse] = await Promise.all([
    fetch("./rewards.json", { cache: "no-store" }),
    fetch("./bins.json", { cache: "no-store" })
  ]);
  if (!rewardResponse.ok || !binResponse.ok) throw new Error("Could not load rewards.json or bins.json.");
  const rewardData = await rewardResponse.json();
  const binData = await binResponse.json();
  if (!Array.isArray(rewardData) || !binData || typeof binData !== "object") throw new Error("The rewards or bins JSON file has the wrong format.");
  rewards = rewardData;
  bins = binData;
}

function render() {
  if (!account) return;
  $("points").textContent = Number(account.points || 0).toLocaleString();
  $("items").textContent = Number(account.items || 0).toLocaleString();
  $("lifetime").textContent = Number(account.lifetime || 0).toLocaleString();
  document.querySelectorAll(".reward").forEach(el => {
    const reward = rewards.find(item => item.id === el.dataset.id);
    if (!reward) return;
    const button = el.querySelector(".btn");
    const fill = el.querySelector(".fill");
    button.disabled = Number(account.points || 0) < Number(reward.cost);
    fill.style.width = Math.min(100, Number(account.points || 0) / Number(reward.cost) * 100) + "%";
  });
}
function renderRewards() {
  $("rewards").innerHTML = rewards.map(reward => {
    const id = String(reward.id).replace(/[^a-zA-Z0-9_-]/g, "");
    const name = escapeHtml(reward.name);
    const emoji = escapeHtml(reward.emoji || "🎁");
    const description = reward.description ? '<p class="muted small">' + escapeHtml(reward.description) + '</p>' : "";
    return '<div class="reward" data-id="' + id + '"><div style="font-size:1.8rem">' + emoji + '</div><h3>' + name + '</h3>' + description + '<div class="cost">' + Number(reward.cost).toLocaleString() + ' pts</div><div class="bar"><div class="fill" style="height:100%;background:var(--g)"></div></div><button class="btn" type="button">Claim</button></div>';
  }).join("");
  document.querySelectorAll(".reward .btn").forEach(button => {
    button.addEventListener("click", () => redeem(button.closest(".reward").dataset.id));
  });
}
function renderHistory() {
  const entries = account?.redemptions || [];
  $("history").innerHTML = entries.length ? entries.slice().reverse().slice(0, 20).map(item =>
    '<li><span>' + escapeHtml(item.name) + '</span><span class="muted">' + Number(item.cost).toLocaleString() + ' pts · Claimed</span></li>'
  ).join("") : '<li class="muted">Nothing yet.</li>';
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[ch]);
}

function parseSmartBinQR(rawText) {
  let payload;
  try { payload = JSON.parse(rawText); }
  catch { throw new Error("That isn't valid JSON. Scan a SmartBin QR code."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("The QR must contain a JSON object.");
  const keys = Object.keys(payload).sort();
  if (keys.length !== 3 || keys[0] !== "app" || keys[1] !== "code" || keys[2] !== "points") {
    throw new Error('The QR must contain exactly "app", "code" and "points".');
  }
  if (payload.app !== "smartbin") throw new Error('The QR "app" value must be "smartbin".');
  if (typeof payload.code !== "string" || !/^BIN-\d{4}$/.test(payload.code)) throw new Error('The bin code must look like "BIN-0001".');
  if (!Number.isSafeInteger(payload.points) || payload.points < -99999 || payload.points > 99999) throw new Error('"points" must be a whole number from 1 to 100.');
  return payload;
}
function claimCode(rawText) {
  if (!user || !account) throw new Error("Log in before scanning a bin.");
  const payload = parseSmartBinQR(rawText);
  const registered = bins[payload.code];
  if (!registered) throw new Error("That bin code isn't in bins.json.");
  if (payload.points !== registered.points) throw new Error("QR points don't match the registered points for this bin.");
  const now = Date.now();
  const previous = Number(account.claims[payload.code] || 0);
  const cooldown = Number(registered.cooldownMinutes ?? 1440);
  if (!Number.isFinite(cooldown) || cooldown < 1) throw new Error("This bin has an invalid cooldown in bins.json.");
  const remaining = previous + cooldown * 60000 - now;
  if (remaining > 0) throw new Error("You've already scanned this bin. Try again in " + Math.ceil(remaining / 60000) + " min.");
  account.points = Number(account.points || 0) + registered.points;
  account.lifetime = Number(account.lifetime || 0) + registered.points;
  account.items = Number(account.items || 0) + 1;
  account.claims[payload.code] = now;
  saveAccount();
  render();
  return registered.points;
}
function redeem(id) {
  const reward = rewards.find(item => item.id === id);
  if (!reward) return showMessage("reward-msg", "That reward isn't available.", true);
  if (!Number.isSafeInteger(Number(reward.cost)) || Number(reward.cost) < 1) return showMessage("reward-msg", "This reward has an invalid point cost.", true);
  if (account.points < Number(reward.cost)) return showMessage("reward-msg", "You don't have enough points yet.", true);
  account.points -= Number(reward.cost);
  account.redemptions.push({ id: reward.id, name: reward.name, cost: Number(reward.cost), claimedAt: new Date().toISOString() });
  saveAccount();
  render();
  renderHistory();
  showMessage("reward-msg", "Claimed: " + reward.name + "!");
}

if ("BarcodeDetector" in window) {
  try { detector = new BarcodeDetector({ formats: ["qr_code"] }); } catch (error) { console.warn("BarcodeDetector unavailable; using jsQR.", error); }
}
async function decodeFrame(source, width, height) {
  if (detector) {
    try {
      const found = await detector.detect(source);
      if (found.length && found[0].rawValue) return found[0].rawValue;
    } catch (error) { console.warn("Native QR scan failed; trying jsQR.", error); }
  }
  if (!window.jsQR || !width || !height) return null;
  const scale = Math.min(1, 900 / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = window.jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
    return result ? result.data : null;
  } catch (error) { console.error("QR decode error:", error); return null; }
}
async function scanLoop() {
  if (!scanning) return;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    const raw = await decodeFrame(video, video.videoWidth, video.videoHeight);
    if (raw && (raw !== lastRaw || Date.now() - lastAt > 3000)) {
      lastRaw = raw; lastAt = Date.now();
      try {
        const points = claimCode(raw);
        showMessage("log-msg", "+" + points + " points added. Thanks for keeping it clean! 🌍");
      } catch (error) {
        showMessage("log-msg", error.message || "Couldn't read that QR code.", true);
      }
      stopScan();
      return;
    }
  }
  if (scanning) requestAnimationFrame(scanLoop);
}
async function startScan() {
  showMessage("log-msg", "");
  if (!window.isSecureContext) return showMessage("log-msg", "Camera access needs localhost or HTTPS. Open this site at http://localhost.", true);
  if (!navigator.mediaDevices?.getUserMedia) return showMessage("log-msg", "This browser doesn't support camera access.", true);
  if (!detector && !window.jsQR) return showMessage("log-msg", "The QR scanning library didn't load. Check your internet connection and refresh.", true);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    video.srcObject = stream;
    $("scanner").hidden = false;
    $("scan-start").hidden = true;
    $("scan-stop").hidden = false;
    await video.play();
    scanning = true; lastRaw = ""; lastAt = 0;
    showMessage("log-msg", "Scanning… hold a SmartBin QR code inside the square.");
    scanLoop();
  } catch (error) {
    stopScan();
    console.error("Camera start failed:", error);
    showMessage("log-msg", error.name === "NotAllowedError" ? "Camera permission was blocked. Allow camera access for localhost." : "Couldn't open the camera. Check camera permission.", true);
  }
}
function stopScan() {
  scanning = false;
  if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
  if (video) video.srcObject = null;
  if ($("scanner")) $("scanner").hidden = true;
  if ($("scan-start")) $("scan-start").hidden = false;
  if ($("scan-stop")) $("scan-stop").hidden = true;
}
$("scan-start").addEventListener("click", startScan);
$("scan-stop").addEventListener("click", stopScan);
window.addEventListener("pagehide", stopScan);

(async function init() {
  try {
    await loadConfiguration();
    const savedSession = localStorage.getItem(SESSION_KEY);
    if (savedSession && readJSON(USERS_KEY, {})[savedSession]) {
      user = savedSession;
      showApp();
    } else {
      localStorage.removeItem(SESSION_KEY);
      $("auth-view").hidden = false;
      $("app-view").hidden = true;
    }
  } catch (error) {
    console.error(error);
    showMessage("auth-error", "SmartBin couldn't load rewards.json or bins.json. Check that both files are in the project folder.", true);
  }
})();
