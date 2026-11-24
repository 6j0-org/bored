// Web Push: delivers notifications through the browser vendors' push services (RFC 8030), with the message
// encrypted end to end for the device (RFC 8291, aes128gcm) and this server identified by a VAPID key (RFC 8292).
// Uses node:crypto only. The push services see when a notification is sent and to which device, but not its text.
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, sign } from 'node:crypto';
import { db } from './db.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// This server's VAPID key pair (P-256), made on first use and kept in the database, so subscriptions survive restarts.
let vapid;
function vapidJwk() {
  if (vapid) return vapid;
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'vapid'`).get();
  if (row) return (vapid = JSON.parse(row.value));
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('vapid', ?)`).run(JSON.stringify(jwk));
  return (vapid = jwk);
}

// The public key browsers subscribe with (applicationServerKey): an uncompressed P-256 point, base64url.
export function vapidPublicKey() {
  const { x, y } = vapidJwk();
  return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]));
}

// Authorization header for one request: a short-lived ES256 JWT for the push service's origin.
// subject is a contact URL for the push service operators (mailto: or https:).
function vapidAuth(endpoint, subject) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: vapidJwk(), format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapidPublicKey()}`;
}

// RFC 8291: the request body for `payload`, encrypted to a subscription's keys (p256dh, auth) as one aes128gcm
// record. salt and ecdh (the server's one-off key pair) are only passed in by tests.
function encryptPayload(payload, { p256dh, auth }, { salt = randomBytes(16), ecdh } = {}) {
  const uaPublic = Buffer.from(p256dh, 'base64url'), authSecret = Buffer.from(auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Bad subscription keys');
  if (!ecdh) { ecdh = createECDH('prime256v1'); ecdh.generateKeys(); }
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const hkdf = (ikm, salt, info, len) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len));
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02: last (and only) record, no padding
  if (plain.length + 16 > 4096) throw new Error('Push payload too large');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Only the browser vendors' push services, so a client can't make this server send requests anywhere else.
// PUSH_HOSTS (comma-separated) adds more, e.g. for a self-hosted push service.
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com',
  ...String(process.env.PUSH_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean)];
export function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

// Send one notification. Resolves to the push service's HTTP status (201 = accepted; 404/410 = subscription gone).
// topic (up to 32 URL-safe characters) lets the service replace an undelivered notification with a newer one.
export async function sendPush(sub, payload, { subject, ttl = 24 * 3600, urgency = 'normal', topic } = {}) {
  const body = encryptPayload(JSON.stringify(payload), sub);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(sub.endpoint, subject),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(ttl), Urgency: urgency,
      ...(topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic) ? { Topic: topic } : {}),
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  return r.status;
}
