/* Web Push, from the two RFCs, on node:crypto. PURE — no database, no
 * environment, no fetch. Every key it touches arrives as an argument.
 *
 *   · RFC 8291 — Message Encryption for Web Push. ECDH P-256 to a key the
 *     browser generated, HKDF-SHA256 down to a content key and a nonce, one
 *     AES-128-GCM record, `aes128gcm` framing.
 *   · RFC 8292 — VAPID. An ES256 JWT whose audience is the ORIGIN of the
 *     push endpoint, sent beside the raw public key.
 *
 * ── WHY NOT THE `web-push` PACKAGE ──────────────────────────────────────
 *
 * This app ships two dependencies and both are for the headless browser the
 * deep scan needs. Everything else — PostgREST, sessions, tickets, the
 * subtitle converter — is one fetch or one node builtin, deliberately, so a
 * serverless cold start stays honest. `web-push` would be the third, and it
 * is 40 KB of wrapper over primitives node has had since v12.
 *
 * Hand-rolled crypto is normally the wrong answer and it is worth saying why
 * it is not here: this is a KNOWN-ANSWER surface. RFC 8291 §5 publishes a
 * worked example — fixed receiver keys, a fixed sender scalar, a fixed salt
 * and the exact bytes that must come out. `scripts/test-push.js` runs it. An
 * implementation that reproduces the RFC's own vector byte for byte is not
 * "probably right", and a round trip against itself would prove nothing,
 * because a wrong implementation agrees with itself too.
 *
 * This is the same module gfts-helm carries (lib/push-crypto.ts), ported to
 * CommonJS rather than re-derived. Two apps, one proven implementation.
 *
 * ── PURITY IS LOAD-BEARING ──────────────────────────────────────────────
 *
 * The split is not tidiness. If this file read `process.env` or required
 * `lib/db`, the RFC vector could only run inside a configured deployment,
 * and a known-answer test that cannot be run is worse than none: the file
 * still claims one.
 */

'use strict';

const {
  createECDH,
  createHmac,
  createPrivateKey,
  createCipheriv,
  randomBytes,
  sign: signWith
} = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/* --------------------------------------------------------------------------
 * Configuration, and the one mistake that is invisible from the sending side
 * ----------------------------------------------------------------------- */

/* Reserved by RFC 2606 and RFC 6761 precisely so that nothing routes to
   them, which is why Apple treats one as a forged claim. */
const PLACEHOLDER_HOSTS = [
  'example.com', 'example.org', 'example.net', 'example.edu',
  'localhost', 'invalid', 'test'
];

/* Why this REFUSES rather than warns.
 *
 * Apple's push service validates the JWT's `sub` and answers BadJwtToken to
 * a domain that cannot be reached. Google's does not care. So a placeholder
 * subject produces a build where push works perfectly on every Android phone
 * and silently on no iPhone — which gets diagnosed as "iOS doesn't do web
 * push", which is false, and is a cheap thing to believe. A warning in a
 * server log is not read. This returns a sentence naming the CONSEQUENCE,
 * and api/push.js reports it to the settings panel rather than swallowing
 * it, because the person who can fix it is looking at a phone. */
function vapidProblem(keys) {
  const { publicKey, privateKey, subject } = keys || {};
  if (!publicKey || !privateKey)
    return 'CAST_VAPID_PUBLIC_KEY and CAST_VAPID_PRIVATE_KEY are both required; push is off without them.';

  let pub, priv;
  try {
    pub = unb64u(publicKey);
    priv = unb64u(privateKey);
  } catch (e) {
    return 'The VAPID keys are not base64url.';
  }
  if (pub.length !== 65 || pub[0] !== 0x04)
    return 'CAST_VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point starting 0x04; got ' + pub.length + ' bytes.';
  if (priv.length !== 32)
    return 'CAST_VAPID_PRIVATE_KEY must be the raw 32-byte P-256 scalar; got ' + priv.length + ' bytes.';

  if (!subject)
    return 'CAST_VAPID_SUBJECT is unset. Apple rejects a JWT with no sub, so push would work on Android and on nothing else.';

  const s = String(subject).trim().toLowerCase();
  if (s.indexOf('mailto:') !== 0 && s.indexOf('https://') !== 0)
    return 'CAST_VAPID_SUBJECT must start with "mailto:" or "https://"; got "' + subject + '".';

  const host = s.indexOf('mailto:') === 0
    ? (s.slice('mailto:'.length).split('@')[1] || '')
    : (s.slice('https://'.length).split('/')[0] || '');
  if (!host)
    return 'CAST_VAPID_SUBJECT "' + subject + '" names no domain, so there is nobody for a push service to contact about abuse.';
  for (const bad of PLACEHOLDER_HOSTS)
    if (host === bad || host.endsWith('.' + bad))
      return 'CAST_VAPID_SUBJECT "' + subject + '" is a placeholder domain. Apple answers BadJwtToken to it, so push would work on Android and silently on no iPhone.';

  return null;
}

