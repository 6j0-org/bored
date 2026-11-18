// Bored? client-side security: passkeys, the encrypted vault, and end-to-end encrypted chat.
//
// Keys
// - Each passkey yields a secret via the WebAuthn PRF extension (same passkey + same salt → same 32 bytes).
//   HKDF turns it into a key-encryption key that wraps the account's random 256-bit *vault key*.
//   The server stores one wrapped copy per passkey and never sees the PRF output or the vault key.
// - The vault key encrypts the *vault* (nickname + tags for each contact, and who your private posts are shared with)
//   and your ECDH P-256 *chat private key*. Your chat public key is stored in the clear so matches can reach you.
// - Chat: ECDH(my private, their public) → HKDF(salt = match id) → AES-256-GCM key per match.
//   (Prototype: static keys, so no forward secrecy.)
// - With a 6j0.org identity (server AUTH_MODE=6j0) there are no local passkeys: the identity server hands the
//   page this app's 32-byte *app key* (see the handoff below), and HKDF turns that into the key-encryption key
//   instead. Everything from the vault key down is the same.
// - After sign-in the vault key and chat key are kept in IndexedDB as non-extractable CryptoKeys, so a page
//   reload doesn't need the passkey again. Signing out deletes them.
// - Each account also has an ECDSA P-256 *signing key*, encrypted with the vault key like the chat key, which signs
//   public posts and tells people who sent a message when that should be known.
//
// Every encrypted value is "iv.ciphertext" in base64url (12-byte IV, AES-GCM).
//
// Mail (see "mail" below): everything people send each other is a sealed envelope or a channel message dropped in an
// inbox on the server, which stores only the inbox and the ciphertext, never the sender.
// - Sealed envelope: HPKE (RFC 9180, public/hpke.js) to the recipient's chat key, the way Nostr's gift wrap works:
//   HPKE's one-time key hides the sender, and a sender who wants to be known signs the message inside.
// - Channel: every sealed envelope also gives sender and recipient a shared secret (HPKE's secret export). A request
//   to join opens one; everything after it about that request goes over it, to two inboxes worked out from it.

import { setupS, setupR, importPublicKey } from './hpke.js';

const subtle = crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();

export class PrfUnsupportedError extends Error {
  constructor() { super("This browser or passkey manager can't create the encryption key Bored? needs."); }
}

// ---------- encoding ----------
export const b64u = {
  enc: (buf) => {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec: (str) => {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  },
};

// ---------- AES-GCM helpers ----------
async function seal(key, bytesOrString) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = typeof bytesOrString === 'string' ? te.encode(bytesOrString) : bytesOrString;
  return `${b64u.enc(iv)}.${b64u.enc(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data))}`;
}
async function openBytes(key, sealedStr) {
  const [iv, ct] = String(sealedStr).split('.');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(iv) }, key, b64u.dec(ct)));
}
const openText = async (key, s) => td.decode(await openBytes(key, s));

async function hkdfKey(secret, salt, info, extractable = false) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(salt), info: te.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

// ---------- PRF ----------
let prfSaltCache;
const prfSalt = async () => (prfSaltCache ||= new Uint8Array(await subtle.digest('SHA-256', te.encode('bored-vault-v1'))));
const kekFromPrf = (prf) => hkdfKey(new Uint8Array(prf), 'bored', 'vault-kek-v1');

// true / false when the browser can tell us, null when it can't (we find out during sign-up).
export async function prfSupport() {
  if (!window.isSecureContext || !window.PublicKeyCredential) return false;
  try {
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && 'extension:prf' in caps) return Boolean(caps['extension:prf']);
  } catch {}
  return null;
}

// Ask a specific passkey for its PRF output (used when create() didn't return it, and to unlock before adding a passkey).
async function prfFromGet(allow) {
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), // not sent to the server; this is only to read PRF
    allowCredentials: allow.map(id => ({ type: 'public-key', id: b64u.dec(id) })),
    userVerification: 'required', timeout: 120000,
    extensions: { prf: { eval: { first: await prfSalt() } } },
  } });
  const prf = cred.getClientExtensionResults().prf?.results?.first;
  if (!prf) throw new PrfUnsupportedError();
  return { prf, credentialId: b64u.enc(cred.rawId) };
}

