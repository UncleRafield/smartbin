

Users scan it in the app (camera needs https, which Firebase Hosting gives you) or upload a photo of it.

For every code you print, create a Firestore document in the **codes** collection:
- Document ID: the code, e.g. `BIN-0001`
- Field `points` (number): must equal the points in the QR
- Field `daily` (boolean): `true` = each user can scan it once per UTC day, `false` = once ever

The points in the QR must match the document, and the rules only allow a user's points to rise by exactly the value of a
code claimed in that same write, so edited or invented QR codes are rejected. Without `daily: true`, one scan per user per
code ever. Anyone can still photograph a printed QR and share it, so use `daily: true` for permanent bin stickers and
single-use codes (new id each time) for anything valuable.

## Tuning
Edit `REWARDS` at the top of `app.js` (the £5 card is 3,000 points).

## Important
Redemptions are saved as "pending" in Firestore. You fulfil them yourself after checking.
