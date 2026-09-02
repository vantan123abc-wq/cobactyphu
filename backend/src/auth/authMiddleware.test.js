import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAuthMiddleware } from './authMiddleware.js';
import { TEST_JWK, signEs256 } from '../testUtils/testEs256.js';

// Test-only fixture — not a real Supabase secret.
const TEST_SECRET = 'test-secret-fixture-not-a-real-supabase-jwt-secret';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken(payload, { secret = TEST_SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const headerB64 = b64url(header);
  const payloadB64 = b64url(payload);
  const signatureB64 = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function futureExp(seconds = 3600) {
  return Math.floor(Date.now() / 1000) + seconds;
}

function pastExp(seconds = 3600) {
  return Math.floor(Date.now() / 1000) - seconds;
}

// Minimal Express-shaped mocks — no supertest/express test-client dependency needed.
function mockReq(authHeader) {
  return { headers: authHeader !== undefined ? { authorization: authHeader } : {} };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function mockNext() {
  const calls = [];
  const next = (...args) => calls.push(args);
  next.callCount = () => calls.length;
  return next;
}

test('createAuthMiddleware throws without a secret', () => {
  assert.throws(() => createAuthMiddleware(''));
  assert.throws(() => createAuthMiddleware(undefined));
});

test('1. missing token → rejected with 401, next not called', () => {
  const middleware = createAuthMiddleware(TEST_SECRET);
  const req = mockReq(undefined);
  const res = mockRes();
  const next = mockNext();

  middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'UNAUTHORIZED');
  assert.equal(next.callCount(), 0);
  assert.equal(req.user, undefined);
});

test('2. malformed token → rejected with 401, next not called', () => {
  const middleware = createAuthMiddleware(TEST_SECRET);
  const req = mockReq('Bearer not-a-real-jwt');
  const res = mockRes();
  const next = mockNext();

  middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(next.callCount(), 0);
});

test('3. invalid signature → rejected with 401, next not called', () => {
  const middleware = createAuthMiddleware(TEST_SECRET);
  const token = makeToken({ sub: 'user-1', exp: futureExp() }, { secret: 'wrong-secret' });
  const req = mockReq(`Bearer ${token}`);
  const res = mockRes();
  const next = mockNext();

  middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(next.callCount(), 0);
});

test('4. expired token → rejected with 401, next not called', () => {
  const middleware = createAuthMiddleware(TEST_SECRET);
  const token = makeToken({ sub: 'user-1', exp: pastExp() });
  const req = mockReq(`Bearer ${token}`);
  const res = mockRes();
  const next = mockNext();

  middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(next.callCount(), 0);
});

test('5. valid token → authenticated user is exposed correctly, next called once', () => {
  const middleware = createAuthMiddleware(TEST_SECRET);
  const token = makeToken({ sub: 'user-42', exp: futureExp() });
  const req = mockReq(`Bearer ${token}`);
  const res = mockRes();
  const next = mockNext();

  middleware(req, res, next);

  assert.equal(next.callCount(), 1);
  assert.equal(res.statusCode, null);
  assert.deepEqual(req.user, { id: 'user-42' });
});

test('Authorization header without the Bearer prefix is treated as missing', () => {
  const middleware = createAuthMiddleware(TEST_SECRET);
  const token = makeToken({ sub: 'user-1', exp: futureExp() });
  const req = mockReq(token); // no "Bearer " prefix
  const res = mockRes();
  const next = mockNext();

  middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(next.callCount(), 0);
});

// ---- { getKey } config (ES256/JWKS) — P11-T03 ----
// Same behavioral contract as the bare-secret (HS256) tests above, proven
// against the other verification mode — createAuthMiddleware(TEST_SECRET)
// above is untouched, this is a second, independent configuration of the
// same factory.

function fakeGetKey(jwk = TEST_JWK) {
  return async (kid) => (kid === jwk.kid ? jwk : null);
}

test('createAuthMiddleware throws with an empty config object (neither secret nor getKey)', () => {
  assert.throws(() => createAuthMiddleware({}));
});

test('{ getKey } config: valid ES256 token → authenticated user is exposed correctly, next called once', async () => {
  const middleware = createAuthMiddleware({ getKey: fakeGetKey() });
  const token = signEs256({ sub: 'user-42', exp: futureExp() });
  const req = mockReq(`Bearer ${token}`);
  const res = mockRes();
  const next = mockNext();

  await middleware(req, res, next);

  assert.equal(next.callCount(), 1);
  assert.equal(res.statusCode, null);
  assert.deepEqual(req.user, { id: 'user-42' });
});

test('{ getKey } config: an HS256 token is rejected — this middleware instance only trusts ES256', async () => {
  const middleware = createAuthMiddleware({ getKey: fakeGetKey() });
  const token = makeToken({ sub: 'user-1', exp: futureExp() }); // HS256
  const req = mockReq(`Bearer ${token}`);
  const res = mockRes();
  const next = mockNext();

  await middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(next.callCount(), 0);
});

test('{ getKey } config: an unrecognized kid → rejected with 401, next not called', async () => {
  const middleware = createAuthMiddleware({ getKey: fakeGetKey() });
  const token = signEs256({ sub: 'user-1', exp: futureExp() }, { header: { kid: 'rotated-away' } });
  const req = mockReq(`Bearer ${token}`);
  const res = mockRes();
  const next = mockNext();

  await middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(next.callCount(), 0);
});

test('{ getKey } config: expired ES256 token → rejected with 401, next not called', async () => {
  const middleware = createAuthMiddleware({ getKey: fakeGetKey() });
  const token = signEs256({ sub: 'user-1', exp: pastExp() });
  const req = mockReq(`Bearer ${token}`);
  const res = mockRes();
  const next = mockNext();

  await middleware(req, res, next);

  assert.equal(res.statusCode, 401);
  assert.equal(next.callCount(), 0);
});
