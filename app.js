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
  const rewardResponse = await fetch("./rewards.json", { cache: "no-store" });
  if (!rewardResponse.ok) throw new Error("Could not load rewards.json.");
  const rewardData = await rewardResponse.json();
  if (!Array.isArray(rewardData)) throw new Error("The rewards JSON file has the wrong format.");
  rewards = rewardData;
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

function claimCode(rawText) {
  if (!user || !account) throw new Error("Log in before entering a bin code.");
  const code = String(rawText).trim();
  if (!/^\\d{5}$/.test(code)) throw new Error("Enter a 5-digit code, for example 01030.");
  const binNumber = Number(code.slice(0, 2));
  const points = Number(code.slice(2, 5));
  if (binNumber < 1 || binNumber > 99) throw new Error("The bin number must be between 01 and 99.");
  if (points < 1 || points > 999) throw new Error("The points amount must be between 001 and 999.");
  account.points = Number(account.points || 0) + points;
  account.lifetime = Number(account.lifetime || 0) + points;
  account.items = Number(account.items || 0) + 1;
  saveAccount();
  render();
  return { binNumber, points };
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

$("code-form").addEventListener("submit", event => {
  event.preventDefault();
  showMessage("log-msg", "");
  try {
    const result = claimCode($("bin-code").value);
    showMessage("log-msg", "Bin " + String(result.binNumber).padStart(2, "0") + " accepted: +" + result.points + " points. 🌍");
    $("code-form").reset();
    $("bin-code").focus();
  } catch (error) {
    showMessage("log-msg", error.message || "That code couldn't be accepted.", true);
  }
});

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
    showMessage("auth-error", "SmartBin couldn't load rewards.json. Check that the file is in the project folder.", true);
  }
})();
