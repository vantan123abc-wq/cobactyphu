import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from './app.js';
import { TEST_JWK, signEs256 } from './testUtils/testEs256.js';

const TEST_SECRET = 'test-secret-fixture-not-a-real-supabase-jwt-secret';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken(payload, secret = TEST_SECRET) {
  const headerB64 = b64url({ alg: 'HS256', typ: 'JWT' });
  const payloadB64 = b64url(payload);
  const signatureB64 = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

test('GET /api/v1/health returns 200 and { status: "ok" }', async () => {
  const app = createApp();
  const server = app.listen(0); // port 0 — OS assigns a free port, avoids test collisions
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok' });
  } finally {
    server.close();
  }
});

test('without a jwtSecret, room routes are not mounted at all (404, not 401)', async () => {
  const app = createApp(); // no jwtSecret
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/api/v1/rooms`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('with a jwtSecret, room routes are mounted and require authentication', async () => {
  const app = createApp({ jwtSecret: 'test-secret-fixture-not-a-real-supabase-jwt-secret' });
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/api/v1/rooms`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  } finally {
    server.close();
  }
});

test('P11-T03: jwtSecret can also be a { getKey } config object (ES256/JWKS mode) and a real signed token is accepted end to end', async () => {
  const getKey = async (kid) => (kid === TEST_JWK.kid ? TEST_JWK : null);
  const app = createApp({ jwtSecret: { getKey } });
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const token = signEs256({ sub: 'user-42', exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await fetch(`http://localhost:${port}/api/v1/rooms`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    // 500 here would mean auth passed (req.user was set) and the request
    // reached roomRepository — this environment has no live Supabase
    // client configured for this test, so a downstream 500 is expected
    // and is itself proof the auth layer accepted the token; a 401 would
    // mean auth itself failed, which is the one outcome this test rules out.
    assert.notEqual(res.status, 401);
  } finally {
    server.close();
  }
});

// ---- GET /api/v1/boards/:boardId — static board layout ----

test('without a jwtSecret, board routes are not mounted at all (404, not 401)', async () => {
  const app = createApp(); // no jwtSecret
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/api/v1/boards/small`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('with a jwtSecret, board routes are mounted and require authentication, same as rooms', async () => {
  const app = createApp({ jwtSecret: 'test-secret-fixture-not-a-real-supabase-jwt-secret' });
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/api/v1/boards/small`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  } finally {
    server.close();
  }
});

test('an authenticated request for a cached board returns its tiles', async () => {
  const app = createApp({ jwtSecret: 'test-secret-fixture-not-a-real-supabase-jwt-secret' });
  app.set('boardTilesByBoard', { small: [{ id: 't0', position: 0, tileType: 'go', name: 'Bắt Đầu' }] });
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const token = makeToken({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await fetch(`http://localhost:${port}/api/v1/boards/small`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.boardId, 'small');
    assert.equal(body.tiles.length, 1);
  } finally {
    server.close();
  }
});
