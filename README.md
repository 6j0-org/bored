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
extension (current Chrome/Edge, Safari on macOS/iOS 18+, Firefox, Bitwarden). Signup is blocked otherwise.

Env vars: `PORT` (default 3000), `DB_PATH` (default `./data.sqlite`), `ORIGIN` (e.g. `https://bored.example`; required
behind HTTPS/proxies, passkeys are bound to it; also turns on `Secure` cookies), `RP_ID` (passkey domain; defaults to
the `ORIGIN` hostname).

This is a prototype, so there are no database migrations. After a schema change, stop the server, delete `data.sqlite*`, and run `npm run seed` again.

## How it works

| Step | Who | Where |
|---|---|---|
| Post an event (title, details, up to 5 tags, where/when, cost, max attendees or no limit, or open to everyone) | Host | **Post** |
| Swipe right on events you're in for (filter by tags and/or cost) | Attendee | **Discover** |
| Swipe right on people who want to join | Host | **Confirm** |
| Match → chat to sort out details | Both | **Plans** |
| "It happened" to close it out | Host | Plan chat |

A post stays in the deck until it reaches its max attendees. Posts with no limit stay open until the host removes them. Events that are **open to everyone** (public, or ticketed elsewhere) never have a cap.

## Privacy model

- **Accounts** are a server-assigned GUID plus one or more passkeys. The server stores each passkey's public key,
  never a name, email or password. Lose every passkey and the account is gone: the app nudges people to keep their
  passkey in a password manager like Bitwarden or to add a second device (Profile → Passkeys).
- **Names are private.** You see only the nicknames *you* gave people, and only once you've matched with them;
  everyone else is "A neighbor". Your nickname for yourself is also visible only to you.
- **The vault** (your nickname, plus nickname + tags for each contact) is encrypted in the browser with a random
  vault key. That key is wrapped by a key derived from each passkey's PRF output, so the server only stores ciphertext.
- **Chat is end-to-end encrypted** (ECDH P-256 → HKDF per match → AES-GCM). Your chat private key is stored
  encrypted under the vault key, so any of your passkeys can read your chats on a new device. Prototype caveat:
  static keys, so no forward secrecy.
- **What the server still knows:** which GUIDs swiped on, matched and messaged which other GUIDs, and when;
  post contents (public); IP addresses. See `TODO.md` for the full list of open security and privacy issues. Match records are kept for now.
- `public/secure.js` holds all client-side crypto; `webauthn.js` verifies passkeys on the server with `node:crypto` only.
- Pages are served with a strict Content-Security-Policy (same-origin scripts only) to keep injected code away from keys.

## Files

- `server.js`: HTTP server + JSON API (routing, passkey auth, matching logic)
- `webauthn.js`: passkey registration/sign-in verification (no dependencies)
- `db.js`: SQLite schema, tag helpers
- `public/app.js`: single-page front-end (vanilla JS, swipe deck with pointer/touch/keyboard)
- `public/secure.js`: passkeys + PRF, encrypted vault, key storage, E2E chat crypto
- `public/fonts/`: bundled Bungee title font (SIL OFL 1.1, license alongside). The app loads nothing from outside its own server.
- `seed.js`: demo data
- `TODO.md`: open security and privacy issues, by priority
