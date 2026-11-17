// Mints a YouTube Embedded Player token (`embed_config={"enc": ...}`) the same
// way our server does: an HPKE-sealed JSON payload, encrypted to the
// primary key of YouTube's public Tink keyset, in Tink's wire format.
//
// Run directly to print one token:
//   YT_EMBED_API_KEY=... node mintToken.mjs <videoId> [ip]
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';

const keysetUrl =
  'https://www.youtube.com/.well-known/embeds/encryption/rcat/youtube-public-keyset.tink.json';

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

// Minimal protobuf reading, enough for Tink's HpkePublicKey message:
//   1: version (varint), 2: params (HpkeParams), 3: public_key (bytes)
// and HpkeParams: 1: kem, 2: kdf, 3: aead (varints).
const readVarint = r => {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const b = r.bytes[r.offset++];
    if (b === undefined) throw new Error('truncated protobuf');
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return value >>> 0;
  }
  throw new Error('overlong varint');
};

const readFields = bytes => {
  const r = { bytes, offset: 0 };
  const fields = new Map();
  while (r.offset < bytes.length) {
    const tag = readVarint(r);
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      fields.set(field, readVarint(r));
    } else if (wireType === 2) {
      const length = readVarint(r);
      fields.set(field, bytes.subarray(r.offset, r.offset + length));
      r.offset += length;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
  }
  return fields;
};

let cachedKey = null;

export async function getYouTubePublicKey() {
  if (cachedKey) return cachedKey;
  const res = await fetch(keysetUrl);
  if (!res.ok) throw new Error(`keyset fetch failed: HTTP ${res.status}`);
  const keyset = await res.json();
  const primary = keyset.key.find(k => k.keyId === keyset.primaryKeyId);
  if (!primary || primary.status !== 'ENABLED' || primary.outputPrefixType !== 'TINK') {
    throw new Error('unexpected primary key in YouTube keyset');
  }
  const key = readFields(Buffer.from(primary.keyData.value, 'base64'));
  const params = readFields(key.get(2));
  // X25519 / HKDF-SHA256 / AES-256-GCM in Tink's enum numbering.
  if (params.get(1) !== 1 || params.get(2) !== 1 || params.get(3) !== 2) {
    throw new Error('unexpected HPKE params in YouTube keyset');
  }
  const publicKeyBytes = new Uint8Array(key.get(3));
  cachedKey = { keyId: keyset.primaryKeyId, publicKeyBytes };
  return cachedKey;
}

const base64Url = bytes =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

export async function mintToken({ apiKey, videoId, ip }) {
  const { keyId, publicKeyBytes } = await getYouTubePublicKey();
  const recipientPublicKey = await suite.kem.importKey('raw', publicKeyBytes.buffer);
  const sender = await suite.createSenderContext({ recipientPublicKey });
  const payload = {
    apiKey,
    ts: Math.floor(Date.now() / 1000),
    ip,
    contentType: 1,
    contentIds: [videoId],
    pageType: 1,
    version: 2,
    contentFilter: 2,
  };
  const ciphertext = new Uint8Array(
    await sender.seal(new TextEncoder().encode(JSON.stringify(payload)).buffer),
  );
  const enc = new Uint8Array(sender.enc);
  // Tink wire format: 0x01, 4-byte big-endian key id, HPKE enc, ciphertext.
  const out = new Uint8Array(5 + enc.length + ciphertext.length);
  out[0] = 0x01;
  new DataView(out.buffer).setUint32(1, keyId, false);
  out.set(enc, 5);
  out.set(ciphertext, 5 + enc.length);
  return base64Url(out);
}

export async function getPublicIp() {
  const res = await fetch('https://checkip.amazonaws.com');
  return (await res.text()).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apiKey = process.env.YT_EMBED_API_KEY;
  if (!apiKey) throw new Error('set YT_EMBED_API_KEY');
  const [videoId, ip] = process.argv.slice(2);
  if (!videoId) throw new Error('usage: node mintToken.mjs <videoId> [ip]');
  console.log(await mintToken({ apiKey, videoId, ip: ip ?? (await getPublicIp()) }));
}