// Run navigator.credentials.create() and return the registration payload plus the PRF output.
// nextStep(label) must resolve after a fresh user tap: browsers like Safari only allow one passkey prompt per tap.
async function createPasskey(opts, exclude = [], nextStep) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: b64u.dec(opts.challenge),
    rp: opts.rp,
    user: { id: b64u.dec(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: exclude.map(id => ({ type: 'public-key', id: b64u.dec(id) })),
    attestation: 'none', timeout: 120000,
    extensions: { prf: { eval: { first: await prfSalt() } } },
  } });
  const ext = cred.getClientExtensionResults();
  if (!ext.prf?.enabled) throw new PrfUnsupportedError();
  const credentialId = b64u.enc(cred.rawId);
  // Some authenticators only return PRF output on get(), so ask once more (after another tap) if needed.
  let prf = ext.prf.results?.first;
  if (!prf) { await nextStep('Confirm your new passkey once more to finish setting up encryption.'); prf = (await prfFromGet([credentialId])).prf; }
  const r = cred.response;
  return {
    prf,
    payload: {
      credentialId,
      clientDataJSON: b64u.enc(r.clientDataJSON),
      authenticatorData: b64u.enc(r.getAuthenticatorData()),
      publicKey: b64u.enc(r.getPublicKey()),
      alg: r.getPublicKeyAlgorithm(),
    },
  };
}

// ---------- key storage (IndexedDB, non-extractable keys) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bored-keys', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', mode), req = fn(tx.objectStore('keys'));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// { guid, vaultKey, chatKey, chatPub, signKey, signPub, inboxId }: the private keys are non-extractable CryptoKeys,
// the public ones JWKs ({ kty, crv, x, y }). signKey, signPub, and inboxId are filled in by ensureKeys().
let keys = null;
const saveKeys = async () => { try { await idbDo('readwrite', s => s.put(keys, 'session')); } catch {} };
const publicJwk = ({ x, y }) => ({ kty: 'EC', crv: 'P-256', x, y });

export async function loadKeys(guid) {
  try {
    const k = await idbDo('readonly', s => s.get('session'));
    keys = k && k.guid === guid ? k : null;
  } catch { keys = null; }
  return Boolean(keys);
}
export async function clearKeys() {
  keys = null; chatKeys.clear(); channelCache.clear();
  try { await idbDo('readwrite', s => s.delete('session')); } catch {}
}

// Unwrap the vault key with a key-encryption key, decrypt the chat private key, keep both non-extractable.
async function installKeys(guid, kek, wrappedKey, chatPrivkey) {
  const raw = await openBytes(kek, wrappedKey);
  const vaultKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const jwk = JSON.parse(await openText(vaultKey, chatPrivkey));
  const chatKey = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  keys = { guid, vaultKey, chatKey, chatPub: publicJwk(jwk) };
  await saveKeys();
}

// ---------- account flows ----------
// Each takes the app's api(path, opts) helper. nextStep(message) is the app's "tap to continue" prompt.

// New account: make a vault key and chat key pair, wrap the vault key with kek, POST everything to path.
async function registerAccount(api, path, kek, extra) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const vaultKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const { kty, crv, x, y } = await subtle.exportKey('jwk', pair.publicKey);
  const res = await api(path, { method: 'POST', body: {
    ...extra,
    wrappedKey: await seal(kek, raw),
    chatPubkey: { kty, crv, x, y },
    chatPrivkey: await seal(vaultKey, JSON.stringify(await subtle.exportKey('jwk', pair.privateKey))),
    vault: await seal(vaultKey, JSON.stringify(emptyVault())),
  } });
  raw.fill(0);
  const chatKey = await subtle.importKey('jwk', await subtle.exportKey('jwk', pair.privateKey),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  keys = { guid: res.user.guid, vaultKey, chatKey, chatPub: { kty, crv, x, y } };
  await saveKeys();
  return res;
}

