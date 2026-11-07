import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, runTransaction, addDoc, collection, query, orderBy, limit, getDocs, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { REWARDS, BINS } from "./store.js";

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("auth-error").textContent = "firebase-config.js still has placeholder values. Paste your real config and save the file.";
  });
}
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---- Settings ---- */
const $ = id => document.getElementById(id);
let mode = "login", user = null, data = null;

/* ---- Auth UI ---- */
function setMode(m) {
  mode = m;
  $("tab-login").classList.toggle("active", m === "login");
  $("tab-signup").classList.toggle("active", m === "signup");
  $("auth-submit").textContent = m === "login" ? "Log in" : "Create account";
  $("password").autocomplete = m === "login" ? "current-password" : "new-password";
  $("auth-error").textContent = "";
}
$("tab-login").onclick = () => setMode("login");
$("tab-signup").onclick = () => setMode("signup");

$("auth-form").addEventListener("submit", async e => {
  e.preventDefault();
  $("auth-error").textContent = "";
  const email = $("email").value.trim(), pw = $("password").value;
  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      await setDoc(doc(db, "users", cred.user.uid), {
        email, points: 0, lifetime: 0, items: 0, lastClaimId: "",
        createdAt: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
    }
  } catch (err) {
    $("auth-error").textContent = friendly(err);
  }
});
$("logout").onclick = () => signOut(auth);

function friendly(err) {
  const c = err.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Incorrect email or password.";
  if (c.includes("email-already-in-use")) return "That email already has an account – try logging in.";
  if (c.includes("weak-password")) return "Password must be at least 6 characters.";
  if (c.includes("invalid-email")) return "Please enter a valid email.";
  if (c.includes("too-many-requests")) return "Too many attempts. Try again later.";
  if (c.includes("api-key") || c.includes("invalid-api")) return "Firebase rejected the API key (" + c + "). Re-copy apiKey from Project settings > Your apps, and check its restrictions in Google Cloud > Credentials.";
  if (c.includes("configuration-not-found") || c.includes("operation-not-allowed")) return "Email/Password sign-in isn't enabled. Firebase console > Authentication > Sign-in method > Email/Password > Enable.";
  if (c.includes("unauthorized-domain")) return "This domain isn't allowed. Firebase console > Authentication > Settings > Authorized domains > add it.";
  if (c.includes("network-request-failed")) return "Couldn't reach Firebase. Check your connection.";
  return (c ? c + ": " : "") + (err.message || "Something went wrong.");
}

/* ---- Session ---- */
onAuthStateChanged(auth, async u => {
  stopScan();
  user = u;
  $("auth-view").hidden = !!u;
  $("app-view").hidden = !u;
  if (u) {
    $("user-email").textContent = u.email;
    await loadUser();
    renderRewards(); render(); loadHistory();
  } else {
    $("auth-form").reset();
  }
});

async function loadUser() {
  const ref = doc(db, "users", user.uid);
  let snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { email: user.email, points: 0, lifetime: 0, items: 0, lastClaimId: "" });
    snap = await getDoc(ref);
  }
  data = snap.data();
}

/* ---- Render ---- */
function render() {
  $("points").textContent = data.points.toLocaleString();
  $("items").textContent = data.items.toLocaleString();
  $("lifetime").textContent = data.lifetime.toLocaleString();
  document.querySelectorAll(".reward").forEach(r => {
    const rw = REWARDS.find(x => x.id === r.dataset.id);
    r.querySelector(".btn").disabled = data.points < rw.cost;
    r.querySelector(".fill").style.width = Math.min(100, data.points / rw.cost * 100) + "%";
  });
}

function renderRewards() {
  $("rewards").innerHTML = REWARDS.map(r =>
    `<div class="reward" data-id="${r.id}"><div style="font-size:1.8rem">${r.emoji}</div><h3>${r.name}</h3>
     <div class="cost">${r.cost.toLocaleString()} pts</div>
     <div class="bar"><div class="fill" style="height:100%;background:var(--g)"></div></div>
     <button class="btn" type="button">Redeem</button></div>`).join("");
  document.querySelectorAll(".reward").forEach(el => el.querySelector(".btn").onclick = () => redeem(el.dataset.id));
}

function msg(id, text, err) { const el = $(id); el.textContent = text; el.className = "msg" + (err ? " err" : ""); }

/* ---- Actions ---- */
/* ---- QR codes ----
   A SmartBin QR code contains JSON like:  {"app":"smartbin","code":"BIN-0001","points":10}
   The bin must be listed in store.js. Points awarded always come from store.js. */
