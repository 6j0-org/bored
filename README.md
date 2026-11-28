# Bored

A local event board that works like a dating app.
Host an event. Users swipe through posts in **Discover**, and **right = "I'm in"**.
In **Confirm**, the host swipes through the requests to join (anonymous, unless they're from one of the host's contacts), and **right = "Let's do it"**. When both sides say yes, it's on:
it shows up in **Plans**, where you chat and sort out details. Afterwards the host marks it as done.

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
npm run test:unit      # HPKE against RFC 9180's test vectors, the request rules in posts.js, feedback.js, and moderation.js; no server
npm run test:server    # real accounts in Node against a demo-mode server: mail, public posts, reports, and demo seeding
npm run test:browser   # the real UI in two headless Chromium profiles: post, join, match, chat, leave, and the tutorial
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
`PUSH_HOSTS` (extra push service hostnames to allow, comma-separated), `NTFY_SERVERS` (the
[ntfy](#notifications) servers people can pick, comma-separated origins, each optionally `=<access token>`; default
`https://ntfy.sh`, empty to turn ntfy off), `DISCOVER_NEWS_HOURS` (when to send
["New posts in Discover"](#notifications) notifications: hours from 0 to 23, comma-separated, in the server's time
zone, set with `TZ`; default `10,16`, empty to turn them off), `DEMO` (`1` for [demo mode](#demo-mode)),
`FEEDBACK_PATH` (default `feedback.jsonl` next to the database), `ADMIN_SUB` or `ADMIN_GUID` (one more developer for
[feedback](#feedback), besides `DEVELOPER_GUIDS` in `server.js`: a 6j0.org identity's `sub` with `AUTH_MODE=6j0`, or an
account's GUID in any mode).

### Feedback

Bored is in alpha, and every screen says so in a note under the board, with a link to the feedback page; the About
page has the same note. People who aren't signed in are asked to sign in first. The page is
where people read everyone's feedback and post their own: plain text, up to 2048 characters. Each post is a chat, like
a plan's: tapping it opens its thread, where anyone signed in can reply. Developers close a thread as Done or Won't do,
or reopen it, and the person who posted it gets a push notification when someone replies or a developer closes it.
Posts and replies show their author's profile icon, and the name you gave them if they're one of your contacts
(the post's author is also labeled "Tester" in its thread). The server sends the icon hash (the SHA-1 of the GUID),
never the GUID itself, so strangers stay unnamed; it files each post under the account's GUID so people can delete
their own. People can edit their own posts and replies from the
post's chat. Each account can post, reply, or edit 100 times a day, and everyone together 500 times a day. In the demo, each visitor sees only their own posts.

Developers are the accounts listed in `DEVELOPER_GUIDS` in `server.js` (plus `ADMIN_SUB` or `ADMIN_GUID`, if set).
They can reply to, close, and delete anyone's feedback, their posts are labeled "Developer", and their Profile page
shows a Developer badge. Everyone's account ID (GUID) is at the bottom of their Profile page, for adding them to the
list. Anyone with feedback marked Done gets a Tester badge on their Profile page, with how many.

Feedback is shared, so it isn't encrypted, and the page says so. It's kept in a JSON Lines file (`FEEDBACK_PATH`): one
JSON object per line, appended to and never edited in place: posts, replies (`{"reply": post id, …}`), status changes
(`{"status": post id, "value": "done"}`), edits (`{"edit": post or reply id, "body": …}`), and deletions
(`{"delete": id}`). The server loads it at startup and, if anything was deleted or edited, rewrites it without the
deleted posts and their replies, and with edits folded in, so old text doesn't stay on disk. `feedback.js` and
`public/feedback.js` are the same files as in Glaze Journal, which has the feature too; keep them identical. Bored
shows authors by passing `authorKey` (server) and `author` (page); Glaze Journal leaves them out, so its feedback is
anonymous.

### Notifications

Web Push, opt-in per device from Profile: Chrome on Android, and desktop Chrome, Edge, Firefox, and Safari. On iPhone
and iPad (iOS 16.4+) only after adding the app to the Home Screen. `push.js` encrypts each notification for the device
(RFC 8291) and signs requests with this server's VAPID key (RFC 8292, generated on first use and kept in the
database), using `node:crypto` only. Push needs HTTPS (or `localhost`).

Tapping a notification opens what it's about. Most are "New activity" for encrypted mail, which the server can't
read, so the app opens the newest thing in the mail once it's loaded: that plan's chat, a request waiting in Confirm,
or Discover. Feedback notifications open the post's chat.

**New posts in Discover**: twice a day, at 10:00 and 16:00 server time (`DISCOVER_NEWS_HOURS`, `TZ`), everyone with
notifications on (Web Push or ntfy) gets "New posts in Discover" if someone else published a public post since the last
round and it's still live. Updates to older posts don't count. Tapping it opens Discover. It's on by default, and a
checkbox under Notifications in Profile turns it off for the account. The text is generic because Discover's filters
(where, tags, cost, and when) stay in the browser: the server can't tell whether a new post is one the person would
see. `kill -USR2 <pid>` runs a round now.

On Android, Chromium-based browsers deliver web notifications through Google Play services, so phones without them
(such as GrapheneOS without sandboxed Google Play) can't turn notifications on; the app says so, and offers ntfy.

**ntfy**, for those phones: in Profile, "Set up ntfy" gives the account a random topic (`bored_` plus 32 random
characters) on one of the servers in `NTFY_SERVERS`, which the person subscribes to in the [ntfy](https://ntfy.sh)
app. From then on every notification is also published there (as JSON to the server's root URL), with the same
generic text and a link that opens the app on the right screen. Unlike Web Push it isn't end-to-end encrypted: the
ntfy server, and anyone who learns the topic, can read the generic text. People can get a new topic or turn it off;
it's one topic per account, used on as many phones as they like. Bored only publishes to the listed servers, so
nobody can make it send requests anywhere else. Free ntfy.sh limits how much one IP address can publish a day, and
every notification comes from this server's address, so a busy server should use an access token (a paid ntfy.sh
account, `NTFY_SERVERS=https://ntfy.sh=tk_…`) or its own ntfy server.

### Sign-in: standalone or with a 6j0.org identity

`AUTH_MODE` picks who signs people in:

- `local` (default): Bored runs its own passkeys, as described below. Works on its own.
- `6j0`: people sign in with an anonymous identity from a [6j0.org identity server](https://gitlab.com/6j0-org/id),
  so one sign-in (passkey, or username + password) covers every 6j0.org app. Set `ID_ORIGIN` (e.g. `https://id.6j0.org`). Optional: `ID_APP` (this
  app's name in the identity server's `APPS`; default `bored`) and `ID_JWKS_URL` (where to fetch its public keys;
  default `ID_ORIGIN/.well-known/jwks.json`). The local passkey endpoints are switched off.

The two modes keep separate accounts, so pick one before people sign up. Switching later strands existing users.

An identity made with the identity server's "Just start" lives only in the browser that made it until its account
key is saved (the sign-in token says `saved: false`). Bored records that in `id_accounts.id_saved`, warns on every
screen with a link to `ID_ORIGIN/#save`, and signs in again (an instant redirect) to see whether it's been saved: on
the next start after that link is followed, and otherwise once a week. The weekly check also counts as using the
identity, which the identity server deletes if it's unsaved and unused for 90 days.

To try `6j0` mode locally, run the identity server on `localhost` and Bored on `127.0.0.1` (cookies ignore the
port, so two apps on one hostname would overwrite each other's session cookie):

```sh
# in the id repo
APPS=bored=http://127.0.0.1:3000 ORIGIN=http://localhost:4000 npm start
# here
AUTH_MODE=6j0 ID_ORIGIN=http://localhost:4000 ORIGIN=http://127.0.0.1:3000 npm start   # open http://127.0.0.1:3000
```

**Database migrations** run automatically on startup (`MIGRATIONS` in `db.js`). The `CREATE TABLE`s are
the schema as of the first real users; every change after that is a numbered migration, tracked in SQLite's
`PRAGMA user_version`. To change the schema, append a migration (never edit or reorder old ones). Back up
`data.sqlite*` before deploying one. A database from before the schema was reset (November 2026) can't be upgraded:
the server says so on startup, and you delete it to start fresh.

## How it works

The first time someone signed in opens the app, a short tutorial walks through the six steps (Connect, Get
notified, Post, Discover, Confirm, and Plan), one box at a time above the tab bar. Each step rings its tab and, once you're there,
the thing to use; "Show me", Next, and Back move between them. Finishing or skipping it is saved in the encrypted
vault, so it shows once per account. "Show the tutorial" in Profile's settings turns it back on (or off).

| Step | Who | Where |
|---|---|---|
| Post an event (title, details, up to 5 tags, where (map pin), when (date, time, optional repeat, with quick picks like "In an hour" and ends like "2 hours" or "Sunset"), cost and currency, max attendees or no limit, public or shared with chosen contacts/groups). A post idea fills in the form. The button says who'll see it ("Post it to 3 people"); a private post needs at least one person, and a public one asks first | Host | **Post** |
| Swipe right on events you're in for (search, and filter by date, distance, tags, and free/paid), then rate how interested you are (0 to 5 stars) and add a note for the host, both optional; scroll down to the discard pile to change a swipe | Attendee | **Discover** |
| Swipe right on the people who want to join (anonymous, except your contacts) | Host | **Confirm** |
| Match → you learn who each other are and chat to sort out details (matching doesn't make you contacts) | Both | **Plans** |
| "Mark as done" to close it out | Host | Plan chat |
| "Cancel plan" to call it off: everyone who asked to join or is in is told, and the post is removed (so is Remove in Posts) | Host | Plan chat |

Every tab has a search box: Discover's searches the posts, Confirm's the requests, Plans' the plans, Post's your
posts, and Profile's your contacts and invitations. Every word typed has to match, ignoring case and accents. Each
tab keeps its own search until the app is closed; it isn't saved, so an old search never hides new things.

Discover, Confirm, and Plans refresh when you scroll back up to the top of the page, or pull down (or scroll up)
while you're already there; the page gives a little bump when it does. Refreshing never resets a deck, and swiped
cards stay gone from it, so the decks have no undo button. Under the Discover deck, the **discard pile** shows the full cards you passed on or are still
waiting to hear back about, newest first, labelled "I'm in" or "Pass". Swipe one again (or use its button) to change
your mind: a pass becomes a request to join, and a request the host hasn't answered yet is taken back. **Delete** clears
a card out of the pile for good (it stays out of the deck too; deleting a request you're waiting on takes it back first). **Confirm** has
a discard pile too: requests to join you said no to, waitlisted, or said yes to (until you've chatted), and connection
requests and invitations you said no to. Swipe one again to change your answer. **Plans** shows the full card for each
match; click one to open its chat, which is also where a match is changed once you've chatted. Cards can only be deleted
from a discard pile, from Past in **Plans**, and from your own posts in **Posts** (Remove for a post that's still
on, which tells everyone; Delete for one that's done). A plan that's still on has no Delete: say "Can't make it"
first, which moves it to Past. Deleting a past plan or post only hides it from you, on all your devices.

A post stays in the deck until it reaches its max attendees; after that, saying yes joins its waitlist, and people
move off the waitlist in order as spots open. Posts with no limit stay open until the host removes them. Posts are
**private** by default: only the contacts and groups (contact tags) the host picks can see them. Until someone has a
contact (both people said yes to an invitation), new posts are public. **Public** posts show for everyone, including
signed-out guests. A post stays public or private once it's posted.

## Moderation

Moderation is up to each person, in **Profile → Moderation**. The settings are kept in their encrypted vault, and they
only change what that person sees. Guests get the defaults, and everything is on by default.

- **Word lists.** The built-in list of offensive words stars them out of other people's posts, request notes, and chats.
  People can add their own lists (one word or phrase per line; `x*` means the letter can repeat), and set each list,
  built-in or their own, to hide whole posts that use its words instead. Words are matched whole, and plurals count, so
  "class" never matches a word inside it. The built-in list is
  [profanity-list](https://github.com/dsojevic/profanity-list) (the `@dsojevic/profanity-list` npm package, MIT),
  leaving out its mildest entries (everyday words like mild swearing, religious words, and medical terms). The server
  serves it from `node_modules` like the other browser packages, so the words aren't in this repository.
- **Reports.** "Report or block" on someone else's card reports a public post for spam, scam or fraud, offensive,
  harassment or hate, or dangerous or illegal content. A post you report goes to your discard pile, like a pass. The
  server counts reports per post and reason. Each person picks, per reason, how many reports it takes to hide a post
  from them (3 by default), or turns that reason off; hidden posts are left out of Discover and its discard pile until
  they change the setting. Private posts can't be reported, since they come from contacts, who can be blocked.
- **Blocking** someone (from a post's "Report or block", or a contact's info) hides their posts and their chat
  messages, says no to their requests to join, connect, and invitations without showing them, and stops sharing
  private posts with them. Requests from strangers are anonymous, so blocking only catches people who say who they
  are. Blocked people are listed in Moderation, to unblock.
- **Deleting your account** (Profile → Delete account) takes the last 4 characters of the Account ID shown under it.
  The browser first cancels the posts you're hosting that are still on (so the people they're shared with are told,
  through their own inboxes), then sends the read tokens of the inboxes it writes to: its main inbox and its side of
  every channel. The server (`POST /api/account/delete`) erases the account and everything that cascades from it
  (keys, vault, passkeys, sessions, public posts and the reports on them, invitations, connections, connection
  requests, and push subscriptions), the mail in those inboxes, the reports it filed, and its feedback posts and
  replies (`eraseUser` in `feedback.js`; gone from disk at the next restart). There's no recovery. In the demo, a
  fresh account follows. With `AUTH_MODE=6j0`, the account belongs to the 6j0.org identity: Profile explains that
  deleting the identity deletes its accounts on every 6j0.org service and links to the identity server's "Delete your
  identity" (`ID_ORIGIN/#delete`), and the endpoint refuses. Once the identity is deleted, the identity server POSTs
  a signed deletion notice to `/api/id/deleted` (`verifyDeletionToken` in `idtoken.js`), and the account is erased
  the same way, except for its side of each chat (the server doesn't know those inboxes without the browser) and
  without cancelling its posts first, so Profile asks people to remove them before they go.
- **Deleting a contact** removes them from your contacts (and any invitation connection on the server), and stops
  sharing private posts with them. Neither blocking nor deleting tells the other person.

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
  - Reports on public posts, as each arrives with its session. They're stored under a keyed hash of the account and
    the post, with no timestamps, so the table alone isn't a list of who reported what; but the server holds the key.
  - Not readable: private posts and who they're shared with, who asked to join anything, answers, matches,
    waitlists, attendance, chats, moderation settings, and who you've blocked.
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
  again. Someone new who opens one sees the About page first, where "Open Bored" becomes "Connect with <name>" and
  carries the link on to the app. Connecting is the only way two people become contacts: both say yes, and each picks a nickname for the
  other (the server records the pair in `connections`). Matching on a post doesn't connect anyone. Clicking the
  avatar of a post's host you aren't connected with, or "Invite them to connect" in a plan's chat, sends them an
  invitation directly instead, with your nickname for them and the name you suggest for yourself: it's mailed to
  their main inbox (from the post, or from their hello), sealed with no sender, and shows in their Confirm tab. When they say yes, the inviter's
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
  anything the rules don't allow, are the only defense. Blocking can't catch a stranger's request, which is anonymous.
- **Deleting an account leaves traces with other people.** Their side of each chat stays, and so does mail already
  in their inboxes (shares of your private posts, marked cancelled, and your requests to join their posts). A plan
  with someone who deleted their account still shows as on for the other person, with only their own messages. Mail
  sent to a deleted account's inbox afterwards is stored like any other, sealed to a key nobody has. And since the
  server can't tell which side of a channel is whose, someone deleting their account could erase the other side of
  their own chats too.
- **Deleting a 6j0.org identity leaves more behind**: its side of each chat (ciphertext only the other person can
  read, no longer tied to any account), and its private posts, still showing as on for the people they were shared
  with, unless they were removed first. If Bored is down for 30 days straight, the identity server gives up and
  logs the identity so it can be erased by hand.
- **Report counts can be gamed** by someone with many accounts, like any vote. Each person's own threshold, and
  being able to turn a reason off, limit the damage.

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
- `public/theme.js`: the automatic / light / dark theme switch and the title board's look, applied before the page draws
- `public/html.js`: `esc()`, which escapes text for the HTML that pages build from template strings
- `public/pointer.js`: "tap", "click", or "tap or click" in UI text, to match how the device points
- `public/board-surf.svg`, `public/board-planed.svg`, `public/board.webp`: the boards behind the Bored title (the
  surfboard, the default, with its sand theme; the cartoon board; and the photo board), picked in Profile's Settings and
  swapped, with the surfboard's colors, by `public/boards.css`
- `public/when.js`, `public/cost.js`: event time (with repeat rules) and cost formats, shared by server and browser
- `public/moderation.js`: word filters, report thresholds, and moderation settings
- `public/pii.js`: finds contact info and ID numbers in posts and notes, which the post form points out as you type
  and refuses (and the server refuses in public posts), with [`@devopscoop/eat-the-pii`](https://gitlab.com/devopscoop/eat-the-pii) (installed from
  its git URL, so `.npmrc` sets `allow-git=root`); `public/libphonenumber.js` loads its phone number data in the browser
- `public/instagram.js`: what a link to an Instagram post or reel looks like; a post's Details may have one (a link to
  a profile is still refused), and it shows as a link
- `public/fonts/`: bundled National Park font, used for all text (SIL OFL 1.1, license alongside). The app loads nothing from outside its own server, except OpenStreetMap tiles while the location picker is open. Suggested place names come from OpenStreetMap's Nominatim, asked by the server (`/api/places/reverse`).
- `feedback.js`, `public/feedback.js`: the [feedback](#feedback) page's storage and rules, and the page itself (the same
  files as in Glaze Journal)
- `demo.js`: demo mode (`DEMO=1`): demo accounts with keys, their signed public posts, and the bot that answers them
- `test/`: the tests (see [Tests](#tests)); `test/lib.mjs` has the shared helpers, and `test/spawn.mjs` starts a server
  for the runner and for tests that need one of their own
- `docs/encryption.md`: how the encryption and privacy system works, and why
- `docs/styling.md`: how the app looks: the rule for buttons, filters, and choices, plus colors, cards, the discard pile, and page structure
- `TODO.md`: open security and privacy issues, by priority
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`: how to contribute, the Contributor Covenant, and how to report
  security holes privately

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to report bugs, suggest ideas, and send changes. Everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md). Please report security and privacy holes privately, as
[`SECURITY.md`](SECURITY.md) describes.

## License

Copyright © 2026 6j0.org.

Bored is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. See [`LICENSE`](LICENSE).

The AGPL also covers running Bored as a service: if you run a modified version for other people, you must offer them
its source. The app links to the source from the sign-in and Profile screens (`SOURCE_URL` in `public/app.js`); point
it at your own repository if you change the code.

The bundled National Park font is under the SIL Open Font License 1.1 (`public/fonts/NationalPark-OFL.txt`), and Jdenticon, eat-the-pii, libphonenumber-js, and profanity-list are MIT.
The built-in word list is David Sojevic's profanity-list (MIT).
