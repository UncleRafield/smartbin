# SmartBin

SmartBin is a recycling rewards demo. The existing frontend is served from the repository root; the backend runs on Firebase Cloud Functions.

## Firebase services
- Authentication: Email/password sign-in.
- Cloud Firestore: user balances, registered bin codes and redemption history.
- Cloud Functions (Node.js 20, region `europe-west2`): account setup, QR claims and reward redemption.

## QR format
Every QR must contain exactly this JSON object (no extra fields):
`{"app":"smartbin","code":"BIN-0001","points":10}`

The server checks the exact format and compares the QR points with the registered Firestore code document. The browser never chooses the points awarded.

## Register your bins
In Firebase Console → Firestore Database → Data, create a collection named `codes`.
For each bin, use the bin code as the document ID. Example document:

- Collection: `codes`
- Document ID: `BIN-0001`
- Fields:
  - `points` — number, e.g. `10`
  - `cooldownMinutes` — number, e.g. `1` (minimum 1; use 1440 for once per day)

The QR for that document must be:
`{"app":"smartbin","code":"BIN-0001","points":10}`

The other original examples are:
- `BIN-0002`: `points: 15`, `cooldownMinutes: 30`
- `BIN-0003`: `points: 25`, `cooldownMinutes: 1440`

Do not put points in a QR unless the matching `codes` document exists. The server uses the Firestore document as the source of truth.

## Deploy the backend and rules
1. Install the Firebase CLI on a computer with Node.js 20 or newer.
2. From this repository folder, run `firebase login`.
3. Confirm the selected Firebase project is `smartbin-login` (the project ID in `firebase-config.js`). If needed run `firebase use --add` and select that project.
4. Run `firebase deploy --only functions,firestore:rules`.
5. Cloud Functions deployment may require the Firebase project to be on the Blaze (pay-as-you-go) plan and billing enabled. Check Firebase's current pricing and set budget alerts before enabling billing.

If your current site is hosted on GitHub Pages, the frontend changes publish from GitHub automatically. The functions and Firestore rules do not: they must be deployed to Firebase separately.

## Rewards
Reward IDs and prices are defined in both `store.js` (display only) and the trusted reward allowlist in `functions/index.js` (authoritative). If you change a reward, update both and redeploy the functions. Redemptions are stored as `pending`; an administrator fulfils them manually.

## Security notes
Firestore rules allow users to read only their own account and redemption history. All writes to balances, claims and redemptions are blocked from the browser and handled by Cloud Functions using the Admin SDK. A QR sticker can still be photographed and shared; the per-user cooldown limits repeat claims but cannot prove that someone physically recycled an item.
