# Security & privacy TODO

Open security and privacy issues in the Bored prototype, grouped by area.
Priority: **P0** = must fix before real users, **P1** = should fix before launch, **P2** = later / hardening.

Goal (from the product brief): the server admin should not learn any user's real name or social connections.
Names are already handled (no names stored; nicknames live in each user's encrypted vault). Since the move to
encrypted mail (see "Privacy model" in the README), the server no longer sees who asks to join what, matches,
waitlists, attendance, or chats, and private posts are encrypted. Most items below are about the **metadata that's
left**, and about the limits of doing end-to-end encryption in a web app.

---

## 1. Social graph and metadata the server still sees

- [ ] **P1: Invitation connections are plaintext.** `connections` records who connected with whom through an
  invitation link, and `connection_requests` who asked whom. That's part of the social graph. Move invitations to
  mail too: the link could carry the inviter's main inbox and chat key, and connecting would be a sealed exchange.
- [ ] **P1: Mail metadata.** The server stores, for each message, the inbox it went to, when, and its size. Main
  inboxes belong to known accounts, so it sees when someone gets a share, a request to join, or a poke. It also sees
  which session sends each message as it arrives (for rate limits, in memory only). Consider padding message sizes,
  sending pokes from a delay queue, and sending without a session (e.g. Privacy Pass-style tokens for rate limits).
- [ ] **P1: Public posts link to one host.** A public post carries its host's signing key and main inbox, and the
  card's icon is drawn from the signing key, so anyone can tell which public posts are from the same host. A
  per-post signing key and reply inbox would stop that (the host's browser would keep them in the vault), at the cost
  of people having one face.
- [ ] **P1: Post contents are identifying.** Public posts are visible to anyone, and "Where" is exact coordinates
  (the picker warns about this). Consider rounding coordinates or coarse neighborhoods.
- [ ] **P2: The location picker contacts OpenStreetMap.** While it's open, the browser fetches tiles from
  tile.openstreetmap.org, which sees the viewer's IP, the area they look at, and (via Referer) this site's origin.
  Consider self-hosting tiles or proxying them.
- [ ] **P2: Push notifications reveal activity to push services.** Google, Mozilla, Apple, or Microsoft see when each
  device gets a notification, which hints at when someone is matched or messaged. The server also stores each
  device's push subscription next to its account (`push_subscriptions`). Consider batching or delaying pushes.
- [ ] **P2: Place names come from Nominatim.** When a host drops a pin, the server sends its coordinates to
  nominatim.openstreetmap.org for a suggested name (`reverseGeocode()` in `server.js`). The server makes the request,
  so OSM sees the server's IP, not the host's, but it does see the spot. Nominatim also allows only one request a
  second; at real volume, run our own Nominatim or use a paid geocoder.
- [ ] **P2: Timestamps everywhere** (`created_at` on users, passkeys, and mail; `updated_at` on public posts;
  `last_used_at` on passkeys) enable timing correlation. Reduce precision or drop where not needed.
- [ ] **P2: Mail is kept forever, and read from the start.** Each app load reads the main inbox from the beginning,
  and nothing is ever deleted (outside demo mode). Let readers delete mail they've read, or expire channel mail some
  time after a post has happened.

## 2. Network and hosting

- [ ] **P0: IP addresses.** The server (and any reverse proxy or CDN) sees client IPs, which can tie GUIDs to real
  people. Define a no-logging policy, strip IPs at the proxy, and document it. Consider Tor/onion support.
- [ ] **P0: HTTPS only in production.** Passkeys require a secure context outside `localhost`. Set `ORIGIN`
  (and `RP_ID`) and add HSTS. With `ORIGIN` unset, the server derives the expected origin from the `Host` /
  `X-Forwarded-Proto` headers (`originOf()` in `server.js`), which is only acceptable for local development.
- [ ] **P1: The database is unencrypted at rest**, along with its backups. It holds the graph, public keys, and
  ciphertext. Encrypt the disk and backups, and restrict access.
- [ ] **P2: Hosting jurisdiction and legal requests.** Document what data exists and what we can be compelled to
  hand over (see section 1).

## 3. Web-app end-to-end encryption limits

- [ ] **P0: The server delivers the code that holds the keys.** A malicious or compromised server can serve
  JavaScript that exfiltrates the vault key, chat key, or plaintext. This is the core weakness of web E2E. Options:
  a reproducible, signed build plus a verification browser extension, Subresource Integrity with pinned hashes
  published elsewhere, or native/PWA apps with signed updates.
- [ ] **P0: Peer public keys aren't verified.** A contact's keys come from the server (`/api/keys`) the first time
  they're needed, and are saved in the vault after that, so the server can't swap them later. But it could hand out
  wrong keys that first time (man in the middle), and a public post's keys come from the post itself. Add safety
  numbers / key fingerprints users can compare in person, and/or key transparency.
- [ ] **P1: No forward secrecy.** Sealed envelopes are HPKE base mode to each user's one static chat key, and a
  channel's key comes from the envelope that opened it, so leaking a chat key (or the vault) exposes every past and
  future message to that person. Move to a ratcheting protocol (Signal-style double ratchet, or MLS) or at least
  periodic key rotation.
- [ ] **P1: No sender authentication inside a channel.** Both sides share one symmetric key per channel, so either
  side could write a message as the other (the demo bot does exactly that to fill in conversations). Messages carry a
  role, a counter, and a random ID, so the server can't reflect, reorder, or replay them unnoticed, and a dropped one
  shows as a gap; but it can still drop them. Add per-message signatures (or per-side keys from the channel secret).
- [ ] **P1: Vault rollback.** The server could serve an old vault version (`/api/vault`) to hide contact changes.
  Keep a signed or MACed monotonic version on the client and detect rollbacks.
- [ ] **P1: Not enough AES-GCM additional data.** Sealed envelopes are bound to their inbox (the inbox ID is HPKE's
  AAD), but the vault, the encrypted private keys, and channel messages aren't bound to their purpose or owner, so
  the server could swap ciphertexts between fields. Bind each blob with AAD such as `guid | purpose | id`.
- [ ] **P2: Removing a passkey doesn't rotate the vault key.** `DELETE /api/passkeys/:id` deletes the wrapped key, but
  anyone who already captured that passkey's PRF output and wrapped key can still unwrap the same vault key.
  Rotate the vault key (and re-encrypt the vault and chat key) when a passkey is removed.

## 4. Keys on the device

- [ ] **P1: Keys persist in IndexedDB until sign-out.** The vault and chat keys are stored as non-extractable CryptoKeys
  (`installKeys()` in `public/secure.js`), so they can't be copied out, but any script running on the page, or
  anyone using the unlocked device, can *use* them. Add an idle auto-lock that requires the passkey again, and a
  "this is a shared computer" option that keeps keys in memory only.
- [ ] **P1: XSS means key misuse.** The CSP blocks inline and third-party scripts, but `style-src` allows
  `'unsafe-inline'` (inline `style=` attributes in the markup). Move inline styles to CSS so the policy can be
  tightened, and keep all user content going through `esc()`.
- [ ] **P2: The browser extension attack surface** (extensions can read page content) is outside our control. Document it.

## 5. Accounts, sessions, and passkeys

- [ ] **P1: Session lifetime and revocation.** Sessions last 30 days, with no "sign out everywhere" and no list of
  active sessions. Add both, plus shorter idle timeouts.
- [ ] **P1: Session tokens are stored unhashed** in the `sessions` table. Store a hash so a database leak doesn't hand out
  live sessions.
- [ ] **P1: CSRF.** Protection relies on `SameSite=Lax` plus requiring `Content-Type: application/json`. Add an
  explicit CSRF token or an `Origin` header check on state-changing requests.
- [ ] **P1: Secure cookies** are only set when `ORIGIN` starts with `https:`. Make HTTPS the default outside localhost.
- [ ] **P1: Passkey challenges live in process memory** (`webauthn.js`). A restart cancels sign-ins in progress, and
  multiple server processes would break sign-in. Move challenges to the database or a shared store with a TTL.
- [ ] **P2: Minimal WebAuthn verification.** We use attestation `none`, trust the browser-reported SPKI public key
  without parsing the COSE key in `attestationObject`, and only enforce the signature counter when both values are
  non-zero. Consider full CBOR/COSE parsing, checking backup-eligible/backed-up flags (to warn about device-bound
  passkeys with no backup), and an authenticator allow-list if needed.
- [ ] **P2: Error messages** on sign-in reveal whether a passkey is registered ("This passkey isn't registered…").
  This is low risk, but could be made generic.
- [ ] **P2: Lost passkey = lost account (by design).** Keep the nudges (second device or security key). Consider an
  optional, user-held recovery key (printed or saved offline) that wraps the vault key, never escrowed by us.
- [ ] **P2: PRF support varies** across browsers and passkey managers. Signup is blocked without it; keep the
  supported list in the UI current. If a passkey provider is compromised, so is that passkey's vault access.
  **State as of 2026-11-15:**
  - **Bitwarden** doesn't return PRF results for passkeys stored in it. We tested the browser extension in LibreWolf
    and Chromium on Arch Linux, and the app as a passkey provider on GrapheneOS with Vanadium: the extension
    results were empty every time. Its November 2025 "PRF" release is about logging *into* Bitwarden with a passkey
    from somewhere else. Storing passkeys that support PRF is an open feature request:
    https://community.bitwarden.com/t/support-for-storing-prf-capable-passkeys-in-bitwarden-vault/82239
  - **KeePassXC** stores passkeys, but PRF isn't in a released version; the pull request reportedly targets 2.8.1.
  - **Proton Pass, KeePassDX:** status unknown.
  - **Works:** security keys with hmac-secret (YubiKey 5, Nitrokey 3, SoloKey 2), Google Password Manager,
    iCloud Keychain (macOS/iOS 18+).
  - So no free, open-source password manager supports PRF in a released version yet. The 6j0.org identity server
    is adding a username + password fallback for now. **Follow up:** recheck Bitwarden and KeePassXC, and once one
    ships PRF, update the advice text (`PRF_ADVICE` in 6j0-org-id `public/id.js`, `UPGRADE_ADVICE` in
    `public/app.js`) to recommend it again.

### With a 6j0.org identity (`AUTH_MODE=6j0`)

- [ ] **P1: The identity server holds every app's keys.** It can't read Bored data on its own (it never sees the root
  secret), but a compromised id.6j0.org page could derive every app's key for whoever signs in there. Keep it small,
  strictly CSP'd, and separately deployed. See the id repo's TODO.
- [ ] **P1: Signing out of Bored doesn't sign out of id.6j0.org,** so "Continue" signs straight back in without a
  passkey prompt while the identity session lasts. Say so in the UI, and consider a "sign out of all 6j0.org apps" link.
- [ ] **P2: Setup tickets and seen-token IDs live in process memory** (like passkey challenges): a restart between the
  redirect and account creation means signing in again.
- [ ] **P2: No migration between modes.** A local-passkey account can't be linked to a 6j0.org identity (or back).

## 6. Abuse, rate limiting, and safety

- [ ] **P0: Not enough rate limiting.** Sending mail (600 an hour per account, 60 to any one inbox) and publishing
  public posts (120 an hour) are limited, in memory. Account creation, sign-in, and reading mail and public posts
  aren't. That allows Sybil accounts, scraping, and denial of service. Add per-IP and per-account limits
  (privacy-preserving where possible, e.g. Privacy Pass-style tokens).
- [ ] **P1: Spam requests to join.** Anyone can send requests to a public post's host, anonymously by design. Beyond
  the rate limits, the browser only ignores what the rules don't allow. Consider a way for hosts to stop requests on
  a post, or proof-of-work on requests.
- [ ] **P0: In-person safety.** Users meet anonymous strangers in real life. Add blocking, reporting, safety tips, and
  a way to unmatch and hide your posts from someone. Design reporting so it doesn't break the privacy model
  (e.g. the reporter voluntarily reveals specific decrypted messages).
- [ ] **P1: Anonymous public posts can be abused** (harassment, scams, illegal events). Moderation needs to work without
  identities: think through tooling.
- [ ] **P2: Request size limits** are 512 KB per body and 200 KB per encrypted blob. Review them once real usage is known.

## 7. Data retention and deletion

- [ ] **P1: No account deletion.** Add "delete my account", which removes the user, passkeys, sessions, vault, public
  posts, and main inbox mail. Channel mail can't be tied to the account, so the browser would
  have to delete it (it knows the channels). Decide what happens to the other person's view of shared matches.
- [ ] **P1: No retention policy.** Ended public posts and all mail are kept forever. Define retention and purge on
  a schedule.
- [ ] **P2: The waitlist only moves while the host's browser is open,** since only the host can send answers.

# Sloppy part

Conversely, maybe you want to go out and patronize your local establishments, but you don't want to go alone? Also mutual aid helping people feels good and builds the social bonds that are the glue of civilization.

Bored is free forever. It's free and open source software. If you want to steal our code and modify it, you can. It will always be ad-free. It will never seek investor funding. It is privacy-enforcing, you cannot leave personal info, because we don't collect it: no photos, no e-mail addresses, no phone number - you can't accidentally dox yourself

Production and GA

SQLite is enough. For under 100 users it's not even close to a limit; SQLite comfortably handles thousands of users at this scale. It's already in WAL mode, which is the right setting. Postgres would only be worth it if you needed several app servers at once, and Bored doesn't. The things that matter with SQLite:
- Backups. This is the real gap. Use Litestream to stream copies to object storage continuously, or at least a nightly sqlite3 data.sqlite ".backup ..." copied off the server. Then actually test a restore.
- Persistent disk. Keep the database on a real volume, not inside the container's own filesystem.
- One app process. node:sqlite is synchronous and Bored runs as one process, which is fine. Just don't scale it out to several copies.

Must-haves before GA:
1. HTTPS, with ORIGIN set. Passkeys won't work without it. Put a reverse proxy like Caddy in front, and decide what it logs, since IP addresses are a P0 privacy item in TODO.md.
2. Safety features. This app gets strangers to meet in person. I found no block or report feature in the server. You need at least:
   - block a person;
   - report a post or person, and a way for you to act on reports (hide posts, ban accounts);
   - basic safety tips ("meet in public").
4. Terms of service and a privacy policy. The policy can be short because you collect so little, but public posts have exact meetup locations, and the server sees mail metadata and invitation connections.
5. Account deletion. I didn't find a delete-account route, and GDPR and similar laws expect one.
6. Rate limiting on sign-up and sign-in, to stop bots. Sending mail and publishing public posts are limited now (in memory).
7. Monitoring. An uptime check, error logs, and disk-space alerts.

From TODO.md: the P0 items are IP addresses, HTTPS, the server delivering the code that holds the keys, and peer keys not being verified. For a 100-user GA you don't need to solve all of them, but the privacy policy should be honest about them. The cheap ones are HTTPS and proxy log settings.

Nice to have: a staging copy of the site, automatic dependency updates, and a status page.

The biggest gaps by far are backups and safety tools (block, report, and moderation). Should I start with Litestream backups, or with block and report?

Should we try to turn it in p2p with relays?

Moderation - default list of words to filter out? Default follow moderators. Filter by social score. Allow pull back the veil to see everything.
6:41 AM

Federation between instances with activity pub?

export data

