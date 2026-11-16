# Bored?

A local event board that works like a dating app.
Host an event. Neighbors swipe through posts in **Discover**, and **right = "I'm in"**.
In **Confirm**, the host swipes through the people who want to join, and **right = "Let's do it"**. When both sides say yes, it's on:
it shows up in **Plans**, where you chat and sort out details. Afterwards the host marks it as happened.

Accounts are anonymous: a random GUID and a passkey. No usernames, passwords or email. Anyone can browse **Discover** without an account.

## Run

Needs Node ≥ 24 (uses the built-in `node:sqlite`). No dependencies.

```sh
npm run seed   # optional: demo posts from demo accounts (they have no passkeys, so nobody can sign in as them)
npm start      # http://localhost:3000
```

To try matching and chat, create two accounts in two different browsers or browser profiles. Passkeys need a
**secure context** (`http://localhost` counts) and a browser + passkey manager that supports the WebAuthn **PRF**
extension: e.g. a security key (YubiKey 5 etc.), Google Password Manager (Chrome, Android) or iCloud Keychain
(Safari on macOS/iOS 18+). Some password managers, including Bitwarden, don't support PRF yet. Signup is blocked
otherwise.

Env vars: `PORT` (default 3000), `DB_PATH` (default `./data.sqlite`), `ORIGIN` (e.g. `https://bored.example`; required
behind HTTPS/proxies, passkeys are bound to it; also turns on `Secure` cookies), `RP_ID` (passkey domain; defaults to
the `ORIGIN` hostname).

### Sign-in: standalone or with a 6j0.org identity

`AUTH_MODE` picks who signs people in:

- `local` (default): Bored? runs its own passkeys, as described below. Works on its own.
- `6j0`: people sign in with an anonymous identity from a [6j0.org identity server](https://gitlab.com/6j0-org/id),
  so one sign-in (passkey, or username + password) covers every 6j0.org app. Set `ID_ORIGIN` (e.g. `https://id.6j0.org`). Optional: `ID_APP` (this
  app's name in the identity server's `APPS`; default `bored`) and `ID_JWKS_URL` (where to fetch its public keys;
  default `ID_ORIGIN/.well-known/jwks.json`). The local passkey endpoints are switched off.

The two modes keep separate accounts, so pick one before people sign up. Switching later strands existing users.

To try `6j0` mode locally, run the identity server on `localhost` and Bored? on `127.0.0.1` (cookies ignore the
port, so two apps on one hostname would overwrite each other's session cookie):

```sh
# in the id repo
APPS=bored=http://127.0.0.1:3000 ORIGIN=http://localhost:4000 npm start
# here
AUTH_MODE=6j0 ID_ORIGIN=http://localhost:4000 ORIGIN=http://127.0.0.1:3000 npm start   # open http://127.0.0.1:3000
```

This is a prototype, so there are no database migrations. After a schema change, stop the server, delete `data.sqlite*`, and run `npm run seed` again.

## How it works

| Step | Who | Where |
|---|---|---|
| Post an event (title, details, up to 5 tags, where (map pin), when (date, time, optional repeat), cost and currency, max attendees or no limit, public or shared with chosen contacts/groups) | Host | **Post** |
| Swipe right on events you're in for (filter by tags and/or free/paid) | Attendee | **Discover** |
| Swipe right on people who want to join | Host | **Confirm** |
| Match → chat to sort out details | Both | **Plans** |
| "It happened" to close it out | Host | Plan chat |

A post stays in the deck until it reaches its max attendees. Posts with no limit stay open until the host removes them. Posts are **private** by default: only the contacts and groups (contact tags) the host picks can see them. **Public** posts show for everyone, including signed-out guests.

## Privacy model

- **Accounts** are a server-assigned GUID plus one or more passkeys. The server stores each passkey's public key,
  never a name, email or password. Lose every passkey and the account is gone: the app nudges people to keep their
  add a second passkey (another device or a security key) (Profile → Passkeys).
- **Names are private.** You see only the nicknames *you* gave people, and only once you've matched with them;
  everyone else is "A neighbor".
- **The vault** (nickname + tags for each contact, and who each of your private posts is shared with) is encrypted in the browser with a random
  vault key. That key is wrapped by a key derived from each passkey's PRF output, so the server only stores ciphertext.
- **With a 6j0.org identity** (`AUTH_MODE=6j0`) the passkeys (and the optional password) live on the identity server instead. After sign-in it
  sends the browser back with a signed token and Bored?'s own *app key*, encrypted to a one-time key the page made
  and carried in the URL fragment (which never reaches a server). The vault key is wrapped by a key derived from the
  app key. Other 6j0.org apps get different app keys, so they can't read Bored? data, and Bored? gives the account
  its own public GUID, so people can't link your Bored? account to your accounts in other apps.
- **Chat is end-to-end encrypted** (ECDH P-256 → HKDF per match → AES-GCM). Your chat private key is stored
  encrypted under the vault key, so any of your passkeys can read your chats on a new device. Prototype caveat:
  static keys, so no forward secrecy.
- **What the server still knows:** which GUIDs swiped on, matched and messaged which other GUIDs, and when;
  post contents; who each private post is shared with (the browser expands your picked contacts and groups into
  GUIDs, and re-sends them when your groups change); IP addresses. See `TODO.md` for the full list of open security and privacy issues. Match records are kept for now.
- `public/secure.js` holds all client-side crypto; `webauthn.js` verifies passkeys on the server with `node:crypto` only.
- Pages are served with a strict Content-Security-Policy (same-origin scripts only) to keep injected code away from keys.

## Files

- `server.js`: HTTP server + JSON API (routing, passkey auth, matching logic)
- `webauthn.js`: passkey registration/sign-in verification (no dependencies)
- `idtoken.js`: verifies sign-in tokens from a 6j0.org identity server (`AUTH_MODE=6j0`)
- `db.js`: SQLite schema, tag helpers
- `public/app.js`: single-page front-end (vanilla JS, swipe deck with pointer/touch/keyboard)
- `public/secure.js`: passkeys + PRF, 6j0.org identity handoff, encrypted vault, key storage, E2E chat crypto
- `public/location.js`: "lat,lon" locations, links to the viewer's maps app, and a small OpenStreetMap pin picker
- `public/when.js`, `public/cost.js`: event time (with repeat rules) and cost formats, shared by server and browser
- `public/fonts/`: bundled Bungee title font (SIL OFL 1.1, license alongside). The app loads nothing from outside its own server, except OpenStreetMap tiles while the location picker is open.
- `seed.js`: demo data
- `TODO.md`: open security and privacy issues, by priority
