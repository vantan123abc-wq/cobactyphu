import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBoardTiles } from './boardRepository.js';

// Mocks @supabase/supabase-js's chainable query builder
// (.from().select().eq().order()) without any real network call —
// records what was called on it, and resolves with whatever
// { data, error } the test wants.
function mockSupabase({ data = null, error = null } = {}) {
  const calls = {};
  return {
    from(table) {
      calls.from = table;
      return {
        select(columns) {
          calls.select = columns;
          return {
            eq(column, value) {
              calls.eq = { column, value };
              return {
                order(column, opts) {
                  calls.order = { column, opts };
                  return Promise.resolve({ data, error });
                },
              };
            },
          };
        },
      };
    },
    _calls: calls,
  };
}

test('fetchBoardTiles: queries board_tiles filtered by board_id, ordered by position ascending', async () => {
  const supabase = mockSupabase({ data: [] });
  await fetchBoardTiles(supabase, 'small');

  assert.equal(supabase._calls.from, 'board_tiles');
  assert.deepEqual(supabase._calls.eq, { column: 'board_id', value: 'small' });
  assert.deepEqual(supabase._calls.order, { column: 'position', opts: { ascending: true } });
});

test('fetchBoardTiles: maps a full property row to domain/tile.js\'s Tile shape', async () => {
  const supabase = mockSupabase({
    data: [
      {
        id: 't1',
        board_id: 'small',
        position: 1,
        tile_type: 'property',
        name: 'Brown Ave 1',
        group_id: 'brown',
        price: 60,
        base_rent: 2,
        rent_table: [10, 30, 90, 160, 250],
        house_cost: 50,
        mortgage_value: 30,
        tax_amount: null,
      },
    ],
  });

  const tiles = await fetchBoardTiles(supabase, 'small');

  assert.deepEqual(tiles, [
    {
      id: 't1',
      boardId: 'small',
      position: 1,
      tileType: 'property',
      name: 'Brown Ave 1',
      groupId: 'brown',
      price: 60,
      baseRent: 2,
      rentTable: [10, 30, 90, 160, 250],
      houseCost: 50,
      mortgageValue: 30,
      taxAmount: null,
    },
  ]);
});

test('fetchBoardTiles: maps a non-property row (nulls for type-specific columns) correctly', async () => {
  const supabase = mockSupabase({
    data: [
      {
        id: 't5',
        board_id: 'small',
        position: 5,
        tile_type: 'tax',
        name: 'Income Tax',
        group_id: null,
        price: null,
        base_rent: null,
        rent_table: null,
        house_cost: null,
        mortgage_value: null,
        tax_amount: 100,
      },
    ],
  });

  const [tile] = await fetchBoardTiles(supabase, 'small');

  assert.equal(tile.tileType, 'tax');
  assert.equal(tile.taxAmount, 100);
  assert.equal(tile.price, null);
  assert.equal(tile.rentTable, null);
});

test('fetchBoardTiles: preserves row order (position ascending, as queried)', async () => {
  const supabase = mockSupabase({
    data: [
      { id: 't0', board_id: 'small', position: 0, tile_type: 'go', name: 'GO' },
      { id: 't1', board_id: 'small', position: 1, tile_type: 'jail', name: 'Jail' },
    ],
  });

  const tiles = await fetchBoardTiles(supabase, 'small');

  assert.deepEqual(tiles.map((t) => t.position), [0, 1]);
});

test('fetchBoardTiles: an empty result set returns an empty array, not null/undefined', async () => {
  const supabase = mockSupabase({ data: [] });
  const tiles = await fetchBoardTiles(supabase, 'small');
  assert.deepEqual(tiles, []);
});

test('fetchBoardTiles: throws if the query itself errors', async () => {
  const supabase = mockSupabase({ error: { message: 'relation "board_tiles" does not exist' } });
  await assert.rejects(() => fetchBoardTiles(supabase, 'small'));
});

test('fetchBoardTiles: throws if supabase is null (no configured client)', async () => {
  await assert.rejects(() => fetchBoardTiles(null, 'small'));
});
