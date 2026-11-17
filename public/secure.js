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
//
// Every encrypted value is "iv.ciphertext" in base64url (12-byte IV, AES-GCM).

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

let keys = null; // { guid, vaultKey, chatKey }

export async function loadKeys(guid) {
  try {
    const k = await idbDo('readonly', s => s.get('session'));
    keys = k && k.guid === guid ? k : null;
  } catch { keys = null; }
  return Boolean(keys);
}
export async function clearKeys() {
  keys = null; chatKeys.clear();
  try { await idbDo('readwrite', s => s.delete('session')); } catch {}
}

// Unwrap the vault key with a key-encryption key, decrypt the chat private key, keep both non-extractable.
async function installKeys(guid, kek, wrappedKey, chatPrivkey) {
  const raw = await openBytes(kek, wrappedKey);
  const vaultKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const jwk = JSON.parse(await openText(vaultKey, chatPrivkey));
  const chatKey = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  keys = { guid, vaultKey, chatKey };
  try { await idbDo('readwrite', s => s.put(keys, 'session')); } catch {}
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
  keys = { guid: res.user.guid, vaultKey, chatKey };
  try { await idbDo('readwrite', s => s.put(keys, 'session')); } catch {}
  return res;
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
//   pendingNames: { [iconHash]: nickname } }  (nicknames for inviters I've asked to connect with, applied once they confirm)
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
