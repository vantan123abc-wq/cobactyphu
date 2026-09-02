import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTile } from './resolveTile.js';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';

function tile(tileType) {
  return createTile({ id: 't1', boardId: 'small', position: 5, tileType, name: 'x' });
}

test('go / free_parking / jail / go_to_jail all resolve to POST_ACTIONS', () => {
  for (const tileType of ['go', 'free_parking', 'jail', 'go_to_jail']) {
    assert.equal(resolveTile(tile(tileType)), 'POST_ACTIONS');
  }
});

test('chance and fortune resolve to DRAWING_CARD', () => {
  assert.equal(resolveTile(tile('chance')), 'DRAWING_CARD');
  assert.equal(resolveTile(tile('fortune')), 'DRAWING_CARD');
});

test('tax resolves to PAYING_TAX', () => {
  assert.equal(resolveTile(tile('tax')), 'PAYING_TAX');
});

test('unowned property/transport/utility resolves to AWAITING_PURCHASE', () => {
  for (const tileType of ['property', 'transport', 'utility']) {
    const property = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1' }); // ownerId defaults null
    assert.equal(resolveTile(tile(tileType), property, 'gp-current'), 'AWAITING_PURCHASE');
  }
});

test('property owned by another (not mortgaged) resolves to PAYING_RENT', () => {
  const property = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-other' });
  assert.equal(resolveTile(tile('property'), property, 'gp-current'), 'PAYING_RENT');
});

test('property owned by another but mortgaged resolves to POST_ACTIONS (no rent owed)', () => {
  const property = createProperty({
    id: 'p1',
    gameId: 'g1',
    boardTileId: 't1',
    ownerId: 'gp-other',
    mortgaged: true,
  });
  assert.equal(resolveTile(tile('property'), property, 'gp-current'), 'POST_ACTIONS');
});

test('property owned by the landing player themself resolves to AWAITING_UPGRADE', () => {
  // Pre-existing bug in this test, found 2026-08-22 while running the full
  // suite for unrelated work: resolveTile.js's own resolveBuyableTile()
  // returns 'AWAITING_UPGRADE' for this exact case (own-property landing ->
  // build popup), not 'POST_ACTIONS' — this test still asserted the older
  // value, silently stale since whenever AWAITING_UPGRADE was added.
  const property = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-current' });
  assert.equal(resolveTile(tile('property'), property, 'gp-current'), 'AWAITING_UPGRADE');
});

// Found by fuzzing 2026-08-25: stations/utilities were routed to
// AWAITING_UPGRADE too, a phase whose only real action (BUILD_HOUSE) rejects
// them outright as "not a house-eligible tile" — a dead prompt plus a wasted
// 15s phase timer on every landing on your own station.
test('your OWN station/utility does NOT enter the build phase — nothing is buildable there', () => {
  for (const type of ['transport', 'utility']) {
    const property = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-current' });
    assert.equal(resolveTile(tile(type), property, 'gp-current'), 'POST_ACTIONS', `${type} should skip AWAITING_UPGRADE`);
  }
});

test('a buyable tile type without a property throws', () => {
  assert.throws(() => resolveTile(tile('utility'), null, 'gp-current'));
  assert.throws(() => resolveTile(tile('transport'), undefined, 'gp-current'));
});

test('an unknown tileType throws', () => {
  assert.throws(() => resolveTile({ tileType: 'railroad' }));
});
