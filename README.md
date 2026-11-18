# Bored?

A local event board that works like a dating app.
Host an event. Neighbors swipe through posts in **Discover**, and **right = "I'm in"**.
In **Confirm**, the host swipes through the people who want to join, and **right = "Let's do it"**. When both sides say yes, it's on:
it shows up in **Plans**, where you chat and sort out details. Afterwards the host marks it as happened.

Accounts are anonymous: a random GUID and a passkey. No usernames, passwords, or email. Anyone can browse **Discover** without an account.

## Run

Needs Node ≥ 24 (uses the built-in `node:sqlite`). npm packages are only for the browser (see `VENDOR` in
`server.js`); they're installed once, then served from this server, so the running app never needs npm or a CDN.

```sh
npm ci         # install the exact versions in package-lock.json
npm run seed   # optional: demo posts from demo accounts (they have no passkeys, so nobody can sign in as them)
npm start      # http://localhost:3000
```

### Demo mode

`DEMO=1 npm start` runs a throwaway demo with no sign-in. Each browser automatically gets its own account,
already filled in: demo posts in **Discover**, two requests to join a hike in **Confirm**, two plans with chats in
**Plans**, and a past event in **Profile**. Demo hosts say yes as soon as you swipe right on their posts. "Start
over" in Profile gives a fresh account. No passkey or PRF support is needed.

Everything is kept in memory (`DB_PATH` and `AUTH_MODE` are ignored), so it all resets when the server stops, and
visitor accounts are deleted after a day. It's for trying the app out and showing it to people, never for real use.

On a first visit, `/` shows the introduction page (`public/about.html`). Its links go to `/?start`, which sets a
`seen=1` cookie (no ID, nothing about the person) and redirects to the app at `/`. Browsers with that cookie or a
session always get the app. Links with a URL fragment (invitations, sign-in tokens from a 6j0.org identity server)
are forwarded by `public/landing.js` the same way, since the server never sees fragments. The introduction stays at
`/about` for everyone.

To try matching and chat, create two accounts in two different browsers or browser profiles. Passkeys need a
**secure context** (`http://localhost` counts) and a browser + passkey manager that supports the WebAuthn **PRF**
extension: e.g. a security key (YubiKey 5 etc.), Google Password Manager (Chrome, Android) or iCloud Keychain
(Safari on macOS/iOS 18+). Some password managers, including Bitwarden, don't support PRF yet. Signup is blocked
otherwise.

