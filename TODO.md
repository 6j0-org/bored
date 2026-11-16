# Security & privacy TODO

Open security and privacy issues in the Bored? prototype, grouped by area.
Priority: **P0** = must fix before real users, **P1** = should fix before launch, **P2** = later / hardening.

Goal (from the product brief): the server admin should not learn any user's real name or social connections.
Names are already handled (no names stored; nicknames live in each user's encrypted vault). Most items below are
about **connections and metadata**, and about the limits of doing end-to-end encryption in a web app.

---

## 1. Social graph and metadata the server still sees

- [ ] **P0: The match graph is in plaintext.** `swipes` (who asked to join whose event, accepted/declined/attended) links
  host and attendee GUIDs, with timestamps. That *is* the social graph. Match records are intentionally kept for
  now; we need another way to protect them. Ideas: per-match pseudonymous IDs instead of account GUIDs, private set
  intersection / blind matching, sealed-sender-style message routing, or client-encrypted match records the server
  can't attribute.
- [ ] **P0: Message metadata.** Even with E2E chat, the server sees which match a message belongs to (so both GUIDs),
  who sent it, when, and its length. Consider padding message sizes and decoupling sender identity from storage.
- [ ] **P1: The "Your circle" stats come from the graph.** `/api/ledger` computes events-together counts per pair on the
  server, so the server must know the pairs. Move this to the client (count from your own encrypted vault) once
  matches are protected.
- [ ] **P1: Posts are linkable to one account.** Every post carries the host's GUID (`/api/discover` returns
  `host.guid`, even to guests), so anyone can link all of one person's posts. Combined with "Where"/"When",
  that can de-anonymize people. Use a per-post pseudonym in public responses.
- [ ] **P1: Avatars leak identity.** Avatar colors are derived from the GUID (`hue(guid)` in `public/app.js`), so the
  same color follows a person across posts. Derive from a per-post or per-viewer value instead.
- [ ] **P1: Public activity counts.** Hosted/attended counts per GUID (`stats()` in `server.js`) are public on every
  card and reveal how active someone is. Consider coarse buckets, or hide them.
- [ ] **P1: Post contents are identifying.** Public posts are visible to anyone, and "Where" is exact coordinates
  (the picker warns about this). Consider rounding coordinates or coarse neighborhoods.
- [ ] **P1: Private posts reveal who they're shared with.** The server stores the viewer GUIDs for each private
  post (`event_viewers`), which exposes part of the host's contact graph. Post contents are also plaintext on the
  server. Consider encrypting private posts per viewer.
- [ ] **P2: The location picker contacts OpenStreetMap.** While it's open, the browser fetches tiles from
  tile.openstreetmap.org, which sees the viewer's IP, the area they look at, and (via Referer) this site's origin.
  Consider self-hosting tiles or proxying them.
- [ ] **P2: Timestamps everywhere** (`created_at` on users, passkeys, posts, swipes, messages; `last_used_at` on
  passkeys) enable timing correlation. Reduce precision or drop where not needed.

## 2. Network and hosting

- [ ] **P0: IP addresses.** The server (and any reverse proxy or CDN) sees client IPs, which can tie GUIDs to real
  people. Define a no-logging policy, strip IPs at the proxy, and document it. Consider Tor/onion support.
- [ ] **P0: HTTPS only in production.** Passkeys require a secure context outside `localhost`. Set `ORIGIN`
  (and `RP_ID`) and add HSTS. With `ORIGIN` unset, the server derives the expected origin from the `Host` /
  `X-Forwarded-Proto` headers (`originOf()` in `server.js`), which is only acceptable for local development.
- [ ] **P1: The database is unencrypted at rest**, along with its backups. It holds the graph, public keys and
  ciphertext. Encrypt the disk and backups, and restrict access.
- [ ] **P2: Hosting jurisdiction and legal requests.** Document what data exists and what we can be compelled to
  hand over (see section 1).

## 3. Web-app end-to-end encryption limits

