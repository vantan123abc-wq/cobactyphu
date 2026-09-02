import crypto from 'node:crypto';

// UPDATE (P11-T03): the assumption below was wrong for this project's real
// Supabase instance — found via e2e-smoke.js hitting a real
// `unsupported_algorithm` rejection, confirmed by decoding an actual issued
// token's header: `{"alg":"ES256","kid":"..."}`, not HS256. Exactly the
// "if this project actually uses JWKS signing" scenario this comment
// already anticipated. Resolution: `verifyJwt` below is untouched (HS256,
// shared-secret) — some Supabase projects/configurations still use it, and
// every existing caller/test keeps working unmodified — and
// `verifyJwtAsymmetric` is added alongside it for the ES256/JWKS case.
// Callers pick exactly one mode via which config they construct
// (auth/authMiddleware.js, infrastructure/websocket/socketServer.js), never
// by trusting the token's own declared `alg` — still the same
// "algorithm-confusion" defense the original comment below describes, now
// applied per-deployment-mode instead of one hardcoded mode.
//
// ORIGINAL ASSUMPTION, kept for history: this project's Supabase JWTs use
// HS256 with a shared project secret (the traditional/default Supabase
// scheme), not the newer asymmetric JWKS-based signing. Basis: the anon key
// supplied for this project decodes to a header of
// {"alg":"HS256","typ":"JWT"}. If this project actually uses JWKS signing,
// this whole verification mechanism needs to change to fetching a public key
// from a JWKS endpoint instead of a shared secret — a different mechanism,
// not a config tweak. Flagging here rather than silently assuming forever.
const EXPECTED_ALG = 'HS256';

function decodeJsonSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verifies a JWT's structure, signature, and expiry. Pure function — no I/O,
 * no Express dependency, no process.env access (the secret is a parameter).
 *
 * Algorithm is pinned to HS256 and checked explicitly, regardless of what
 * the token's own header claims — never trust a token to declare its own
 * algorithm, which is what algorithm-confusion attacks exploit.
 *
 * @param {string} token
 * @param {string} secret
 * @returns {{ valid: true, payload: object } | { valid: false, reason: string }}
 */
export function verifyJwt(token, secret) {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing_token' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed_token' };
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = decodeJsonSegment(headerB64);
    payload = decodeJsonSegment(payloadB64);
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }

  if (header.alg !== EXPECTED_ALG) {
    return { valid: false, reason: 'unsupported_algorithm' };
  }

  let actualSignature;
  try {
    actualSignature = Buffer.from(signatureB64, 'base64url');
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();

  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp) {
    return { valid: false, reason: 'expired_token' };
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { valid: false, reason: 'missing_subject' };
  }

  return { valid: true, payload };
}

/**
 * ES256/JWKS counterpart to `verifyJwt` above — same result shape and the
 * same claims checks (expiry, subject), deliberately kept as a separate,
 * self-contained function rather than refactored to share code with
 * `verifyJwt`: that function's own existing test suite (and every current
 * caller) depends on it staying exactly as it is, so duplicating the
 * decode/expiry/subject logic here is the deliberate tradeoff for leaving
 * it untouched — see this file's header for why both modes need to coexist.
 *
 * Algorithm is pinned to ES256 and checked explicitly against the token's
 * header, same "never trust a token to pick its own algorithm" reasoning
 * `verifyJwt` documents — the caller decides which of `verifyJwt`/
 * `verifyJwtAsymmetric` to invoke (i.e. which algorithm this deployment
 * trusts) by which one it calls, not by branching on `header.alg` itself.
 *
 * `getKey` resolves the token header's `kid` to a JWK — `auth/jwks.js`'s
 * cache in production, a trivial fixture in tests (no real network fetch
 * needed to test signature verification itself).
 * @param {string} token
 * @param {(kid: string) => Promise<object|null>} getKey
 * @returns {Promise<{ valid: true, payload: object } | { valid: false, reason: string }>}
 */
export async function verifyJwtAsymmetric(token, getKey) {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing_token' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed_token' };
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = decodeJsonSegment(headerB64);
    payload = decodeJsonSegment(payloadB64);
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }

  if (header.alg !== 'ES256') {
    return { valid: false, reason: 'unsupported_algorithm' };
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { valid: false, reason: 'missing_key_id' };
  }

  let signature;
  try {
    signature = Buffer.from(signatureB64, 'base64url');
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }

  let jwk;
  try {
    jwk = await getKey(header.kid);
  } catch {
    return { valid: false, reason: 'key_fetch_failed' };
  }
  if (!jwk) {
    return { valid: false, reason: 'unknown_key_id' };
  }

  let signatureValid;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    // JOSE/JWS ECDSA signatures are the raw r||s concatenation (IEEE
    // P1363), not the DER encoding Node's crypto.verify assumes by
    // default for EC keys — dsaEncoding must be set explicitly, or every
    // genuinely-valid Supabase-issued signature would fail to verify.
    signatureValid = crypto.verify('sha256', Buffer.from(`${headerB64}.${payloadB64}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return { valid: false, reason: 'malformed_key' };
  }
  if (!signatureValid) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp) {
    return { valid: false, reason: 'expired_token' };
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { valid: false, reason: 'missing_subject' };
  }

  return { valid: true, payload };
}
