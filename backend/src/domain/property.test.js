import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProperty, MIN_UPGRADE_LEVEL, MAX_UPGRADE_LEVEL } from './property.js';

test('defaults to bank-owned, unmortgaged, unimproved when unspecified', () => {
  const property = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1' });

  assert.equal(property.ownerId, null);
  assert.equal(property.mortgaged, false);
  assert.equal(property.upgradeLevel, MIN_UPGRADE_LEVEL);
  assert.equal(property.acquiredAt, null);
  assert.equal(property.acquiredAtRound, null); // 2026-08-25: no RECENTLY_ACQUIRED gate applies until a real BUY_PROPERTY/HOSTILE_BUYOUT sets this
});

test('constructs an owned, improved property', () => {
  const property = createProperty({
    id: 'p1',
    gameId: 'g1',
    boardTileId: 't1',
    ownerId: 'gp1',
    upgradeLevel: 3,
    acquiredAt: '2026-08-17T00:00:00.000Z',
    acquiredAtRound: 4,
  });

  assert.equal(property.ownerId, 'gp1');
  assert.equal(property.upgradeLevel, 3);
  assert.equal(property.acquiredAtRound, 4);
});

test('accepts the full upgradeLevel range, 0 through 5', () => {
  for (let level = MIN_UPGRADE_LEVEL; level <= MAX_UPGRADE_LEVEL; level++) {
    assert.doesNotThrow(() =>
      createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', upgradeLevel: level })
    );
  }
});

test('rejects an out-of-range or non-integer upgradeLevel', () => {
  assert.throws(() => createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', upgradeLevel: -1 }));
  assert.throws(() => createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', upgradeLevel: 6 }));
  assert.throws(() => createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', upgradeLevel: 1.5 }));
});
