import { verifyJwt, verifyJwtAsymmetric } from './verifyJwt.js';

const BEARER_PREFIX = 'Bearer ';

function extractToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

// Accepts either the original bare-string form (a legacy plain-string
// HS256 secret — every existing caller/test keeps working unmodified) or
// a `{ secret }` / `{ getKey }` config object (P11-T03, ES256/JWKS — see
// verifyJwt.js's header for why both modes need to coexist).
function normalizeAuthConfig(secretOrConfig) {
  return typeof secretOrConfig === 'string' ? { secret: secretOrConfig } : (secretOrConfig ?? {});
}

/**
 * Creates Express auth middleware bound to a specific JWT verification
 * config. API_CONTRACT.md conventions: token comes from `Authorization:
 * Bearer <jwt>`; on success, req.user = { id } is set and next() is called;
 * on any failure, responds 401 with the standard { error: { code, message } }
 * envelope.
 *
 * Factory pattern (not a bare middleware reading process.env internally) so
 * the config is explicit and the middleware is trivially testable without
 * touching global environment state or a real network call either way.
 *
 * @param {string | { secret?: string, getKey?: (kid: string) => Promise<object|null> }} secretOrConfig — a bare HS256 secret string, or a config object naming exactly one mode
 * @returns {import('express').RequestHandler}
 */
export function createAuthMiddleware(secretOrConfig) {
  const config = normalizeAuthConfig(secretOrConfig);
  if (!config.secret && !config.getKey) {
    throw new Error('createAuthMiddleware requires a non-empty JWT secret, or a config object with { secret } or { getKey }');
  }

  return async function authMiddleware(req, res, next) {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header' },
      });
    }

    const result = config.secret ? verifyJwt(token, config.secret) : await verifyJwtAsymmetric(token, config.getKey);
    if (!result.valid) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: `Invalid token (${result.reason})` },
      });
    }

    req.user = { id: result.payload.sub };
    next();
  };
}
