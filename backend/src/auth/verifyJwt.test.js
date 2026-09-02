import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyJwt, verifyJwtAsymmetric } from './verifyJwt.js';
import { TEST_KID, TEST_JWK, signEs256 } from '../testUtils/testEs256.js';

// Test-only fixture — not a real Supabase secret, never used outside this file.
const TEST_SECRET = 'test-secret-fixture-not-a-real-supabase-jwt-secret';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken({ secret = TEST_SECRET, header = { alg: 'HS256', typ: 'JWT' }, payload, rawSignature } = {}) {
  const headerB64 = b64url(header);
  const payloadB64 = b64url(payload);
  const signatureB64 =
    rawSignature !== undefined
      ? rawSignature
      : crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function futureExp(seconds = 3600) {
  return Math.floor(Date.now() / 1000) + seconds;
}

function pastExp(seconds = 3600) {
  return Math.floor(Date.now() / 1000) - seconds;
}

test('missing token is rejected', () => {
  const result = verifyJwt('', TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_token');
});

test('non-string token is rejected', () => {
  const result = verifyJwt(undefined, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_token');
});

test('malformed token (wrong number of segments) is rejected', () => {
  const result = verifyJwt('not.a.valid.jwt.at.all', TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'malformed_token');
});

test('malformed token (invalid base64/JSON in header) is rejected', () => {
  const result = verifyJwt('not-valid-base64json.eyJzdWIiOiJ4In0.abc', TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'malformed_token');
});

test('token signed with a different secret is rejected as invalid signature', () => {
  const token = makeToken({
    secret: 'a-completely-different-secret',
    payload: { sub: 'user-1', exp: futureExp() },
  });
  const result = verifyJwt(token, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('tampered signature is rejected', () => {
  const token = makeToken({ payload: { sub: 'user-1', exp: futureExp() }, rawSignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  const result = verifyJwt(token, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('expired token is rejected even with a valid signature', () => {
  const token = makeToken({ payload: { sub: 'user-1', exp: pastExp() } });
  const result = verifyJwt(token, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired_token');
});

test('token with an unexpected algorithm is rejected, regardless of a valid-looking signature', () => {
  const token = makeToken({ header: { alg: 'none', typ: 'JWT' }, payload: { sub: 'user-1', exp: futureExp() } });
  const result = verifyJwt(token, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'unsupported_algorithm');
});

test('token with no subject claim is rejected', () => {
  const token = makeToken({ payload: { exp: futureExp() } });
  const result = verifyJwt(token, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_subject');
});

test('valid token is accepted and its payload is returned', () => {
  const token = makeToken({ payload: { sub: 'user-42', exp: futureExp(), role: 'authenticated' } });
  const result = verifyJwt(token, TEST_SECRET);
  assert.equal(result.valid, true);
  assert.equal(result.payload.sub, 'user-42');
});

test('valid token with no exp claim at all is accepted (no expiry to violate)', () => {
  const token = makeToken({ payload: { sub: 'user-42' } });
  const result = verifyJwt(token, TEST_SECRET);
  assert.equal(result.valid, true);
});

// ---- verifyJwtAsymmetric (ES256/JWKS) — P11-T03 ----
// Real ES256 signatures throughout (testUtils/testEs256.js), not HS256
// fixtures reused with a different label — the whole point of this
// function is verifying a genuinely different signature scheme.

function fakeGetKey(jwk = TEST_JWK) {
  return async (kid) => (kid === jwk.kid ? jwk : null);
}

test('verifyJwtAsymmetric: missing token is rejected', async () => {
  const result = await verifyJwtAsymmetric('', fakeGetKey());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_token');
});

test('verifyJwtAsymmetric: malformed token (wrong number of segments) is rejected', async () => {
  const result = await verifyJwtAsymmetric('not.a.valid.jwt.at.all', fakeGetKey());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'malformed_token');
});

test('verifyJwtAsymmetric: a real, correctly-signed ES256 token is accepted', async () => {
  const token = signEs256({ sub: 'user-42', exp: futureExp() });
  const result = await verifyJwtAsymmetric(token, fakeGetKey());
  assert.equal(result.valid, true);
  assert.equal(result.payload.sub, 'user-42');
});

test('verifyJwtAsymmetric: an HS256 token is rejected as unsupported_algorithm — the mode is chosen by the caller, never by trusting the token', async () => {
  const token = makeToken({ payload: { sub: 'user-1', exp: futureExp() } }); // HS256, from this file's own makeToken()
  const result = await verifyJwtAsymmetric(token, fakeGetKey());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'unsupported_algorithm');
});

test('verifyJwtAsymmetric: a token with no kid is rejected before ever calling getKey', async () => {
  let called = false;
  const getKey = async () => {
    called = true;
    return TEST_JWK;
  };
  const token = signEs256({ sub: 'user-1', exp: futureExp() }, { header: { kid: undefined } });
  const result = await verifyJwtAsymmetric(token, getKey);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_key_id');
  assert.equal(called, false);
});

test('verifyJwtAsymmetric: an unrecognized kid (getKey resolves null) is rejected', async () => {
  const token = signEs256({ sub: 'user-1', exp: futureExp() }, { header: { kid: 'some-other-key' } });
  const result = await verifyJwtAsymmetric(token, fakeGetKey());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'unknown_key_id');
});

test('verifyJwtAsymmetric: a token signed with a different EC key than the one getKey resolves is rejected', async () => {
  const otherKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const token = signEs256({ sub: 'user-1', exp: futureExp() }, { signingKey: otherKeyPair.privateKey }); // signed by a different key, but still claims TEST_KID
  const result = await verifyJwtAsymmetric(token, fakeGetKey()); // resolves TEST_JWK (the real public key), not the impostor's
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('verifyJwtAsymmetric: a tampered payload (signature no longer matches) is rejected', async () => {
  const token = signEs256({ sub: 'user-1', exp: futureExp() });
  const [headerB64, , signatureB64] = token.split('.');
  const tamperedPayloadB64 = b64url({ sub: 'user-attacker', exp: futureExp() });
  const tampered = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;
  const result = await verifyJwtAsymmetric(tampered, fakeGetKey());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('verifyJwtAsymmetric: expired token is rejected even with a valid signature', async () => {
  const token = signEs256({ sub: 'user-1', exp: pastExp() });
  const result = await verifyJwtAsymmetric(token, fakeGetKey());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired_token');
});

test('verifyJwtAsymmetric: token with no subject claim is rejected', async () => {
  const token = signEs256({ exp: futureExp() });
  const result = await verifyJwtAsymmetric(token, fakeGetKey());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_subject');
});

test('verifyJwtAsymmetric: a getKey that throws (e.g. a real JWKS fetch failing) surfaces as key_fetch_failed, not an unhandled rejection', async () => {
  const getKey = async () => {
    throw new Error('network error');
  };
  const token = signEs256({ sub: 'user-1', exp: futureExp() });
  const result = await verifyJwtAsymmetric(token, getKey);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'key_fetch_failed');
});

test('verifyJwtAsymmetric: TEST_KID/TEST_JWK fixture sanity — kid matches between the two', () => {
  assert.equal(TEST_JWK.kid, TEST_KID);
  assert.equal(TEST_JWK.kty, 'EC');
  assert.equal(TEST_JWK.crv, 'P-256');
});
