// RFC 9180 appendix A.3.1: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
import { setupS, setupR, sealBase, openBase } from '../../public/hpke.js';
import assert from 'node:assert/strict';
const subtle = crypto.subtle;
const hex = (h) => Uint8Array.from(h.match(/../g) || [], b => parseInt(b, 16));
const toHex = (b) => Buffer.from(b).toString('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
async function pair(pkm, skm, extractable) {
  const pk = hex(pkm), x = b64u(pk.slice(1, 33)), y = b64u(pk.slice(33)), d = b64u(hex(skm));
  return {
    privateKey: await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d }, ECDH, extractable, ['deriveBits']),
    publicKey: await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y }, ECDH, true, []),
  };
}
const V = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  pkEm: '04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4',
  skEm: '4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb',
  pkRm: '04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0',
  skRm: 'f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2',
  enc: '04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  enc_by_seq: {
    0: ['436f756e742d30', '5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434'],
    1: ['436f756e742d31', 'fa6f037b47fc21826b610172ca9637e82d6e5801eb31cbd3748271affd4ecb06646e0329cbdf3c3cd655b28e82'],
    2: ['436f756e742d32', '895cabfac50ce6c6eb02ffe6c048bf53b7f7be9a91fc559402cbc5b8dcaeb52b2ccc93e466c28fb55fed7a7fec'],
    4: ['436f756e742d34', '8787491ee8df99bc99a246c4b3216d3d57ab5076e18fa27133f520703bc70ec999dd36ce042e44f0c3169a6a8f'],
    255: ['436f756e742d323535', '2ad71c85bf3f45c6eca301426289854b31448bcf8a8ccb1deef3ebd87f60848aa53c538c30a4dac71d619ee2cd'],
    256: ['436f756e742d323536', '10f179686aa2caec1758c8e554513f16472bd0a11e2a907dde0b212cbe87d74f367f8ffe5e41cd3e9962a6afb2'],
  },
  exports: [
    ['', '5e9bc3d236e1911d95e65b576a8a86d478fb827e8bdfe77b741b289890490d4d'],
    ['00', '6cff87658931bda83dc857e6353efe4987a201b849658d9b047aab4cf216e796'],
    ['54657374436f6e74657874', 'd8f1ea7942adbba7412c6d431c62d01371ea476b823eb697e1f6e6cae1dab85a'],
  ],
};

const eph = await pair(V.pkEm, V.skEm, false);
const rcp = await pair(V.pkRm, V.skRm, false); // non-extractable recipient key
const s = await setupS(rcp.publicKey, hex(V.info), { ephemeral: eph });
const r = await setupR(s.enc, rcp, hex(V.info));
assert.equal(toHex(s.enc), V.enc, 'enc');

let checked = 0;
for (let seq = 0; seq <= 256; seq++) {
  const want = V.enc_by_seq[seq];
  const aad = want ? hex(want[0]) : new Uint8Array(0);
  const ct = await s.seal(aad, hex(V.pt));
  if (want) { assert.equal(toHex(ct), want[1], `ct seq ${seq}`); checked++; }
  assert.equal(toHex(await r.open(aad, ct)), V.pt, `open seq ${seq}`);
}
for (const [ctx, want] of V.exports) {
  assert.equal(toHex(await s.export(hex(ctx), 32)), want, `sender export ${ctx}`);
  assert.equal(toHex(await r.export(hex(ctx), 32)), want, `recipient export ${ctx}`);
}
console.log(`RFC 9180 A.3.1: enc, ${checked} encryptions, and ${V.exports.length} exports match`);

// Round trip with fresh keys, a wrong key, a wrong aad, and a failed open not moving the sequence number on.
const me = await subtle.generateKey(ECDH, false, ['deriveBits']);
const other = await subtle.generateKey(ECDH, false, ['deriveBits']);
const { enc, ct } = await sealBase(me.publicKey, 'bored-v1 seal', 'inbox', 'hello');
assert.equal(new TextDecoder().decode(await openBase(enc, me, 'bored-v1 seal', 'inbox', ct)), 'hello');
await assert.rejects(openBase(enc, other, 'bored-v1 seal', 'inbox', ct), 'wrong key');
await assert.rejects(openBase(enc, me, 'bored-v1 seal', 'other inbox', ct), 'wrong aad');
await assert.rejects(openBase(enc, me, 'bored-v1 join', 'inbox', ct), 'wrong info');
const s2 = await setupS(me.publicKey, 'x'), r2 = await setupR(s2.enc, me, 'x');
const c0 = await s2.seal('', 'a'), c1 = await s2.seal('', 'b');
await assert.rejects(r2.open('', c1), 'out of order');
assert.equal(new TextDecoder().decode(await r2.open('', c0)), 'a');
assert.equal(new TextDecoder().decode(await r2.open('', c1)), 'b');
console.log('Round trips with non-extractable keys: ok');
