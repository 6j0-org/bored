// HPKE, Hybrid Public Key Encryption (RFC 9180), base mode, with one cipher suite:
// DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, and AES-128-GCM (KEM 0x0010, KDF 0x0001, AEAD 0x0001).
//
// This is a straight transcription of the RFC on top of WebCrypto, checked against the RFC's test vectors
// (appendix A.3). It's here because the app has no bundler and the npm HPKE packages come as many module files.
// It runs unchanged in browsers and in Node 24 (globalThis.crypto), so demo.js and the tests use this same file.
//
// Private keys can be non-extractable CryptoKeys: the only thing done with them is ECDH deriveBits.
// Public keys are ECDH P-256 CryptoKeys; enc (the sender's one-time public key) is 65 bytes, uncompressed.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

const KEM_ID = 0x0010, KDF_ID = 0x0001, AEAD_ID = 0x0001;
const N_SECRET = 32, N_K = 16, N_N = 12, N_H = 32;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0; for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const bytes = (b) => b instanceof Uint8Array ? b : typeof b === 'string' ? te.encode(b) : new Uint8Array(b);
// I2OSP: n as a big-endian byte string of length len.
const i2osp = (n, len) => {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0 && n > 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); }
  return out;
};

const KEM_SUITE = concat(te.encode('KEM'), i2osp(KEM_ID, 2));
const HPKE_SUITE = concat(te.encode('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const V1 = te.encode('HPKE-v1');

// ---------- HKDF-SHA256 (RFC 5869), as separate Extract and Expand steps ----------
async function hmac(key, data) {
  // An empty salt means HashLen zero bytes (RFC 5869 2.2); WebCrypto won't import an empty HMAC key.
  const k = await subtle.importKey('raw', key.length ? key : new Uint8Array(N_H), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
const extract = (salt, ikm) => hmac(salt, ikm);
async function expand(prk, info, length) {
  const out = new Uint8Array(length);
  let t = new Uint8Array(0);
  for (let i = 1, done = 0; done < length; i++) {
    t = await hmac(prk, concat(t, info, Uint8Array.of(i)));
    out.set(t.subarray(0, Math.min(t.length, length - done)), done);
    done += t.length;
  }
  return out;
}
const labeledExtract = (suite, salt, label, ikm) => extract(salt, concat(V1, suite, te.encode(label), ikm));
const labeledExpand = (suite, prk, label, info, length) =>
  expand(prk, concat(i2osp(length, 2), V1, suite, te.encode(label), info), length);

// ---------- DHKEM(P-256, HKDF-SHA256) ----------
const serialize = async (publicKey) => new Uint8Array(await subtle.exportKey('raw', publicKey));
const dh = async (privateKey, publicKey) => new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));

async function extractAndExpand(dhSecret, kemContext) {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), 'eae_prk', dhSecret);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, N_SECRET);
}

// ephemeral is for tests only (fixed keys from the RFC); normally a fresh key pair is made for every message.
async function encap(pkR, ephemeral) {
  const e = ephemeral || await subtle.generateKey(ECDH, false, ['deriveBits']);
  const enc = await serialize(e.publicKey);
  const shared = await extractAndExpand(await dh(e.privateKey, pkR), concat(enc, await serialize(pkR)));
  return { shared, enc };
}

async function decap(enc, keyPairR) {
  const pkE = await subtle.importKey('raw', enc, ECDH, false, []);
  return extractAndExpand(await dh(keyPairR.privateKey, pkE), concat(enc, await serialize(keyPairR.publicKey)));
}

// ---------- key schedule and encryption context (mode_base: no PSK) ----------
async function keySchedule(shared, info) {
  const empty = new Uint8Array(0);
  const context = concat(Uint8Array.of(0x00),
    await labeledExtract(HPKE_SUITE, empty, 'psk_id_hash', empty),
    await labeledExtract(HPKE_SUITE, empty, 'info_hash', info));
  const secret = await labeledExtract(HPKE_SUITE, shared, 'secret', empty);
  const key = await subtle.importKey('raw', await labeledExpand(HPKE_SUITE, secret, 'key', context, N_K), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const baseNonce = await labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, N_N);
  const exporterSecret = await labeledExpand(HPKE_SUITE, secret, 'exp', context, N_H);

  let seq = 0;
  const nonce = () => {
    if (seq >= Number.MAX_SAFE_INTEGER) throw new Error('HPKE: message limit reached');
    const n = i2osp(seq++, N_N);
    for (let i = 0; i < N_N; i++) n[i] ^= baseNonce[i];
    return n;
  };
  return {
    seal: async (aad, pt) => new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(), additionalData: bytes(aad) }, key, bytes(pt))),
    open: async (aad, ct) => {
      // The sequence number only moves on after a successful open (RFC 9180 5.2).
      const iv = nonce();
      try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: bytes(aad) }, key, bytes(ct))); }
      catch (e) { seq--; throw e; }
    },
    export: (exporterContext, length) => labeledExpand(HPKE_SUITE, exporterSecret, 'sec', bytes(exporterContext), length),
  };
}

// ---------- public API ----------

// Sender: { enc, seal(aad, pt), export(context, length) }. pkR is the recipient's ECDH P-256 public CryptoKey.
export async function setupS(pkR, info, { ephemeral } = {}) {
  const { shared, enc } = await encap(pkR, ephemeral);
  const { seal, export: exp } = await keySchedule(shared, bytes(info));
  return { enc, seal, export: exp };
}

// Recipient: { open(aad, ct), export(context, length) }. keyPairR is { privateKey, publicKey }; the private key
// can be non-extractable.
export async function setupR(enc, keyPairR, info) {
  const { open, export: exp } = await keySchedule(await decap(bytes(enc), keyPairR), bytes(info));
  return { open, export: exp };
}

// Single-shot encryption: one message per setup.
export async function sealBase(pkR, info, aad, pt) {
  const s = await setupS(pkR, info);
  return { enc: s.enc, ct: await s.seal(aad, pt) };
}
export async function openBase(enc, keyPairR, info, aad, ct) {
  return (await setupR(enc, keyPairR, info)).open(aad, ct);
}

// Import an uncompressed P-256 public key (65 bytes) or a public JWK as an ECDH CryptoKey.
export const importPublicKey = (key) => typeof key === 'object' && !(key instanceof Uint8Array) && key.kty
  ? subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, ext: true }, ECDH, true, [])
  : subtle.importKey('raw', bytes(key), ECDH, true, []);