async function claimCode(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return msg("log-msg", "That QR code isn't a SmartBin code.", true); }
  if (!p || p.app !== "smartbin" || typeof p.code !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.code))
    return msg("log-msg", "That QR code isn't a SmartBin code.", true);
  const bin = BINS[p.code];
  if (!bin) return msg("log-msg", `Bin "${p.code}" isn't listed in store.js. Add it there and redeploy.`, true);
  const pts = Math.min(100, Math.floor(Number(bin.points)));
  if (!(pts > 0)) return msg("log-msg", `Bin "${p.code}" has no valid points value in store.js.`, true);
  const cooldownMin = Math.max(1, Number(bin.cooldownMinutes) || 1);
  const userRef = doc(db, "users", user.uid);
  const claimRef = doc(db, "users", user.uid, "claims", p.code);
  try {
    data = await runTransaction(db, async tx => {
      const prev = await tx.get(claimRef);
      const us = await tx.get(userRef);
      if (!us.exists()) throw new Error("Your account record is missing. Log out and back in.");
      if (prev.exists() && prev.data().at) {
        const waitMs = prev.data().at.toMillis() + cooldownMin * 60000 - Date.now();
        if (waitMs > 0) throw new Error(`You've scanned this bin recently. Try again in ${waitMs > 3600000 ? Math.ceil(waitMs / 3600000) + " h" : Math.ceil(waitMs / 60000) + " min"}.`);
      }
      const d = us.data();
      tx.set(claimRef, { code: p.code, points: pts, at: serverTimestamp() });
      const next = { ...d, points: (d.points || 0) + pts, lifetime: (d.lifetime || 0) + pts, items: (d.items || 0) + 1, lastClaimId: p.code };
      tx.update(userRef, next);
      return next;
    });
    stopScan();
    msg("log-msg", `+${pts} points added. Thanks for keeping it clean! 🌍`);
  } catch (e) {
    stopScan();
    console.error("Scan failed:", e);
    msg("log-msg", e.code === "permission-denied" ? "Firestore refused the update (permission-denied). Publish the latest firestore.rules in Firebase, then try again." : ((e.code ? e.code + ": " : "") + (e.message || "Something went wrong.")), true);
  }
  render();
}

/* ---- Scanner ---- */
let stream = null, scanning = false, lastRaw = "", lastAt = 0;
const video = $("video"), canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;

async function decodeFrame(source, w, h) {
  if (detector) { try { const r = await detector.detect(source); if (r[0]) return r[0].rawValue; } catch {} }
  if (window.jsQR && w && h) {
    const s = Math.min(1, 720 / Math.max(w, h)), cw = Math.round(w * s), ch = Math.round(h * s);
    canvas.width = cw; canvas.height = ch; ctx.drawImage(source, 0, 0, cw, ch);
    const q = jsQR(ctx.getImageData(0, 0, cw, ch).data, cw, ch, { inversionAttempts: "attemptBoth" });
    return q ? q.data : null;
  }
  return null;
}
async function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    const raw = await decodeFrame(video, video.videoWidth, video.videoHeight);
    if (raw && (raw !== lastRaw || Date.now() - lastAt > 4000)) { lastRaw = raw; lastAt = Date.now(); await claimCode(raw); }
  }
  setTimeout(() => requestAnimationFrame(loop), 150);
}
async function startScan() {
  msg("log-msg", "");
  if (!window.isSecureContext) return msg("log-msg", "The camera only works on https or http://localhost. Open the site from your Firebase address (https://...web.app) or localhost, not as a file.", true);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return msg("log-msg", "This browser can't open the camera. Try Chrome or Safari.", true);
  if (!detector && !window.jsQR) return msg("log-msg", "The QR reader library didn't load. Check your internet connection and refresh.", true);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream; await video.play();
    scanning = true; $("scanner").hidden = false; $("scan-start").hidden = true; $("scan-stop").hidden = false; msg("log-msg", "Scanning… hold the QR code steady inside the square."); loop();
  } catch (e) { msg("log-msg", (e && e.name === "NotAllowedError" ? "Camera permission was blocked. Allow it in your browser's site settings, then try again. " : "") + "Couldn't open the camera. Allow camera access (it needs https or localhost) and try again.", true); }
}
function stopScan() {
  scanning = false; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
  $("scanner").hidden = true; $("scan-start").hidden = false; $("scan-stop").hidden = true;
}
$("scan-start").onclick = startScan;
$("scan-stop").onclick = stopScan;

async function redeem(id) {
  const rw = REWARDS.find(r => r.id === id);
  const ref = doc(db, "users", user.uid);
  try {
    data = await runTransaction(db, async tx => {
      const d = (await tx.get(ref)).data();
      if (d.points < rw.cost) throw new Error("Not enough points yet.");
      const next = { ...d, points: d.points - rw.cost };
      tx.update(ref, next);
      return next;
    });
    await addDoc(collection(db, "users", user.uid, "redemptions"),
      { rewardId: rw.id, email: user.email, reward: rw.name, cost: rw.cost, status: "pending", createdAt: serverTimestamp() });
    msg("reward-msg", `Redeemed: ${rw.name}! We'll email your reward soon.`);
    loadHistory();
  } catch (e) { msg("reward-msg", e.message, true); }
  render();
}

async function loadHistory() {
  const q = query(collection(db, "users", user.uid, "redemptions"), orderBy("createdAt", "desc"), limit(20));
  const snap = await getDocs(q);
  $("history").innerHTML = snap.empty ? `<li class="muted">Nothing yet.</li>` :
    snap.docs.map(d => { const r = d.data();
      return `<li><span>${r.reward}</span><span class="muted">${r.cost.toLocaleString()} pts · ${r.status}</span></li>`; }).join("");
}
