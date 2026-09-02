// Static board layout — P11-T03. API_CONTRACT.md's conventions apply even
// though this endpoint isn't in that document yet (base path /api/v1,
// camelCase, `{ error }` envelope, and its own "Bearer JWT on every
// endpoint except /api/v1/health" rule — no documented exception for board
// data, so this is mounted behind auth like every other real route,
// correcting this task's own brief which treated auth here as optional).
//
// Deliberately does NOT call infrastructure/repositories/boardRepository.js's
// fetchBoardTiles() itself. server.js already calls it once at startup for
// both board sizes (for the socket layer's own landing/purchase
// resolution) and stores the result via app.set('boardTilesByBoard', ...)
// — this controller reads that same in-memory cache. board_tiles is
// genuinely static for a server's entire lifetime (nothing ever writes to
// it at runtime), so querying Supabase again per request would be
// redundant work, not fresher data — same reasoning DATABASE_DESIGN.md
// gives for boards/board_tiles being a fixed reference table.

const VALID_BOARD_IDS = ['small', 'large']; // ADAPTIVE_BOARD_DESIGN.md, fully approved, locked

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

/**
 * GET /api/v1/boards/:boardId
 */
export function getBoardConfig(req, res) {
  const { boardId } = req.params;

  if (!VALID_BOARD_IDS.includes(boardId)) {
    return errorResponse(res, 404, 'NOT_FOUND', `Unknown boardId '${boardId}' — must be one of ${VALID_BOARD_IDS.join(', ')}`);
  }

  const boardTilesByBoard = req.app.get('boardTilesByBoard') ?? {};
  const tiles = boardTilesByBoard[boardId];

  if (!tiles || tiles.length === 0) {
    return errorResponse(
      res,
      503,
      'BOARD_DATA_UNAVAILABLE',
      `Board '${boardId}' tile data is not available right now — Supabase may not be configured, or board_tiles hasn't been seeded yet`
    );
  }

  return res.status(200).json({ boardId, tiles });
}