/* --------------------------------------------------------------------------
 * RFC 8292 — the VAPID JWT
 * ----------------------------------------------------------------------- */

/* The `aud` claim is the endpoint's ORIGIN and nothing more of the URL. A
   JWT scoped to the full endpoint would be a bearer token for one device. */
function audienceOf(endpoint) {
  return new URL(endpoint).origin;
}

/* `dsaEncoding: 'ieee-p1363'` is load-bearing. JWS ES256 is the raw r‖s
   pair, 64 bytes; node's default for an EC key is DER. A DER signature here
   parses perfectly, is accepted by nothing, and comes back as a bare 401
   from the push service with no hint which of the several causes it was. */
function vapidJwt(keys, audience, expiresAt) {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({
    aud: audience, exp: expiresAt, sub: keys.subject
  })));
  const signingInput = header + '.' + payload;

  const pub = unb64u(keys.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      /* x and y are read off the public point rather than derived: node's
         JWK import wants them, and deriving them from the scalar would mean
         a point multiply this module has no business doing by hand. */
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
      d: keys.privateKey
    },
    format: 'jwk'
  });

  const signature = signWith('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363'
  });
  return signingInput + '.' + b64u(signature);
}

/* --------------------------------------------------------------------------
 * RFC 8291 — the payload encryption
 * ----------------------------------------------------------------------- */

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/* HKDF-Expand with L ≤ 32, which is every use below: one HMAC, one 0x01. */
const expand = (prk, info, length) =>
  hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

const infoString = (label) =>
  Buffer.concat([Buffer.from(label, 'utf8'), Buffer.from([0])]);

/* Encrypt one payload for one subscription, `aes128gcm`.
 *
 * `recordSize` is a header field, not a chunking decision: a cast
 * notification is a title and a sentence, so the whole payload is one record
 * and the 0x02 delimiter says so. A multi-record path would be code with no
 * caller and no test.
 *
 * `senderPrivateKey` and `salt` are parameters ONLY so the RFC's vector can
 * be reproduced. Both default to fresh randomness, and a caller supplying
 * either outside a test has reused a nonce — the one mistake AES-GCM does
 * not survive. */
function encryptPush(payload, subscriberPublicKey, authSecret, options) {
  const opts = options || {};
  const recordSize = opts.recordSize || 4096;
  const salt = opts.salt || randomBytes(16);

  const ecdh = createECDH('prime256v1');
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey);
  else ecdh.generateKeys();
  const senderPublicKey = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(subscriberPublicKey);

  /* RFC 8291 §3.4. The auth secret is the HKDF SALT for this first extract,
     and the two public keys go into the info in RECEIVER-THEN-SENDER order.
     Swapping them yields a key that decrypts on nothing and errors nowhere:
     the send returns 201 and the phone shows a notification that says
     nothing, or none at all. */
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([
    infoString('WebPush: info'),
    subscriberPublicKey,
    senderPublicKey
  ]);
  const ikm = expand(prkKey, keyInfo, 32);

  const prk = hmac(salt, ikm);
  const contentKey = expand(prk, infoString('Content-Encoding: aes128gcm'), 16);
  const nonce = expand(prk, infoString('Content-Encoding: nonce'), 12);

  /* 0x02 is the LAST-RECORD delimiter. 0x01 says "another record follows",
     and a receiver that believed it would sit waiting for one. */
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(5);
  header.writeUInt32BE(recordSize, 0);
  header.writeUInt8(senderPublicKey.length, 4);

  return {
    body: Buffer.concat([salt, header, senderPublicKey, ciphertext]),
    senderPublicKey,
    salt
  };
}

module.exports = { vapidProblem, audienceOf, vapidJwt, encryptPush, b64u, unb64u };
