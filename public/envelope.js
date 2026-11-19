// The mail formats: signatures, signed records, sealed envelopes, and channels. Pure functions over keys passed in,
// so the browser (public/secure.js binds them to the signed-in account) and the demo bot (demo.js, one identity per
// demo account) use the same code. Runs unchanged in browsers and in Node 24.
//
// An identity is { guid, chat, sign, inbox, chatKey, signKey }: public keys as JWKs ({ kty, crv, x, y }), the main
// inbox ID, and the private keys as CryptoKeys (ECDH and ECDSA P-256; they can be non-extractable).
//
// - Signature: ECDSA P-256 with SHA-256 over "bored-v1 <kind>\n<text>", so a signature for one kind of thing can't
//   be passed off as another. The 64-byte r || s form WebCrypto uses, in base64url.
// - Signed record (public posts, and private posts inside shares): { body: JSON text, sig, signer }.
// - Sealed envelope: HPKE (RFC 9180, public/hpke.js) to the recipient's chat key, the way Nostr's gift wrap works:
//   HPKE's one-time key hides the sender, and a sender who wants to be known signs the message inside, together with
//   the recipient's key so it can't be sent on to someone else. The recipient's inbox ID is the associated data.
// - Channel: every sealed envelope also gives sender and recipient a shared secret (HPKE's secret export). A request
//   to join opens one; everything after it about that request goes over it, to two inboxes worked out from it.

import { setupS, setupR, importPublicKey } from './hpke.js';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();

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
export const publicJwk = ({ x, y }) => ({ kty: 'EC', crv: 'P-256', x, y });

// ---------- AES-GCM: "iv.ciphertext" in base64url ----------
export async function seal(key, bytesOrString) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = typeof bytesOrString === 'string' ? te.encode(bytesOrString) : bytesOrString;
  return `${b64u.enc(iv)}.${b64u.enc(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data))}`;
}
export async function openBytes(key, sealedStr) {
  const [iv, ct] = String(sealedStr).split('.');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(iv) }, key, b64u.dec(ct)));
}
export const openText = async (key, s) => td.decode(await openBytes(key, s));

// ---------- signatures and signed records ----------
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const signedBytes = (kind, text) => te.encode(`bored-v1 ${kind}\n${text}`);
export async function sign(signKey, kind, text) {
  return b64u.enc(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, signedBytes(kind, text)));
}
export async function verify(signerJwk, kind, text, sig) {
  try {
    const key = await subtle.importKey('jwk', publicJwk(signerJwk), ECDSA, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u.dec(sig), signedBytes(kind, text));
  } catch { return false; }
}
export async function signRecord(id, kind, obj) {
  const body = JSON.stringify(obj);
  return { body, sig: await sign(id.signKey, kind, body), signer: publicJwk(id.sign) };
}
// The record's object if the signature is good (and, given expectedSigner, made by that key), otherwise null.
export async function openRecord(kind, record, expectedSigner) {
  if (!record || typeof record.body !== 'string') return null;
  if (expectedSigner && (expectedSigner.x !== record.signer?.x || expectedSigner.y !== record.signer?.y)) return null;
  if (!(await verify(record.signer, kind, record.body, record.sig))) return null;
  try { return JSON.parse(record.body); } catch { return null; }
}

// ---------- inboxes ----------
// An inbox is a random token only its reader knows; the server files mail under SHA-256(token) and hands it out to
// whoever shows the token. Everyone's main inbox ID is public (to their contacts); channel inboxes are known only to
// the two people on the channel.
export const newInboxToken = () => b64u.enc(globalThis.crypto.getRandomValues(new Uint8Array(32)));
export const inboxIdOf = async (token) => b64u.enc(await subtle.digest('SHA-256', te.encode(token)));

// ---------- sealed envelopes ----------
const SEAL_INFO = 'bored-v1 seal', CHANNEL_EXPORT = 'bored-v1 channel';
const senderText = (msgText, to) => `${to.x}.${to.y}\n${msgText}`;

// Seal msg (an object) to the person with chat public key `to` (JWK), for their inbox `inboxId`.
// from: an identity to say who it's from (GUID and public keys, with a signature); null keeps the sender unknown.
// Returns { body: "enc.ciphertext" for the mail, channel: the secret this opens, for channelOf() }.
export async function sealTo(to, inboxId, msg, from = null) {
  const text = JSON.stringify(msg);
  const inner = { msg: text };
  if (from) {
    inner.sender = { guid: from.guid, chat: publicJwk(from.chat), sign: publicJwk(from.sign), inbox: from.inbox,
      sig: await sign(from.signKey, 'sender', senderText(text, to)) };
  }
  const s = await setupS(await importPublicKey(to), SEAL_INFO);
  const ct = await s.seal(te.encode(inboxId), te.encode(JSON.stringify(inner)));
  return { body: `${b64u.enc(s.enc)}.${b64u.enc(ct)}`, channel: b64u.enc(await s.export(te.encode(CHANNEL_EXPORT), 32)) };
}

// Open a sealed envelope from inbox `inboxId` with identity `me` (chat and chatKey are used): { msg, sender (null
// if anonymous), channel }, or null if it isn't for me, was changed, or names a sender whose signature doesn't
// check out.
export async function openSealed(body, inboxId, me) {
  try {
    const [enc, ct] = String(body).split('.');
    const pk = await importPublicKey(publicJwk(me.chat));
    const r = await setupR(b64u.dec(enc), { privateKey: me.chatKey, publicKey: pk }, SEAL_INFO);
    const inner = JSON.parse(td.decode(await r.open(te.encode(inboxId), b64u.dec(ct))));
    const msg = JSON.parse(inner.msg);
    let sender = null;
    if (inner.sender) {
      const { guid, chat, sign: signer, sig } = inner.sender;
      if (typeof guid !== 'string' || !(await verify(signer, 'sender', senderText(inner.msg, me.chat), sig))) return null;
      sender = { guid, chat: publicJwk(chat), sign: publicJwk(signer) };
    }
    return { msg, sender, channel: b64u.enc(await r.export(te.encode(CHANNEL_EXPORT), 32)) };
  } catch { return null; }
}

// ---------- channels ----------
// A channel's AES key and its two inbox tokens: the one who sealed the envelope that opened it (the opener, e.g.
// the person asking to join) reads `openerInbox`, the recipient (e.g. the host) reads `recipientInbox`.
// All three come from the channel secret with HKDF, so neither side has to send or store anything else.
const channelCache = new Map();
export const clearChannelCache = () => channelCache.clear();
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
  if (channelCache.size > 5000) channelCache.clear();
  channelCache.set(secret, ch);
  return ch;
}
export const sealChannel = async (secret, msg) => seal((await channelOf(secret)).key, JSON.stringify(msg));
export async function openChannel(secret, body) {
  try { return JSON.parse(await openText((await channelOf(secret)).key, body)); } catch { return null; }
}

// What a hello signs: the GUID it claims and the channel, so it can't be replayed on another channel.
export const helloText = async (secret, guid) => `${guid}\n${b64u.enc(await subtle.digest('SHA-256', te.encode(secret)))}`;
