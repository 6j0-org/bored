# Bored

A local event board that works like a dating app.
Host an event. Users swipe through posts in **Discover**, and **right = "I'm in"**.
In **Confirm**, the host swipes through the requests to join (anonymous, unless they're from one of the host's contacts), and **right = "Let's do it"**. When both sides say yes, it's on:
it shows up in **Plans**, where you chat and sort out details. Afterwards the host marks it as happened.

Accounts are anonymous: a random GUID. Depending on how the server is set up, you sign in with a passkey or with a
6j0.org identity (see [Sign-in](#sign-in-standalone-or-with-a-6j0org-identity)). Bored itself never asks for a name,
email, or password. Anyone can browse **Discover** without an account.

## Run

Needs Node ≥ 24 (uses the built-in `node:sqlite`). npm packages are only for the browser (see `VENDOR` in
`server.js`); they're installed once, then served from this server, so the running app never needs npm or a CDN.

```sh
npm ci         # install the exact versions in package-lock.json
npm start      # http://localhost:3000
```

### Tests

```sh
npm test               # all of them
npm run test:unit      # HPKE against RFC 9180's test vectors, the request rules in posts.js, and feedback.js; no server
npm run test:server    # real accounts in Node against a demo-mode server: mail, public posts, and demo seeding
npm run test:browser   # the real UI in two headless Chromium profiles: post, join, match, chat, and leave
```

The runner (`test/run.mjs`) starts its own `DEMO=1` server on a free port, so nothing touches `data.sqlite`. The
browser tests need Chrome or Chromium (set `CHROME_BIN` if it isn't found); without one they're skipped, except in CI
(`TEST_BROWSER=1`), where that's a failure. `TEST_VERBOSE=1` prints every test's output, not just the failures'.
CI runs them on every push and merge request, before building the image.

### Demo mode

`DEMO=1 npm start` runs a throwaway demo with no sign-in. Each browser automatically gets its own account,
already filled in: demo posts in **Discover**, two requests to join a hike in **Confirm**, two plans with chats in
**Plans**, and two past events in **Profile**. Demo hosts say yes as soon as you swipe right on their posts. "Start
over" in Profile gives a fresh account. No passkey or PRF support is needed.

The demo accounts have real keys, kept only in the server's memory, and a small bot in `demo.js` reads and answers
their mail with the same code the browser uses. A new visitor's browser makes its own posts (only it can sign them)
and the bot fills in the rest: requests, matches, and chats.

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
`PUSH_HOSTS` (extra push service hostnames to allow, comma-separated), `DEMO` (`1` for [demo mode](#demo-mode)),
`FEEDBACK_PATH` (default `feedback.jsonl` next to the database), `ADMIN_SUB` or `ADMIN_GUID` (who can delete anyone's
[feedback](#feedback): a 6j0.org identity's `sub` with `AUTH_MODE=6j0`, or an account's GUID in any mode).

### Feedback

The Feedback button beside the page title (on every screen once you're signed in) opens a page where people read
everyone's feedback and post their own: plain text, up to 2048 characters. Posts show no author; the server files
each one under the account's GUID so people can delete their own. Each account can post 5 times a day, and everyone
together 500 times a day. The admin (`ADMIN_SUB` or `ADMIN_GUID`) can delete anyone's posts, and theirs are labeled
"Developer". In the demo, each visitor sees only their own posts.

Feedback is shared, so it isn't encrypted, and the page says so. It's kept in a JSON Lines file (`FEEDBACK_PATH`): one
JSON object per line, appended to and never edited in place, with deletions as `{"delete": id}` lines. The server
loads it at startup and, if anything was deleted, rewrites it without the deleted posts. `feedback.js` and
`public/feedback.js` are the same files as in Glaze Journal, which has the feature too; keep them identical.

### Notifications

Web Push, opt-in per device from Profile: Chrome on Android, and desktop Chrome, Edge, Firefox, and Safari. On iPhone
and iPad (iOS 16.4+) only after adding the app to the Home Screen. `push.js` encrypts each notification for the device
(RFC 8291) and signs requests with this server's VAPID key (RFC 8292, generated on first use and kept in the
database), using `node:crypto` only. Push needs HTTPS (or `localhost`).

### Sign-in: standalone or with a 6j0.org identity

`AUTH_MODE` picks who signs people in:

- `local` (default): Bored runs its own passkeys, as described below. Works on its own.
- `6j0`: people sign in with an anonymous identity from a [6j0.org identity server](https://gitlab.com/6j0-org/id),
  so one sign-in (passkey, or username + password) covers every 6j0.org app. Set `ID_ORIGIN` (e.g. `https://id.6j0.org`). Optional: `ID_APP` (this
  app's name in the identity server's `APPS`; default `bored`) and `ID_JWKS_URL` (where to fetch its public keys;
  default `ID_ORIGIN/.well-known/jwks.json`). The local passkey endpoints are switched off.

The two modes keep separate accounts, so pick one before people sign up. Switching later strands existing users.

To try `6j0` mode locally, run the identity server on `localhost` and Bored on `127.0.0.1` (cookies ignore the
port, so two apps on one hostname would overwrite each other's session cookie):

```sh
# in the id repo
APPS=bored=http://127.0.0.1:3000 ORIGIN=http://localhost:4000 npm start
# here
AUTH_MODE=6j0 ID_ORIGIN=http://localhost:4000 ORIGIN=http://127.0.0.1:3000 npm start   # open http://127.0.0.1:3000
```

**Database migrations** run automatically on startup (`MIGRATIONS` in `db.js`, none yet). The `CREATE TABLE`s are
the schema as of the first real users; every change after that is a numbered migration, tracked in SQLite's
`PRAGMA user_version`. To change the schema, append a migration (never edit or reorder old ones). Back up
`data.sqlite*` before deploying one. A database from before the schema was reset (November 2026) can't be upgraded:
the server says so on startup, and you delete it to start fresh.

## How it works

| Step | Who | Where |
|---|---|---|
| Post an event (title, details, up to 5 tags, where (map pin), when (date, time, optional repeat), cost and currency, max attendees or no limit, public or shared with chosen contacts/groups) | Host | **Post** |
| Swipe right on events you're in for (filter by date, distance, tags, and free/paid); scroll down to the discard pile to change a swipe | Attendee | **Discover** |
| Swipe right on the people who want to join (anonymous, except your contacts) | Host | **Confirm** |
| Match → you learn who each other are, become contacts, and chat to sort out details | Both | **Plans** |
| "It happened" to close it out | Host | Plan chat |

Discover, Confirm, and Plans refresh when you scroll back up to the top of the page, or pull down (or scroll up)
while you're already there; the page gives a little bump when it does. Refreshing never resets a deck, and swiped
cards stay gone from it, so the decks have no undo button. Under the Discover deck, the **discard pile** shows the full cards you passed on or are still
waiting to hear back about, newest first, labelled "I'm in" or "Pass". Swipe one again (or use its button) to change
your mind: a pass becomes a request to join, and a request the host hasn't answered yet is taken back. **Confirm** has
a discard pile too: requests to join you said no to, waitlisted, or said yes to (until you've chatted), and connection
requests and invitations you said no to. Swipe one again to change your answer. **Plans** shows the full card for each
match; click one to open its chat, which is also where a match is changed once you've chatted.

A post stays in the deck until it reaches its max attendees; after that, saying yes joins its waitlist, and people
move off the waitlist in order as spots open. Posts with no limit stay open until the host removes them. Posts are
**private** by default: only the contacts and groups (contact tags) the host picks can see them. Until someone has a
contact (from matching or an invitation), new posts are public. **Public** posts show for everyone, including
signed-out guests. A post stays public or private once it's posted.

## Privacy model

The server is a mailbox. It stores signed public posts, and encrypted mail it can't read and can't tell the sender
of. Everything else happens in the browser: filtering Discover, who's in, the waitlist, and contacts.
[`docs/encryption.md`](docs/encryption.md) explains the whole design, with diagrams and the reasons for each choice.

- **Accounts** are a server-assigned GUID. Bored never stores a name, email, or password. If you used a passkey
  (`AUTH_MODE=local`), the server stores each passkey's public key; lose every passkey and the account is gone, so
  the app nudges people to add a second one (another device or a security key) (Profile → Passkeys). If you used a
  6j0.org identity, signing in is the identity server's job (see below).
- **Keys.** Each account has an ECDH P-256 *chat key* and an ECDSA P-256 *signing key*. The private halves are
  encrypted with the vault key, so whatever you sign in with (any of your passkeys, or your 6j0.org identity) can
  unlock them on a new device, and the browser keeps them as
  non-extractable WebCrypto keys. Each account also has a *main inbox*: a random token only its vault holds; the
  server files mail under the token's SHA-256.
- **Mail** (`public/envelope.js`) is built from standard parts, with nothing invented at the crypto layer:
  - *Sealed envelope:* HPKE (RFC 9180; DHKEM(P-256), HKDF-SHA256, AES-128-GCM, in `public/hpke.js`, checked against
    the RFC's test vectors) to the recipient's chat key, the way Nostr's gift wrap (NIP-59) works. HPKE's one-time
    key hides the sender. When the sender should be known (sharing a private post), they sign the message and the
    recipient's key inside the envelope.
  - *Channel:* every envelope also gives both sides a shared secret (HPKE's secret export). A request to join opens
    one; every later message about it (the answer, the waitlist, re-confirming, "it happened", and chat) is AES-GCM
    under a key from that secret, to two inboxes worked out from it, so the server can't link them to anyone.
  - *Signed record:* public posts, signed with ECDSA P-256. The server checks the signature before storing one, and
    every browser checks it again.
- **Requests to join are anonymous, except to contacts.** A stranger's request carries no sender: the host sees the
  note, not who sent it. When the host is one of your contacts, the request says who it's from (signed), and the host
  sees the nickname they gave you, but only if you're in their contacts too, with matching keys; otherwise it shows as
  anonymous. When the host says yes, both browsers send a signed `hello` with their GUID and keys over the channel, and
  each adds the other to its contacts.
- **What the server sees:**
  - Public posts: readable, as they must be, and signed, so it can't forge or change them. It can still take one down.
  - Mail: which inbox each message went to, when, and how big it was. Main inboxes belong to known accounts; channel
    inboxes don't. It never stores who sent a message. It does see which signed-in session sends each message as it
    arrives (for rate limits, kept in memory) and every request's IP address, though it doesn't store either. Mail is
    read without cookies.
  - Not readable: private posts and who they're shared with, who asked to join anything, answers, matches,
    waitlists, attendance, and chats.
  - Also stored: accounts, passkeys, sessions, push subscriptions, each account's encrypted vault, and invitation
    connections (who connected with whom, in plaintext).
- **Names are private.** You see only the nicknames *you* gave people. Everyone's avatar is the
  [Jdenticon](https://jdenticon.com) of their GUID (for a public post's host you don't know, of their signing key),
  which follows a person across their posts.
- **The vault** (nickname, tags, and saved keys for each contact; your posts and who each is shared with; your
  requests to join and their channel secrets) is encrypted in the browser with a random vault key. That key is
  wrapped by a key derived from each passkey's PRF output, so the server only stores ciphertext. A contact's keys are
  saved the first time they're used, so the server can't swap them later.
- **With a 6j0.org identity** (`AUTH_MODE=6j0`) the passkeys (and the optional password) live on the identity server instead. After sign-in it
  sends the browser back with a signed token and Bored's own *app key*, encrypted to a one-time key the page made
  and carried in the URL fragment (which never reaches a server). The vault key is wrapped by a key derived from the
  app key. Other 6j0.org apps get different app keys, so they can't read Bored data, and Bored gives the account
  its own public GUID, so people can't link your Bored account to your accounts in other apps.
- **Invitations to connect** are links (`/#invite=<token>`). The token stays in the URL fragment, so it isn't sent
  in requests or logged; the server stores only its SHA-256, and the owner's encrypted vault keeps the link to share
  again. Connecting makes two people contacts, the same as matching (the server records the pair in `connections`).
  Clicking the avatar of a post's host you aren't connected with sends them an invitation directly instead: it's
  mailed to their main inbox, sealed with no sender, and shows in their Confirm tab. When they say yes, the inviter's
  browser confirms it on its own (sending it already said yes) and deletes the invitation. Clicking a contact's avatar
  edits the nickname and tags you keep for them. The name you set in **Profile** is what invitations offer as what new
  people should call you; it's kept in your vault, like everything else about you.
- **Notifications** go through the browser vendor's push service (Google, Mozilla, Apple, or Microsoft). They're
  encrypted for the device, so the service can't read them, but it does see when they're sent and to which device.
  The text is always "New activity": the server doesn't know what the mail says.
- **Your location for the distance filter** stays in your browser (`localStorage`). Discover filters right there,
  so the server never learns it.
- `public/secure.js` holds the account's keys and the vault; `webauthn.js` verifies passkeys on the server with
  `node:crypto` only.
- Pages are served with a strict Content-Security-Policy (same-origin scripts only) to keep injected code away from keys.

### Known limits

- **No forward secrecy.** Neither HPKE base mode nor the channel keys have it. Anyone who later gets someone's chat
  key or vault can read their past messages. Fixing this would take a double ratchet or MLS.
- **The server can drop or delay mail.** Each side numbers its messages, so a dropped one shows as a gap, but it
  can't be recovered.
- **Timing and IP addresses** can still link things, e.g. a message sent soon before a channel inbox is read.
- **No push before a match.** Answers go to channel inboxes, which aren't tied to an account, so the person who asked
  sees the answer the next time the app checks.
- **The waitlist only moves while the host's browser is open**, since only it can send the answers.
- **Each browser downloads every live public post.** Fine at this size; splitting by region would come later.
- **Two devices sending on the same request at the same instant** can lose one of the two messages.
- **Spam:** anyone can send a request to a public post's host. Rate limits on the server, plus the browser ignoring
  anything the rules don't allow, are the only defense.

See `TODO.md` for the full list of open security and privacy issues.

## Files

- `server.js`: HTTP server + JSON API (passkey auth, mail, public posts, invitations, and push)
- `webauthn.js`: passkey registration/sign-in verification (no dependencies)
- `idtoken.js`: verifies sign-in tokens from a 6j0.org identity server (`AUTH_MODE=6j0`)
- `db.js`: SQLite schema and migrations
- `public/about.html`, `public/landing.js`, `public/about.js`: the introduction page, shown at `/` on a first visit, with a
  swipeable deck of example posts
- `public/examples.js`: the example posts, shared by that deck and the demo (`demo.js`)
- `public/app.js`: single-page front-end (vanilla JS, swipe deck with pointer/touch/keyboard)
- `public/secure.js`: passkeys + PRF, 6j0.org identity handoff, encrypted vault, and key storage
- `public/hpke.js`: HPKE (RFC 9180) on WebCrypto, one cipher suite
- `public/envelope.js`: the mail formats: signatures, signed records, sealed envelopes, and channels
- `public/posts.js`: the rules for posts, requests, matches, and chat as messages, and `derive()`, which replays them
- `public/mail.js`: the mail loop (read, check, replay) and everything the app sends
- `public/postfields.js`: checks a post's fields, in the browser and (for public posts) on the server
- `public/location.js`: "lat,lon" locations, links to the viewer's maps app, and a small OpenStreetMap pin picker
- `public/theme.js`: the automatic / light / dark theme switch, applied before the page draws
- `public/board.webp`: the wooden board behind the Bored title
- `public/when.js`, `public/cost.js`: event time (with repeat rules) and cost formats, shared by server and browser
- `public/pii.js`: finds contact info and ID numbers in posts and notes, which the post form points out as you type
  and refuses (and the server refuses in public posts), with [`@devopscoop/eat-the-pii`](https://gitlab.com/devopscoop/eat-the-pii) (installed from
  its git URL, so `.npmrc` sets `allow-git=root`); `public/libphonenumber.js` loads its phone number data in the browser
- `public/fonts/`: bundled National Park font, used for all text (SIL OFL 1.1, license alongside). The app loads nothing from outside its own server, except OpenStreetMap tiles while the location picker is open. Suggested place names come from OpenStreetMap's Nominatim, asked by the server (`/api/places/reverse`).
- `feedback.js`, `public/feedback.js`: the [feedback](#feedback) page's storage and rules, and the page itself (the same
  files as in Glaze Journal)
- `demo.js`: demo mode (`DEMO=1`): demo accounts with keys, their signed public posts, and the bot that answers them
- `test/`: the tests (see [Tests](#tests)); `test/lib.mjs` has the shared helpers
- `docs/encryption.md`: how the encryption and privacy system works, and why
- `TODO.md`: open security and privacy issues, by priority

## License

Copyright © 2026 6j0.org.

Bored is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. See [`LICENSE`](LICENSE).

The AGPL also covers running Bored as a service: if you run a modified version for other people, you must offer them
its source. The app links to the source from the sign-in and Profile screens (`SOURCE_URL` in `public/app.js`); point
it at your own repository if you change the code.

The bundled National Park font is under the SIL Open Font License 1.1 (`public/fonts/NationalPark-OFL.txt`), and Jdenticon, eat-the-pii, and libphonenumber-js are MIT.
