// Board tile loader — DATABASE_DESIGN.md §7's `board_tiles` table, the
// long-blocked `loadBoard.js` (IMPLEMENTATION_PLAN.md P04-T02: "loads a
// full board (all tiles, in order) for a given boardId... loadBoard('small')
// returns exactly 36 ordered tiles") finally getting real DB wiring.
//
// Maps DB rows to domain/tile.js's exact Tile shape via createTile() —
// the same domain-factory-reuse convention every other repository/
// controller in this backend already follows, not a hand-rolled object
// literal. Column names below are DATABASE_DESIGN.md §7's real ones
// (`group_id`, `rent_table`) — not the `color_group`/`rent_levels` guesses
// this task's own description used, which don't exist in the approved
// schema.
//
// supabase is an injected parameter, not imported as a module-level
// singleton — mirrors infrastructure/database/supabaseClient.js's own
// "possibly null" contract, and makes this fully testable with a mock
// client, no real network call.

import { createTile } from '../../domain/tile.js';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} boardId - 'small' | 'large'
 * @returns {Promise<import('../../domain/tile.js').Tile[]>} ordered by position ascending
 * @throws {Error} if supabase is null/unset, or the query itself fails
 */
export async function fetchBoardTiles(supabase, boardId) {
  if (!supabase) {
    throw new Error('fetchBoardTiles: no Supabase client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset)');
  }

  const { data, error } = await supabase
    .from('board_tiles')
    .select('*')
    .eq('board_id', boardId)
    .order('position', { ascending: true });

  if (error) {
    throw new Error(`fetchBoardTiles: query failed for board '${boardId}': ${error.message}`);
  }

  return (data ?? []).map((row) =>
    createTile({
      id: row.id,
      boardId: row.board_id,
      position: row.position,
      tileType: row.tile_type,
      name: row.name,
      groupId: row.group_id,
      price: row.price,
      baseRent: row.base_rent,
      rentTable: row.rent_table,
      houseCost: row.house_cost,
      mortgageValue: row.mortgage_value,
      taxAmount: row.tax_amount,
    })
  );
}
