// Per-game dynamic property ownership — mirrors `properties`
// (DATABASE_DESIGN.md §8, backend/supabase/migrations/0001_core_tables.sql).
// Pure data shape: no I/O, no database driver, no framework import.
//
// Deliberately separate from Tile (tile.js): Tile is the static, per-board
// config (price, rentTable, ...) that exists once per board position and is
// shared by every game on that board. Property is the dynamic, per-game
// ownership state (owner, upgrade level, mortgaged) — one row per
// property-type tile, created fresh when a game starts (0001's own comment:
// "created when a game reaches STARTING. Written live, not snapshot-cadence").
// GAME_DESIGN_SPEC.md §9's ASCII shape block merges both into one "Property"
// — that merged shape is not used here; boardTileId is how the two connect.

export const MIN_UPGRADE_LEVEL = 0;
export const MAX_UPGRADE_LEVEL = 5; // properties.upgrade_level CHECK (BETWEEN 0 AND 5)

/**
 * @typedef {Object} Property
 * @property {string} id - uuid, properties.id
 * @property {string} gameId - properties.game_id
 * @property {string} boardTileId - FK to Tile.id (board_tiles.id) — the static config this ownership row is for
 * @property {string|null} ownerId - FK to PlayerGameState.id (game_players.id); null = bank/unowned (GAME_DESIGN_SPEC.md §9: "ownerId (null = bank)")
 * @property {number} upgradeLevel - 0 (unimproved) through 5 (hotel)
 * @property {boolean} mortgaged
 * @property {string|null} acquiredAt - ISO timestamp; null until first purchased
 * @property {number|null} acquiredAtRound - GameState.roundNumber at the moment this
 *   owner took possession (via BUY_PROPERTY or HOSTILE_BUYOUT only — a negotiated
 *   trade leaves this untouched, see turnMachine.js's applyTradeAction/ACCEPT_TRADE);
 *   null means no "wait a turn" gate applies at all — either never owned this way, or
 *   pre-dates this field. handleBuildHouse's own RECENTLY_ACQUIRED check is the sole
 *   reader (2026-08-25, user request: a freshly hostile-buyout'd or just-purchased
 *   property could otherwise be built on the very same turn purely to make it
 *   HOUSE_PROTECTED against a further hostile buyout, closing that window
 *   immediately rather than leaving it open for at least one real turn).
 */

/**
 * @param {Partial<Property>} fields
 * @returns {Property}
 */
export function createProperty(fields) {
  const upgradeLevel = fields.upgradeLevel ?? MIN_UPGRADE_LEVEL;
  if (
    !Number.isInteger(upgradeLevel) ||
    upgradeLevel < MIN_UPGRADE_LEVEL ||
    upgradeLevel > MAX_UPGRADE_LEVEL
  ) {
    throw new RangeError(
      `upgradeLevel must be in [${MIN_UPGRADE_LEVEL}, ${MAX_UPGRADE_LEVEL}] — got ${upgradeLevel}`
    );
  }

  return {
    id: fields.id,
    gameId: fields.gameId,
    boardTileId: fields.boardTileId,
    ownerId: fields.ownerId ?? null,
    upgradeLevel,
    mortgaged: fields.mortgaged ?? false,
    acquiredAt: fields.acquiredAt ?? null,
    acquiredAtRound: fields.acquiredAtRound ?? null,
  };
}
