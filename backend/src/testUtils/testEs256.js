// Real ES256 (P-256 ECDSA) test fixtures — P11-T03. Shared by
// verifyJwt.test.js, jwks.test.js, authMiddleware.test.js, and
// socketServer.test.js so each doesn't re-generate its own keypair/signing
// helper. One real keypair, generated once per test process — the actual
// key material never needs to be fixed/reproducible across runs, every
// test only ever compares against keys derived from this same module.
//
// signEs256() produces the JOSE/JWS raw r||s ("ieee-p1363") signature
// format real Supabase-issued tokens use — not the DER encoding
// node:crypto's `sign()` produces by default for EC keys, which is why
// `dsaEncoding` is passed explicitly here too, mirroring
// auth/verifyJwt.js's own verifyJwtAsymmetric.

import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

export const TEST_KID = 'test-key-1';

/** The public half, as a JWK — the exact shape one entry of a real JWKS endpoint's `keys[]` array has. */
export const TEST_JWK = { ...publicKey.export({ format: 'jwk' }), kid: TEST_KID, alg: 'ES256', use: 'sig' };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * @param {object} payload
 * @param {object} [options]
 * @param {object} [options.header] - overrides merged into the default `{ alg: 'ES256', typ: 'JWT', kid: TEST_KID }` header — e.g. a wrong `kid` or `alg` for negative tests
 * @param {import('crypto').KeyObject} [options.signingKey] - defaults to this module's own private key; pass a different EC key to produce a signature that won't verify against TEST_JWK
 */
export function signEs256(payload, { header = {}, signingKey = privateKey } = {}) {
  const headerB64 = b64url({ alg: 'ES256', typ: 'JWT', kid: TEST_KID, ...header });
  const payloadB64 = b64url(payload);
  const signature = crypto.sign('sha256', Buffer.from(`${headerB64}.${payloadB64}`), { key: signingKey, dsaEncoding: 'ieee-p1363' });
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}
