// ONE FILE TO EDIT: everything about the store lives here.
// After changing it, save, then re-upload / redeploy the site (firebase deploy).

// ---- REWARDS: what people can spend points on ----
//   id: short unique name, no spaces   name: shown to users   emoji: icon   cost: points needed
export const REWARDS = [
  { id: "bottle", name: "Reusable bottle", emoji: "🥤", cost: 2000 },
  { id: "gc5",    name: "£5 gift card",    emoji: "🎁", cost: 3000 },
  { id: "gc10",   name: "£10 gift card",   emoji: "💷", cost: 6500 },
  { id: "gc25",   name: "£25 gift card",   emoji: "💳", cost: 17000 },
  { id: "tree",   name: "Plant a tree",    emoji: "🌳", cost: 25000 },
];

// ---- BINS: the QR codes that give points ----
// Each QR code contains:  {"app":"smartbin","code":"BIN-0001","points":10}
// The "code" in the QR must match a line below. The points given always come from this file.
//   points:          points given per scan (max 100)
//   cooldownMinutes: how long before the same person can scan this bin again (minimum 1;
//                    1 = once a minute, 60 = hourly, 1440 = daily). Everyone can use a bin again and again.
export const BINS = {
  "BIN-0001": { points: 10, cooldownMinutes: 1 },
  "BIN-0002": { points: 15, cooldownMinutes: 30 },
  "BIN-0003": { points: 25, cooldownMinutes: 1440 },
};