// After any sign-in or reload, once the vault is loaded: make sure this browser has the signing key, its own chat
// public key, and a main inbox. Accounts made before these existed get them here, once: the server keeps the first
// signing key and inbox any device uploads, and the vault keeps the first inbox token.
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
export async function ensureKeys(api) {
  if (keys.chatPub && keys.signKey && keys.inboxId && vault.data.inbox) return;
  let mine = await api('/api/me/keys');
  const put = async (body) => {
    try { await api('/api/me/keys', { method: 'PUT', body }); }
    catch (e) { if (e.status !== 409) throw e; } // another device was first
    mine = await api('/api/me/keys');
  };
  if (!mine.signPrivkey) {
    const pair = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    await put({
      signPubkey: publicJwk(await subtle.exportKey('jwk', pair.publicKey)),
      signPrivkey: await seal(keys.vaultKey, JSON.stringify(await subtle.exportKey('jwk', pair.privateKey))),
    });
  }
  const jwk = JSON.parse(await openText(keys.vaultKey, mine.signPrivkey));
  keys.signKey = await subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
  keys.signPub = publicJwk(jwk);
  keys.chatPub ||= publicJwk(mine.chatPubkey);

  // The token goes into the vault before its ID goes to the server, so it can't be lost in between.
  if (!vault.data.inbox) await vault.update(api, (d) => { d.inbox ||= newInboxToken(); });
  const inboxId = await inboxIdOf(vault.data.inbox);
  if (mine.inboxId !== inboxId) {
    if (mine.inboxId) throw new Error("This account's inbox doesn't match this device. Please sign out and in again.");
    await put({ inboxId });
  }
  keys.inboxId = inboxId;
  await saveKeys();
}

export async function createAccount(api, nextStep) {
  const opts = await api('/api/passkey/register/options', { method: 'POST' });
  const { prf, payload } = await createPasskey(opts, [], nextStep);
  return registerAccount(api, '/api/passkey/register/verify', await kekFromPrf(prf), payload);
}

export async function signIn(api) {
  const opts = await api('/api/passkey/login/options', { method: 'POST' });
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: b64u.dec(opts.challenge), rpId: opts.rpId, userVerification: 'required', timeout: 120000,
    extensions: { prf: { eval: { first: await prfSalt() } } },
  } });
  const prf = cred.getClientExtensionResults().prf?.results?.first;
  if (!prf) throw new PrfUnsupportedError();
  const r = cred.response;
  const res = await api('/api/passkey/login/verify', { method: 'POST', body: {
    credentialId: b64u.enc(cred.rawId),
    clientDataJSON: b64u.enc(r.clientDataJSON),
    authenticatorData: b64u.enc(r.authenticatorData),
    signature: b64u.enc(r.signature),
    userHandle: r.userHandle ? b64u.enc(r.userHandle) : undefined,
  } });
  await installKeys(res.user.guid, await kekFromPrf(prf), res.wrappedKey, res.chatPrivkey);
  vault.reset(res.vault);
  return res;
}

// ---------- 6j0.org identity (server AUTH_MODE=6j0) ----------
// 1. startIdSignIn: make an ephemeral ECDH P-256 key pair and a random nonce, keep them in IndexedDB, and go to
//    <idOrigin>/authorize?app=<idApp>&nonce=<nonce>&epk=<x>.<y>.
// 2. The identity server signs the browser in (one passkey for all 6j0.org apps), derives this app's key, encrypts it
//    to our public key, and sends the browser back to this app's origin with
//    #id_token=<signed token>&epk=<its public key>&key=<iv.ciphertext>&state=<nonce>.
// 3. finishIdSignIn: check the nonce, decrypt the app key, have the server verify the token, then unlock the vault
//    (or create the account on first visit). The fragment never reaches any server.
const kekFromAppKey = (appKey) => hkdfKey(appKey, 'bored', 'vault-kek-6j0-v1');
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export const hasIdCallback = () => new URLSearchParams(location.hash.slice(1)).has('id_token');

