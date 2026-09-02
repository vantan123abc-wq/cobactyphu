// Fetches and caches this Supabase project's JWKS (JSON Web Key Set) —
// P11-T03: this project's real Supabase instance signs JWTs asymmetrically
// (ES256), not the legacy shared HS256 secret auth/verifyJwt.js's
// `verifyJwt` was originally built around (see that file's header for how
// this was found and confirmed).
//
// A real network fetch, deliberately isolated to this one module —
// verifyJwt.js's `verifyJwtAsymmetric` stays injectable/offline-testable,
// taking a `getKey(kid)` resolver rather than knowing how to fetch
// anything itself, the same DI convention every repository in this
// backend already follows (a Supabase client passed in as a parameter,
// never imported as a singleton inside the function that uses it).
//
// This cache — verify the signature locally against a fetched public key —
// is why this exists at all, instead of the simpler `supabase.auth.getUser(token)`
// per request: API_CONTRACT.md's own Conventions section already commits
// to "The backend verifies the JWT against the Supabase project (signature
// check, not a round-trip to Supabase's own API, for latency)" — an
// already-approved constraint from before this task, not one invented to
// justify this specific fix.

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // keys rotate rarely; bounds staleness after a real rotation without refetching on every single request

/**
 * @param {Object} deps
 * @param {string} deps.supabaseUrl
 * @param {typeof fetch} [deps.fetchImpl] - injected for testability; defaults to the global fetch (no real network call unless this actually runs)
 * @param {number} [deps.cacheTtlMs]
 * @returns {(kid: string) => Promise<object|null>} getKey — resolves a JWK by key id, or null if genuinely not found (even after a forced refresh)
 */
export function createJwksResolver({ supabaseUrl, fetchImpl = fetch, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
  if (!supabaseUrl) {
    throw new Error('createJwksResolver requires a non-empty supabaseUrl');
  }

  let cachedAt = 0;
  let keysByKid = new Map();

  async function refresh() {
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) {
      throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
    }
    const { keys } = await res.json();
    keysByKid = new Map((keys ?? []).map((key) => [key.kid, key]));
    cachedAt = Date.now();
  }

  return async function getKey(kid) {
    const isStale = Date.now() - cachedAt >= cacheTtlMs;
    if (isStale || !keysByKid.has(kid)) {
      await refresh(); // an unrecognized kid might mean real rotation — refetch once before giving up, not assumed stale-forever
    }
    return keysByKid.get(kid) ?? null;
  };
}