Env vars: `PORT` (default 3000), `DB_PATH` (default `./data.sqlite`), `ORIGIN` (e.g. `https://bored.example`; required
behind HTTPS/proxies, passkeys are bound to it; also turns on `Secure` cookies), `RP_ID` (passkey domain; defaults to
the `ORIGIN` hostname), `VAPID_SUBJECT` (a `mailto:` or `https:` contact for push services; defaults to `ORIGIN`),
`PUSH_HOSTS` (extra push service hostnames to allow, comma-separated), `DEMO` (`1` for [demo mode](#demo-mode)).

### Notifications

Web Push, opt-in per device from Profile: Chrome on Android, and desktop Chrome, Edge, Firefox, and Safari. On iPhone
and iPad (iOS 16.4+) only after adding the app to the Home Screen. `push.js` encrypts each notification for the device
(RFC 8291) and signs requests with this server's VAPID key (RFC 8292, generated on first use and kept in the
database), using `node:crypto` only. Push needs HTTPS (or `localhost`).

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

**Database migrations** run automatically on startup (`MIGRATIONS` in `db.js`). The `CREATE TABLE`s are the schema
as it was at launch; every change since is a numbered migration, tracked in SQLite's `PRAGMA user_version`. To change
the schema, append a migration (never edit or reorder old ones). Back up `data.sqlite*` before deploying one.

## How it works

| Step | Who | Where |
|---|---|---|
| Post an event (title, details, up to 5 tags, where (map pin), when (date, time, optional repeat), cost and currency, max attendees or no limit, public or shared with chosen contacts/groups) | Host | **Post** |
| Swipe right on events you're in for (filter by tags and/or free/paid) | Attendee | **Discover** |
| Swipe right on people who want to join | Host | **Confirm** |
| Match → chat to sort out details | Both | **Plans** |
| "It happened" to close it out | Host | Plan chat |

A post stays in the deck until it reaches its max attendees. Posts with no limit stay open until the host removes them. Posts are **private** by default: only the contacts and groups (contact tags) the host picks can see them. Private posts need contacts, so until someone has matched or connected with at least one person, their posts are public (the server enforces this). **Public** posts show for everyone, including signed-out guests.

## Privacy model

- **Accounts** are a server-assigned GUID plus one or more passkeys. The server stores each passkey's public key,
  never a name, email, or password. Lose every passkey and the account is gone: the app nudges people to keep their
  add a second passkey (another device or a security key) (Profile → Passkeys).
- **Names are private.** You see only the nicknames *you* gave people, and only once you've matched with them;
  everyone else has no name.
- **GUIDs are only shared with matches.** The API sends someone's GUID only to people they've matched with, so
  strangers can't link one person's posts or requests together. Everyone's avatar is the [Jdenticon](https://jdenticon.com) of
  their GUID (the `jdenticon` npm package, served by this server). For people you haven't matched with, the server sends the SHA-1 of
  the GUID instead, which draws the same icon but doesn't reveal the GUID. The icon does follow a person across
  their posts.
- **The vault** (nickname + tags for each contact, and who each of your private posts is shared with) is encrypted in the browser with a random
  vault key. That key is wrapped by a key derived from each passkey's PRF output, so the server only stores ciphertext.
- **With a 6j0.org identity** (`AUTH_MODE=6j0`) the passkeys (and the optional password) live on the identity server instead. After sign-in it
  sends the browser back with a signed token and Bored?'s own *app key*, encrypted to a one-time key the page made
  and carried in the URL fragment (which never reaches a server). The vault key is wrapped by a key derived from the
  app key. Other 6j0.org apps get different app keys, so they can't read Bored? data, and Bored? gives the account
  its own public GUID, so people can't link your Bored? account to your accounts in other apps.
- **Invitations to connect** are links (`/#invite=<token>`). The token stays in the URL fragment, so it isn't sent
  in requests or logged; the server stores only its SHA-256, and the owner's encrypted vault keeps the link to share
  again. Connecting makes two people contacts, the same as matching (the server records the pair in `connections`).
- **Notifications** go through the browser vendor's push service (Google, Mozilla, Apple, or Microsoft). They're
  encrypted for the device, so the service can't read them, but it does see when they're sent and to which device.
  The text stays generic ("New message about “Picnic”"): no names, and never message contents.
- **Your location for the distance filter** stays in your browser (`localStorage`). Discover sends the server only a
  rough spot, rounded to 2 decimals (about a kilometre), and only while a distance is picked.
- **Chat is end-to-end encrypted** (ECDH P-256 → HKDF per match → AES-GCM). Your chat private key is stored
  encrypted under the vault key, so any of your passkeys can read your chats on a new device. Prototype caveat:
  static keys, so no forward secrecy.
- **What the server still knows:** which GUIDs swiped on, matched, and messaged which other GUIDs, and when;
  post contents; who each private post is shared with (the browser expands your picked contacts and groups into
  GUIDs, and re-sends them when your groups change); IP addresses. See `TODO.md` for the full list of open security and privacy issues. Match records are kept for now.
- `public/secure.js` holds all client-side crypto; `webauthn.js` verifies passkeys on the server with `node:crypto` only.
- Pages are served with a strict Content-Security-Policy (same-origin scripts only) to keep injected code away from keys.

## Files

- `server.js`: HTTP server + JSON API (routing, passkey auth, matching logic)
- `webauthn.js`: passkey registration/sign-in verification (no dependencies)
- `idtoken.js`: verifies sign-in tokens from a 6j0.org identity server (`AUTH_MODE=6j0`)
- `db.js`: SQLite schema, tag helpers
- `public/about.html`, `public/landing.js`, `public/about.js`: the introduction page, shown at `/` on a first visit, with a
  swipeable deck of example posts
- `public/examples.js`: the example posts, shared by that deck and the demo (`demo.js`)
- `public/app.js`: single-page front-end (vanilla JS, swipe deck with pointer/touch/keyboard)
- `public/secure.js`: passkeys + PRF, 6j0.org identity handoff, encrypted vault, key storage, E2E chat crypto
- `public/location.js`: "lat,lon" locations, links to the viewer's maps app, and a small OpenStreetMap pin picker
- `public/theme.js`: the automatic / light / dark theme switch, applied before the page draws
- `public/board.webp`: the wooden board behind the Bored? title
- `public/when.js`, `public/cost.js`: event time (with repeat rules) and cost formats, shared by server and browser
- `public/fonts/`: bundled National Park font, used for all text (SIL OFL 1.1, license alongside). The app loads nothing from outside its own server, except OpenStreetMap tiles while the location picker is open. Suggested place names come from OpenStreetMap's Nominatim, asked by the server (`/api/places/reverse`).
- `demo.js`: demo accounts and posts, and the ready-made account each visitor gets in demo mode (`DEMO=1`)
- `seed.js`: adds the demo accounts and posts to a real database (`npm run seed`)
- `TODO.md`: open security and privacy issues, by priority

## License

Copyright © 2026 the Bored? contributors.

Bored? is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. See [`LICENSE`](LICENSE).

The AGPL also covers running Bored? as a service: if you run a modified version for other people, you must offer them
its source. The app links to the source from the sign-in and Profile screens (`SOURCE_URL` in `public/app.js`); point
it at your own repository if you change the code.

The bundled National Park font is under the SIL Open Font License 1.1 (`public/fonts/NationalPark-OFL.txt`), and Jdenticon is MIT.
