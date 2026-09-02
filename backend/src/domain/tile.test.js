import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTile, TILE_TYPES } from './tile.js';

test('constructs a property tile with all property-specific fields set', () => {
  const tile = createTile({
    id: 't1',
    boardId: 'small',
    position: 3,
    tileType: 'property',
    name: 'Placeholder Ave',
    groupId: 'brown',
    price: 60,
    baseRent: 2,
    rentTable: [10, 30, 90, 160, 250], // levels 1 (1 house) through 5 (hotel); level 0 uses baseRent
    houseCost: 50,
    mortgageValue: 30,
  });

  assert.equal(tile.tileType, 'property');
  assert.equal(tile.price, 60);
  assert.deepEqual(tile.rentTable, [10, 30, 90, 160, 250]);
  assert.equal(tile.taxAmount, null); // not a tax tile
});

test('constructs a non-property tile with unset fields defaulting to null', () => {
  const tile = createTile({ id: 't2', boardId: 'small', position: 0, tileType: 'go', name: 'GO' });

  assert.equal(tile.groupId, null);
  assert.equal(tile.price, null);
  assert.equal(tile.rentTable, null);
});

test('every declared tile type constructs without throwing', () => {
  for (const tileType of TILE_TYPES) {
    assert.doesNotThrow(() =>
      createTile({ id: 't', boardId: 'small', position: 0, tileType, name: 'x' })
    );
  }
});

test('rejects an unknown tileType, including the superseded railroad/community_chest naming', () => {
  assert.throws(() =>
    createTile({ id: 't', boardId: 'small', position: 0, tileType: 'railroad', name: 'x' })
  );
  assert.throws(() =>
    createTile({ id: 't', boardId: 'small', position: 0, tileType: 'community_chest', name: 'x' })
  );
});
