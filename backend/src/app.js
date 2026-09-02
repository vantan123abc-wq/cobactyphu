import express from 'express';
import { createAuthMiddleware } from './auth/authMiddleware.js';
import roomRoutes from './api/routes/room.routes.js';
import boardRoutes from './api/routes/board.routes.js';
import eventCardRoutes from './api/routes/eventCard.routes.js';
import authRoutes from './api/routes/auth.routes.js';

// Express app factory — API_CONTRACT.md's conventions apply from here on
// (base path /api/v1, JSON error envelope) as routes are added in later tasks.
// Exported as a factory, not a bound server, so tests can exercise it without
// owning a real port (see app.test.js).
//
// jwtSecret is optional here, not required — createAuthMiddleware() itself
// throws on a missing secret (auth/authMiddleware.js), which would have
// broken the original zero-arg createApp() call this file's own test
// already relied on for the unauthenticated /health check. Without a
// secret, auth-protected routes (rooms) are simply not mounted — a 404 on
// them, not a 401 — an explicit "this deployment isn't configured for
// them" state rather than constructing a middleware that can't work.
//
// supabase (P10-T02) is stored via app.set(), not imported inside
// room.controller.js as a module-level singleton — the same DI reasoning
// infrastructure/websocket/socketServer.js's handlers already use
// (constructor-injected roomRepository), applied here through Express's
// own per-app storage since room.controller.js's exports are plain route
// handlers, not a factory. req.app.get('supabase') is undefined if this
// isn't passed — every roomRepository/gameRepository call already throws a
// clear error on a null/undefined client (same "possibly null" contract
// infrastructure/database/supabaseClient.js documents), so this
// deliberately doesn't default or guard it here.
//
// boardTilesByBoard (P11-T03) — same app.set() DI, read by
// board.controller.js. server.js sets this *after* createApp() returns
// (board tiles are fetched asynchronously at startup); that's fine, since
// app.get() is only ever read lazily at request time, long after startup,
// never at route-registration time here.
export function createApp({ jwtSecret, supabase } = {}) {
  const app = express();
  app.set('supabase', supabase);

  // CORS — found missing entirely while browser-verifying the P11-T05
  // Lobby UI: every REST route here has always required Bearer auth (never
  // relied on cookies/CORS for security), but with zero Access-Control-*
  // headers set anywhere, a real browser blocks the cross-origin fetch
  // (frontend :5173, backend :5000) at the preflight OPTIONS step before
  // the request — and its Authorization header — ever reaches Express at
  // all. Invisible to `node --test` (no browser CORS enforcement there) and
  // to `e2e-smoke.js` (a Node.js script, same reason) — only surfaced by
  // actually clicking "Tạo phòng" in a real browser, this project's own
  // established "smoke-test the real runtime, not just the test suite"
  // lesson (Phase 09), extended here to "a real browser specifically," not
  // just a booted Node process. Reflects the request's own Origin rather
  // than a hardcoded one — no production deployment exists anywhere in this
  // project's docs to scope it to yet; every route below this still
  // requires its own valid JWT regardless of origin, so this doesn't loosen
  // any actual authorization.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json());

  // API_CONTRACT.md: no auth required, no versioned error envelope needed —
  // this is the one endpoint outside that convention by design.
  app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  if (jwtSecret) {
    const authMiddleware = createAuthMiddleware(jwtSecret);
    app.use('/api/v1/rooms', authMiddleware, roomRoutes);
    // Board layouts are still real game data, not public — API_CONTRACT.md's
    // "Bearer JWT on every endpoint except /api/v1/health" has no carve-out
    // for this, so it's mounted the same way rooms is, not left open.
    app.use('/api/v1/boards', authMiddleware, boardRoutes);
    // Event card dictionary (2026-08-21) — same reasoning as boards above,
    // static reference content still mounted behind auth, not left open.
    app.use('/api/v1/event-cards', authMiddleware, eventCardRoutes);
    // GET /api/v1/auth/me (P03-T03, wired 2026-08-21) — API_CONTRACT.md's
    // own words: "no further check" beyond a valid JWT, same auth
    // requirement as every other route here.
    app.use('/api/v1/auth', authMiddleware, authRoutes);
  }

  // Global error handler — catches any unhandled throw from async route
  // handlers (e.g. roomRepository throwing when Supabase rejects). Without
  // this, Express's default handler returns an empty HTML 500 page that the
  // frontend's res.json() call can't parse, masking the real error entirely.
  // With it, every thrown error surfaces as the standard { error } envelope
  // and is logged to the terminal so the actual cause is visible.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[app] unhandled error in route handler:', err.stack ?? err.message ?? err);
    if (!res.headersSent) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message ?? 'Internal server error' } });
    }
  });

  return app;
}