- [ ] **P0: The server delivers the code that holds the keys.** A malicious or compromised server can serve
  JavaScript that exfiltrates the vault key, chat key or plaintext. This is the core weakness of web E2E. Options:
  a reproducible, signed build plus a verification browser extension, Subresource Integrity with pinned hashes
  published elsewhere, or native/PWA apps with signed updates.
- [ ] **P0: Peer public keys aren't verified.** Chat keys come from the server (`other_pubkey` in `/api/matches`),
  so a malicious server could swap keys and read or alter chats (man in the middle). Add safety numbers / key
  fingerprints users can compare in person, and/or key transparency.
- [ ] **P1: No forward secrecy.** Each user has one static ECDH key (`public/secure.js`), so leaking it exposes all
  past and future chats. Move to a ratcheting protocol (Signal-style double ratchet) or at least periodic key rotation.
- [ ] **P1: No sender authentication inside a match.** Both parties share one symmetric key per match, so either side
  could forge a message as the other, and the server can drop, reorder or replay ciphertexts. Add per-message
  signatures and sequence numbers.
- [ ] **P1: The server injects system messages.** Edit notices and re-confirm replies are plaintext rows the server
  writes (`systemMessage()` in `server.js`). A malicious server can fake them. Mark them clearly as server-generated,
  or have clients generate/sign them.
- [ ] **P1: Vault rollback.** The server could serve an old vault version (`/api/vault`) to hide contact changes.
  Keep a signed or MACed monotonic version on the client and detect rollbacks.
- [ ] **P1: No AES-GCM additional data.** Encrypted blobs aren't bound to their purpose or owner, so the server could
  swap ciphertexts between fields (e.g. serve one message's ciphertext as another). Bind each blob with AAD such as
  `guid | purpose | match id | message id`.
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

## 5. Accounts, sessions and passkeys

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

- [ ] **P1: The identity server holds every app's keys.** It can't read Bored? data on its own (it never sees the root
  secret), but a compromised id.6j0.org page could derive every app's key for whoever signs in there. Keep it small,
  strictly CSP'd and separately deployed. See the id repo's TODO.
- [ ] **P1: Signing out of Bored? doesn't sign out of id.6j0.org,** so "Continue" signs straight back in without a
  passkey prompt while the identity session lasts. Say so in the UI, and consider a "sign out of all 6j0.org apps" link.
- [ ] **P2: Setup tickets and seen-token IDs live in process memory** (like passkey challenges): a restart between the
  redirect and account creation means signing in again.
- [ ] **P2: No migration between modes.** A local-passkey account can't be linked to a 6j0.org identity (or back).

## 6. Abuse, rate limiting and safety

- [ ] **P0: No rate limiting anywhere.** Account creation, sign-in, posting, swiping, messaging and the public Discover
  endpoints are all unthrottled. That allows spam, Sybil accounts, scraping and denial of service. Add per-IP and
  per-account limits (privacy-preserving where possible, e.g. Privacy Pass-style tokens).
- [ ] **P0: In-person safety.** Users meet anonymous strangers in real life. Add blocking, reporting, safety tips, and
  a way to unmatch and hide your posts from someone. Design reporting so it doesn't break the privacy model
  (e.g. the reporter voluntarily reveals specific decrypted messages).
- [ ] **P1: Anonymous public posts can be abused** (harassment, scams, illegal events). Moderation needs to work without
  identities: think through tooling.
- [ ] **P2: Request size limits** are 512 KB per body and 200 KB per encrypted blob. Review them once real usage is known.

## 7. Data retention and deletion

- [ ] **P1: No account deletion.** Add "delete my account", which removes the user, passkeys, sessions, vault, posts,
  swipes and messages. Decide what happens to the other person's view of shared matches.
- [ ] **P1: No retention policy.** Cancelled posts, declined swipes, finished matches and messages are kept forever.
  Define retention and purge on a schedule.
- [ ] **P2: Seed data.** `seed.js` creates demo accounts with fixed, recognizable GUIDs (`00000000-0000-4000-8000-…`).
  Never run it against production.
