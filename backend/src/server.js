import http from 'node:http';
import { createApp } from './app.js';
import { initSocketServer } from './infrastructure/websocket/socketServer.js';
import * as roomRepository from './infrastructure/repositories/roomRepository.js';
import { supabase } from './infrastructure/database/supabaseClient.js';
import { fetchBoardTiles } from './infrastructure/repositories/boardRepository.js';
import { createJwksResolver } from './auth/jwks.js';

// SUPABASE_JWT_SECRET (not JWT_SECRET) — the env var name this project has
// used consistently since P03-T02/auth/authMiddleware.js and P08-T01's
// createApp({ jwtSecret }) wiring; .env.example documents this exact name.
//
// P11-T03: this project's real Supabase instance signs JWTs asymmetrically
// (ES256/JWKS), not the legacy shared HS256 secret SUPABASE_JWT_SECRET
// verifies — confirmed by decoding a real issued token
// (auth/verifyJwt.js's header has the full story). `authConfig` below
// prefers JWKS mode whenever SUPABASE_URL is configured (JWKS fetching
// structurally needs the project URL anyway, and that's what this specific
// project actually requires), falling back to the legacy secret only if
// SUPABASE_URL isn't set — same "missing infra makes the dependent feature
// inert, not the whole process unable to start" posture this file already
// uses for board tiles below: createJwksResolver() itself does no network
// I/O at construction time, only lazily on first use, so this never blocks
// or risks failing server startup.
const authConfig = process.env.SUPABASE_URL
  ? { getKey: createJwksResolver({ supabaseUrl: process.env.SUPABASE_URL }) }
  : process.env.SUPABASE_JWT_SECRET;

const PORT = process.env.PORT || 5000;
const app = createApp({ jwtSecret: authConfig, supabase });

// http.createServer(app) explicitly, rather than app.listen()'s own
// implicit one, so the same underlying server can be shared with
// Socket.IO (initSocketServer attaches to it directly) instead of each
// owning a separate listener on the same port.
const server = http.createServer(app);

// Board tiles require a real, reachable Supabase project with
// board_tiles actually seeded — not available anywhere in this
// environment (PROJECT_STATUS.md: "No Supabase CLI, no DB password, no
// service_role key exist"). Loading gracefully degrades to {} (every
// board falls back to [] inside socketServer.js) rather than failing
// server startup — the same "missing infra makes the dependent feature
// inert, not the whole process unable to start" posture createApp()'s
// jwtSecret already established. Both board sizes are loaded up front,
// not just one, since a running server can host games on either
// (ADAPTIVE_BOARD_DESIGN.md) — this task's own single-fetch sketch didn't
// account for that, corrected here.
let boardTilesByBoard = {};
if (supabase) {
  try {
    const [small, large] = await Promise.all([fetchBoardTiles(supabase, 'small'), fetchBoardTiles(supabase, 'large')]);
    boardTilesByBoard = { small, large };
  } catch (err) {
    console.error('Failed to load board tiles from Supabase — falling back to empty boards:', err.message);
  }
} else {
  console.warn('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — starting without real board tile data.');
}

// P11-T03: board.controller.js's GET /api/v1/boards/:boardId reads this
// same cache via req.app.get() — set after createApp() returns, which is
// fine, since that's only ever read lazily per-request, not at
// route-registration time.
app.set('boardTilesByBoard', boardTilesByBoard);

// Lobby real-time push (2026-08-21) — room.controller.js's REST mutations
// (join/ready/start/leave/kick) need to broadcast S2C_ROOM_UPDATED to
// already-connected sockets in the room, the same app.set()/req.app.get()
// DI boardTilesByBoard above already established, so route handlers reach
// the one real `io` instance without importing socketServer.js's module
// state directly.
const io = initSocketServer(server, roomRepository, authConfig, supabase, boardTilesByBoard);
app.set('io', io);

server.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
