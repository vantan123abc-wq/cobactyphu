// Static per-board-position tile configuration — mirrors `board_tiles`
// (DATABASE_DESIGN.md §7, backend/supabase/migrations/0001_core_tables.sql).
// Pure data shape: no I/O, no database driver, no framework import.
//
// Terminology note: GAME_DESIGN_SPEC.md §7 is explicitly tagged
// [SUPERSEDED — see ADAPTIVE_BOARD_DESIGN.md] and §8's taxonomy
// (`railroad`/`community_chest`) was never updated to match. This project's
// actual taxonomy — confirmed by ADAPTIVE_BOARD_DESIGN.md ("Tile-type
// taxonomy — property | transport | utility | chance | fortune | ...") and
// already shipped in board_tiles.tile_type's CHECK constraint — uses
// `transport`/`fortune` instead. That's what's used here.

export const TILE_TYPES = Object.freeze([
  'go',
  'property',
  'transport',
  'utility',
  'chance',
  'fortune',
  'tax',
  'jail',
  'free_parking',
  'go_to_jail',
]);

/**
 * @typedef {Object} Tile
 * @property {string} id - uuid, board_tiles.id
 * @property {string} boardId - 'small' | 'large', board_tiles.board_id
 * @property {number} position - 0-indexed position on the loop, board_tiles.position
 * @property {('go'|'property'|'transport'|'utility'|'chance'|'fortune'|'tax'|'jail'|'free_parking'|'go_to_jail')} tileType
 * @property {string} name - display name (structural placeholder until P02-T03's real content lands)
 * @property {string|null} groupId - color-group key; null for tiles with no group (go, chance, tax, ...)
 * @property {number|null} price - only set for type 'property'/'transport'/'utility'
 * @property {number|null} baseRent - unimproved (upgradeLevel 0) rent for 'property'; also the per-unit base for 'transport''s `base × 2^(ownerCount-1)` formula (GAME_DESIGN_SPEC.md §11) — set for both, not 'property' alone
 * @property {number[]|null} rentTable - rent for upgradeLevel 1 (1 house) through 5 (hotel) — a 5-element array, index 0 = 1 house; upgradeLevel 0 uses baseRent instead, not rentTable[0]. Only set for type 'property'
 * @property {number|null} houseCost - only set for type 'property'
 * @property {number|null} mortgageValue - only set for property/transport/utility
 * @property {number|null} taxAmount - only set for type 'tax'
 */

/**
 * @param {Partial<Tile>} fields - all Tile fields; type-specific fields
 *   (price, rentTable, ...) default to null when omitted, matching
 *   board_tiles' own nullable columns for tile types they don't apply to.
 * @returns {Tile}
 */
export function createTile(fields) {
  if (!TILE_TYPES.includes(fields.tileType)) {
    throw new TypeError(`Unknown tileType: ${fields.tileType}`);
  }

  return {
    id: fields.id,
    boardId: fields.boardId,
    position: fields.position,
    tileType: fields.tileType,
    name: fields.name,
    groupId: fields.groupId ?? null,
    price: fields.price ?? null,
    baseRent: fields.baseRent ?? null,
    rentTable: fields.rentTable ?? null,
    houseCost: fields.houseCost ?? null,
    mortgageValue: fields.mortgageValue ?? null,
    taxAmount: fields.taxAmount ?? null,
  };
}