export async function startIdSignIn(config) {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const { x, y } = await subtle.exportKey('jwk', pair.publicKey);
  const nonce = b64u.enc(crypto.getRandomValues(new Uint8Array(24)));
  await idbDo('readwrite', s => s.put({ nonce, privateKey: pair.privateKey, app: config.idApp, created: Date.now() }, 'pending'));
  const params = new URLSearchParams({ app: config.idApp, nonce, epk: `${x}.${y}` });
  location.assign(`${config.idOrigin}/authorize?${params}`);
}

export async function finishIdSignIn(api) {
  const frag = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search); // drop the token and key from the address bar
  let pending = null;
  try { pending = await idbDo('readonly', s => s.get('pending')); await idbDo('readwrite', s => s.delete('pending')); } catch {}
  if (!pending || pending.nonce !== frag.get('state') || Date.now() - pending.created > PENDING_MAX_AGE_MS)
    throw new Error('That sign-in link expired or was started somewhere else. Please sign in again.');

  const [x, y] = String(frag.get('epk') || '').split('.');
  const peer = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, pending.privateKey, 256);
  const appKey = await openBytes(await hkdfKey(shared, pending.nonce, `6j0/v1/handoff/${pending.app}`), frag.get('key'));
  const kek = await kekFromAppKey(appKey);
  appKey.fill(0);

  const res = await api('/api/id/login', { method: 'POST', body: { token: frag.get('id_token'), nonce: pending.nonce } });
  if (res.setup) return { ...(await registerAccount(api, '/api/id/register', kek, { setup: res.setup })), created: true };
  await installKeys(res.user.guid, kek, res.wrappedKey, res.chatPrivkey);
  vault.reset(res.vault);
  return res;
}

// ---------- demo mode (server DEMO=1) ----------
// No sign-in: a new account with a random key-encryption key that's thrown away (the server ignores the wrapped key).
// The keys stay in IndexedDB like after any sign-in; once they're gone, the browser starts over with a new account.
export async function createDemoAccount(api) {
  const kek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const res = await registerAccount(api, '/api/demo/register', kek, {});
  vault.reset({ data: null, version: 0 });
  return res;
}

// Add another passkey: unlock the vault key with an existing passkey, create the new one, wrap the key for it.
export async function addPasskey(api, nextStep) {
  const opts = await api('/api/passkey/add/options', { method: 'POST' });
  const existing = opts.existing.map(p => p.credentialId);
  const unlock = await prfFromGet(existing);
  const wrapped = opts.existing.find(p => p.credentialId === unlock.credentialId).wrappedKey;
  const raw = await openBytes(await kekFromPrf(unlock.prf), wrapped);
  await nextStep('Confirmed. Now create the new passkey: on this device, your phone (scan the QR code), or a security key. It must support PRF: some password managers, including Bitwarden, do not.', 'Create new passkey');
  const { prf, payload } = await createPasskey(opts, existing, nextStep);
  const body = { ...payload, wrappedKey: await seal(await kekFromPrf(prf), raw) };
  raw.fill(0);
  return api('/api/passkey/add/verify', { method: 'POST', body });
}

// ---------- vault: your private names for yourself and your contacts ----------
// { v: 1, contacts: { [guid]: { nickname, tags: [], added } },
//   audiences: { [eventId]: { groups: [tag], contacts: [guid] } },  (who each of my private posts is shared with)
//   prefs: { distanceUnit: 'km' | 'mi' },  (settings from Profile)
//   invites: { [inviteId]: { token, key, name } },  (my invitation links, so I can share them again; the server has
//     only hashes. name is the nickname I suggested; key decrypts the nicknames people suggest when they ask)
//   pendingNames: { [iconHash]: nickname },  (nicknames for inviters I've asked to connect with, applied once they confirm)
//   inbox: token }  (my main inbox's read token; its SHA-256 is public, see "mail" below)
const emptyVault = () => ({ v: 1, contacts: {}, audiences: {} });

