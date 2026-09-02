import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJwksResolver } from './jwks.js';
import { TEST_JWK } from '../testUtils/testEs256.js';

const SUPABASE_URL = 'https://example-project.supabase.co';

// A fake fetch — no real network call anywhere in this file. Records every
// call so tests can assert on fetch *count* (the whole point of caching).
function fakeFetch({ keys = [TEST_JWK], status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ keys }),
    };
  };
  impl.calls = calls;
  return impl;
}

test('createJwksResolver requires a supabaseUrl', () => {
  assert.throws(() => createJwksResolver({}));
  assert.throws(() => createJwksResolver());
});

test('getKey fetches the JWKS endpoint under the given supabaseUrl', async () => {
  const fetchImpl = fakeFetch();
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl });

  await getKey(TEST_JWK.kid);

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0], `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
});

test('getKey resolves a known kid to its JWK', async () => {
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl: fakeFetch() });
  const jwk = await getKey(TEST_JWK.kid);
  assert.deepEqual(jwk, TEST_JWK);
});

test('getKey resolves an unknown kid to null after a forced refresh, not an error', async () => {
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl: fakeFetch() });
  const jwk = await getKey('no-such-kid');
  assert.equal(jwk, null);
});

test('a second call for an already-cached kid within the TTL does not refetch', async () => {
  const fetchImpl = fakeFetch();
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl, cacheTtlMs: 60_000 });

  await getKey(TEST_JWK.kid);
  await getKey(TEST_JWK.kid);

  assert.equal(fetchImpl.calls.length, 1);
});

test('an unrecognized kid triggers exactly one refetch attempt, even if it stays unresolved', async () => {
  const fetchImpl = fakeFetch();
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl, cacheTtlMs: 60_000 });

  await getKey(TEST_JWK.kid); // primes the cache
  await getKey('rotated-away-kid'); // not in cache -> one refetch, still not found

  assert.equal(fetchImpl.calls.length, 2);
});

test('a cache past its TTL refetches even for an already-known kid (real key rotation)', async () => {
  const fetchImpl = fakeFetch();
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl, cacheTtlMs: 0 }); // always stale

  await getKey(TEST_JWK.kid);
  await getKey(TEST_JWK.kid);

  assert.equal(fetchImpl.calls.length, 2);
});

test('a non-2xx JWKS response throws, surfacing as verifyJwtAsymmetric\'s key_fetch_failed one layer up', async () => {
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl: fakeFetch({ status: 500 }) });
  await assert.rejects(() => getKey(TEST_JWK.kid));
});

test('an empty keys array resolves every kid to null without throwing', async () => {
  const getKey = createJwksResolver({ supabaseUrl: SUPABASE_URL, fetchImpl: fakeFetch({ keys: [] }) });
  assert.equal(await getKey(TEST_JWK.kid), null);
});
