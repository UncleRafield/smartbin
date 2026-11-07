# SmartBin — local edition

SmartBin runs without Firebase. The existing frontend HTML and CSS design are retained.

## Run locally

You need Python 3 (available in many Chromebook Linux environments).

1. Open Terminal and enter the project folder: `cd smartbin`
2. Start the local web server: `python3 -m http.server 8000`
3. Open `http://localhost:8000` in Chrome.

Keep the Terminal window open while using the site. Press Ctrl+C to stop the server. Camera scanning requires localhost or HTTPS; do not open index.html as a file.

## Accounts and data

- Sign-up and login are local to this browser profile.
- Passwords are salted and hashed with PBKDF2 before being stored.
- Points, scan cooldowns and redemption history are stored in localStorage.
- Data does not sync between devices or browsers and can be cleared by clearing browser site data.
- This local-only setup is a prototype, not secure production account storage. A user with control of the browser can alter local data.

## Configure bins: bins.json

Each key is a bin code. Its points must match the QR code's points value.

```json
{
  "BIN-0001": { "points": 10, "cooldownMinutes": 1 }
}
```

QR payloads must be JSON objects with exactly these three keys and no extras:

```json
{"app":"smartbin","code":"BIN-0001","points":10}
```

## Configure rewards: rewards.json

Add or edit objects in the array. Each reward needs a unique `id`, a `name`, an `emoji`, and a positive numeric `cost`. `description` is optional.

```json
[
  {
    "id": "coffee",
    "name": "Free coffee",
    "emoji": "☕",
    "description": "A sample deal",
    "cost": 500
  }
]
```

The Claim button deducts the points and adds the reward to local redemption history. It does not contact a real retailer or issue a voucher automatically.