export const vault = {
  data: emptyVault(),
  version: 0,
  loaded: false,
  _sealed: null,
  reset({ data, version }) { this._sealed = data; this.version = version; this.loaded = false; },
  async load(api) {
    if (!this._sealed) { const r = await api('/api/vault'); this._sealed = r.data; this.version = r.version; }
    this.data = this._sealed ? JSON.parse(await openText(keys.vaultKey, this._sealed)) : emptyVault();
    this.data.contacts ||= {}; this.data.audiences ||= {};
    this._sealed = null; this.loaded = true;
    return this.data;
  },
  // mutate(data) changes the vault in place; on a conflict with another device, re-read and re-apply.
  async update(api, mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      mutate(this.data);
      try {
        const r = await api('/api/vault', { method: 'PUT', body: { data: await seal(keys.vaultKey, JSON.stringify(this.data)), version: this.version } });
        this.version = r.version;
        return this.data;
      } catch (e) {
        if (!/another device/.test(e.message)) throw e;
        this._sealed = null; await this.load(api);
      }
    }
    throw new Error("Couldn't save. Please try again.");
  },
};

export const hasKeys = () => Boolean(keys);

// ---------- invitations ----------
// Each invitation link carries a random AES key in its #fragment, next to the token. The fragment never reaches a
// server, so the person who opens the link can send the inviter their suggested nickname encrypted with it, and
// the server, which only stores and relays the ciphertext, can't read it.
export const newInviteKey = () => b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
const inviteKey = (k) => subtle.importKey('raw', b64u.dec(k), 'AES-GCM', false, ['encrypt', 'decrypt']);
export const sealForInvite = async (k, text) => seal(await inviteKey(k), text);
export async function openForInvite(k, sealedStr) {
  try { return await openText(await inviteKey(k), sealedStr); } catch { return null; }
}
// SHA-1 of a GUID in hex: the server's `icon` for someone (see iconHash in server.js), so a GUID can be matched to an icon.
export const sha1Hex = async (s) => [...new Uint8Array(await subtle.digest('SHA-1', te.encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');

// ---------- E2E chat ----------
const chatKeys = new Map(); // matchId -> AES key

async function chatKeyFor(matchId, peerJwk) {
  if (chatKeys.has(matchId)) return chatKeys.get(matchId);
  if (!peerJwk) throw new Error("This person's chat key is missing, so messages can't be encrypted.");
  const peer = await subtle.importKey('jwk', peerJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, keys.chatKey, 256);
  const key = await hkdfKey(shared, `match:${matchId}`, 'bored-chat-v1');
  chatKeys.set(matchId, key);
  return key;
}

export async function encryptMessage(matchId, peerJwk, text) {
  return seal(await chatKeyFor(matchId, peerJwk), text);
}

export async function decryptMessage(matchId, peerJwk, sealedStr) {
  try { return await openText(await chatKeyFor(matchId, peerJwk), sealedStr); }
  catch { return null; } // unreadable (e.g. corrupted); caller shows a placeholder
}

// ---------- signatures ----------
// ECDSA P-256 with SHA-256 over "bored-v1 <kind>\n<text>", so a signature for one kind of thing can't be passed off
// as another. Signatures are the 64-byte r || s form WebCrypto uses, in base64url.
const signedBytes = (kind, text) => te.encode(`bored-v1 ${kind}\n${text}`);
export const myPublicKeys = () => ({ guid: keys.guid, chat: keys.chatPub, sign: keys.signPub, inbox: keys.inboxId });

export async function sign(kind, text) {
  return b64u.enc(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.signKey, signedBytes(kind, text)));
}
export async function verify(signerJwk, kind, text, sig) {
  try {
    const key = await subtle.importKey('jwk', publicJwk(signerJwk), ECDSA, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u.dec(sig), signedBytes(kind, text));
  } catch { return false; }
}

// A signed public record, e.g. a public post: { body: JSON text, sig, signer: signing public key }.
export async function signRecord(kind, obj) {
  const body = JSON.stringify(obj);
  return { body, sig: await sign(kind, body), signer: keys.signPub };
}
// The record's object if the signature is good (and, given expectedSigner, made by that key), otherwise null.
export async function openRecord(kind, record, expectedSigner) {
  if (!record || typeof record.body !== 'string') return null;
  if (expectedSigner && (expectedSigner.x !== record.signer?.x || expectedSigner.y !== record.signer?.y)) return null;
  if (!(await verify(record.signer, kind, record.body, record.sig))) return null;
  try { return JSON.parse(record.body); } catch { return null; }
}

// ---------- mail ----------
// An inbox is a random token only its reader knows; the server files mail under SHA-256(token) and hands it out to
// whoever shows the token. Everyone's main inbox ID is public (to their contacts); channel inboxes are known only to
// the two people on the channel.
export const newInboxToken = () => b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
export const inboxIdOf = async (token) => b64u.enc(await subtle.digest('SHA-256', te.encode(token)));

const SEAL_INFO = 'bored-v1 seal', CHANNEL_EXPORT = 'bored-v1 channel';
// What a known sender signs: the message and the recipient's chat key, so it can't be sent on to someone else.
const senderText = (msgText, to) => `${to.x}.${to.y}\n${msgText}`;

// Seal msg (an object) to the person with chat public key `to` (JWK), for their inbox `inboxId`.
// identify: true adds who it's from (GUID and public keys) with a signature; otherwise the recipient can't tell.
// Returns { body: "enc.ciphertext" for the mail, channel: the secret this opens, for channelOf() }.
export async function sealTo(to, inboxId, msg, { identify = false } = {}) {
  const text = JSON.stringify(msg);
  const inner = { msg: text };
  if (identify) inner.sender = { ...myPublicKeys(), sig: await sign('sender', senderText(text, to)) };
  const s = await setupS(await importPublicKey(to), SEAL_INFO);
  const ct = await s.seal(te.encode(inboxId), te.encode(JSON.stringify(inner)));
  return { body: `${b64u.enc(s.enc)}.${b64u.enc(ct)}`, channel: b64u.enc(await s.export(te.encode(CHANNEL_EXPORT), 32)) };
}

// Open a sealed envelope from my inbox `inboxId`: { msg, sender (null if anonymous), channel }, or null if it isn't
// for me, was changed, or names a sender whose signature doesn't check out.
export async function openSealed(body, inboxId) {
  try {
    const [enc, ct] = String(body).split('.');
    const pk = await importPublicKey(keys.chatPub);
    const r = await setupR(b64u.dec(enc), { privateKey: keys.chatKey, publicKey: pk }, SEAL_INFO);
    const inner = JSON.parse(td.decode(await r.open(te.encode(inboxId), b64u.dec(ct))));
    const msg = JSON.parse(inner.msg);
    let sender = null;
    if (inner.sender) {
      const { guid, chat, sign: signer, sig } = inner.sender;
      if (typeof guid !== 'string' || !(await verify(signer, 'sender', senderText(inner.msg, keys.chatPub), sig))) return null;
      sender = { guid, chat: publicJwk(chat), sign: publicJwk(signer) };
    }
    return { msg, sender, channel: b64u.enc(await r.export(te.encode(CHANNEL_EXPORT), 32)) };
  } catch { return null; }
}

// A channel's AES key and its two inbox tokens: the one who sealed the envelope that opened it (the opener, e.g.
// the person asking to join) reads `openerInbox`, the recipient (e.g. the host) reads `recipientInbox`.
// All three come from the channel secret with HKDF, so neither side has to send or store anything else.
const channelCache = new Map();
export async function channelOf(secret) {
  if (channelCache.has(secret)) return channelCache.get(secret);
  const base = await subtle.importKey('raw', b64u.dec(secret), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const bits = async (info) => b64u.enc(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, base, 256));
  const ch = {
    key: await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode('bored-v1 channel key') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    openerInbox: await bits('bored-v1 channel opener inbox'),
    recipientInbox: await bits('bored-v1 channel recipient inbox'),
  };
  channelCache.set(secret, ch);
  return ch;
}
export const sealChannel = async (secret, msg) => seal((await channelOf(secret)).key, JSON.stringify(msg));
export async function openChannel(secret, body) {
  try { return JSON.parse(await openText((await channelOf(secret)).key, body)); } catch { return null; }
}
