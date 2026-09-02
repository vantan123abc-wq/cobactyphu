import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRent } from './calculateRent.js';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';

const RENT_TABLE = [10, 30, 90, 160, 250]; // levels 1 (1 house) through 5 (hotel)

function propertyTile(overrides = {}) {
  return createTile({
    id: 't-target',
    boardId: 'small',
    position: 3,
    tileType: 'property',
    name: 'Placeholder Ave',
    groupId: 'brown',
    price: 60,
    baseRent: 2,
    rentTable: RENT_TABLE,
    houseCost: 50,
    mortgageValue: 30,
    ...overrides,
  });
}

test('unimproved property (upgradeLevel 0) uses baseRent, no group data supplied', () => {
  const targetTile = propertyTile();
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't-target', ownerId: 'gp-owner' });
  const ownerHoldings = [{ tile: targetTile, property: targetProperty }];

  const rent = calculateRent({ targetTile, targetProperty, ownerHoldings });
  assert.equal(rent, 2); // baseRent, no group bonus since groupTiles wasn't provided
});

test('each improved tier (1 house through hotel) pulls from rentTable', () => {
  for (let level = 1; level <= 5; level++) {
    const targetTile = propertyTile();
    const targetProperty = createProperty({
      id: 'p1',
      gameId: 'g1',
      boardTileId: 't-target',
      ownerId: 'gp-owner',
      upgradeLevel: level,
    });
    const ownerHoldings = [{ tile: targetTile, property: targetProperty }];

    const rent = calculateRent({ targetTile, targetProperty, ownerHoldings });
    assert.equal(rent, RENT_TABLE[level - 1]);
  }
});

test('group bonus doubles unimproved rent when the owner holds every tile in the group, none mortgaged', () => {
  const targetTile = propertyTile({ id: 't1', position: 1 });
  const groupTile2 = propertyTile({ id: 't2', position: 2 });
  const groupTile3 = propertyTile({ id: 't3', position: 4 });
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-owner' });
  const property2 = createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't2', ownerId: 'gp-owner' });
  const property3 = createProperty({ id: 'p3', gameId: 'g1', boardTileId: 't3', ownerId: 'gp-owner' });

  const ownerHoldings = [
    { tile: targetTile, property: targetProperty },
    { tile: groupTile2, property: property2 },
    { tile: groupTile3, property: property3 },
  ];
  const groupTiles = [targetTile, groupTile2, groupTile3];

  const rent = calculateRent({ targetTile, targetProperty, ownerHoldings, groupTiles });
  assert.equal(rent, 4); // baseRent (2) × 2
});

test('group bonus does not apply if one group member is owned by someone else', () => {
  const targetTile = propertyTile({ id: 't1', position: 1 });
  const groupTile2 = propertyTile({ id: 't2', position: 2 });
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-owner' });
  const property2 = createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't2', ownerId: 'gp-someone-else' });

  const ownerHoldings = [{ tile: targetTile, property: targetProperty }]; // property2 excluded — not this owner's
  const groupTiles = [targetTile, groupTile2];

  const rent = calculateRent({ targetTile, targetProperty, ownerHoldings, groupTiles });
  assert.equal(rent, 2); // baseRent only, no bonus
});

test('group bonus does not apply if any group member is mortgaged', () => {
  const targetTile = propertyTile({ id: 't1', position: 1 });
  const groupTile2 = propertyTile({ id: 't2', position: 2 });
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-owner' });
  const property2 = createProperty({
    id: 'p2',
    gameId: 'g1',
    boardTileId: 't2',
    ownerId: 'gp-owner',
    mortgaged: true,
  });

  const ownerHoldings = [
    { tile: targetTile, property: targetProperty },
    { tile: groupTile2, property: property2 },
  ];
  const groupTiles = [targetTile, groupTile2];

  const rent = calculateRent({ targetTile, targetProperty, ownerHoldings, groupTiles });
  assert.equal(rent, 2); // baseRent only, no bonus
});

// REVISED 2026-09-02. This test previously asserted the opposite — that the
// group bonus switched OFF as soon as a house was built (the classic
// unimproved-only rule). That rule only makes sense when building is gated
// behind owning the group, and this project removed that gate on 2026-08-25.
// With the gate gone, the old shape made the bonus and building mutually
// exclusive, and measurement showed the bonus was then worth almost nothing:
// across 250 simulated matches only 0.3% of all rent paid was attributable to
// it. The bonus now multiplies rent at EVERY development level, so a monopoly
// amplifies a developed group instead of competing with developing it.
test('the group bonus applies at every development level, not just unimproved', () => {
  const targetTile = propertyTile({ id: 't1', position: 1 });
  const groupTile2 = propertyTile({ id: 't2', position: 2 });
  const property2 = createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't2', ownerId: 'gp-owner' });

  for (const upgradeLevel of [1, 2, 3, 4, 5]) {
    const targetProperty = createProperty({
      id: 'p1',
      gameId: 'g1',
      boardTileId: 't1',
      ownerId: 'gp-owner',
      upgradeLevel,
    });
    const ownerHoldings = [
      { tile: targetTile, property: targetProperty },
      { tile: groupTile2, property: property2 },
    ];
    const rent = calculateRent({
      targetTile,
      targetProperty,
      ownerHoldings,
      groupTiles: [targetTile, groupTile2],
    });
    assert.equal(rent, RENT_TABLE[upgradeLevel - 1] * 2, `upgradeLevel ${upgradeLevel} should be doubled`);
  }
});

test('an improved property WITHOUT the full group gets no bonus at any level', () => {
  const targetTile = propertyTile({ id: 't1', position: 1 });
  const groupTile2 = propertyTile({ id: 't2', position: 2 }); // owned by someone else
  const targetProperty = createProperty({
    id: 'p1',
    gameId: 'g1',
    boardTileId: 't1',
    ownerId: 'gp-owner',
    upgradeLevel: 3,
  });
  const ownerHoldings = [{ tile: targetTile, property: targetProperty }];

  const rent = calculateRent({
    targetTile,
    targetProperty,
    ownerHoldings,
    groupTiles: [targetTile, groupTile2],
  });
  assert.equal(rent, RENT_TABLE[2], 'plain rentTable, no multiplier');
});

test('a mortgaged tile anywhere in the group still cancels the bonus, improved or not', () => {
  const targetTile = propertyTile({ id: 't1', position: 1 });
  const groupTile2 = propertyTile({ id: 't2', position: 2 });
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-owner', upgradeLevel: 2 });
  const property2 = createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't2', ownerId: 'gp-owner', mortgaged: true });

  const rent = calculateRent({
    targetTile,
    targetProperty,
    ownerHoldings: [
      { tile: targetTile, property: targetProperty },
      { tile: groupTile2, property: property2 },
    ],
    groupTiles: [targetTile, groupTile2],
  });
  assert.equal(rent, RENT_TABLE[1], 'no bonus while any group member is mortgaged');
});

test('transport rent scales as base × 2^(ownedCount-1) for counts 1 through 4', () => {
  const expected = { 1: 25, 2: 50, 3: 100, 4: 200 };
  for (const count of [1, 2, 3, 4]) {
    const targetTile = createTile({
      id: 't-transport',
      boardId: 'small',
      position: 5,
      tileType: 'transport',
      name: 'Placeholder Station',
      baseRent: 25,
      mortgageValue: 30,
    });
    const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't-transport', ownerId: 'gp-owner' });
    const ownerHoldings = Array.from({ length: count }, (_, i) => ({
      tile: i === 0 ? targetTile : createTile({ id: `t-transport-${i}`, boardId: 'small', position: 5 + i, tileType: 'transport', name: 'x', baseRent: 25 }),
      property: i === 0 ? targetProperty : createProperty({ id: `p-${i}`, gameId: 'g1', boardTileId: `t-transport-${i}`, ownerId: 'gp-owner' }),
    }));

    const rent = calculateRent({ targetTile, targetProperty, ownerHoldings });
    assert.equal(rent, expected[count]);
  }
});

test('utility rent is diceRoll × 4 with one owned, × 10 with both owned', () => {
  const targetTile = createTile({
    id: 't-utility',
    boardId: 'small',
    position: 6,
    tileType: 'utility',
    name: 'Placeholder Utility',
    mortgageValue: 30,
  });
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't-utility', ownerId: 'gp-owner' });

  const oneOwned = [{ tile: targetTile, property: targetProperty }];
  assert.equal(calculateRent({ targetTile, targetProperty, ownerHoldings: oneOwned, diceRoll: 7 }), 28);

  const secondUtilityTile = createTile({
    id: 't-utility-2',
    boardId: 'small',
    position: 12,
    tileType: 'utility',
    name: 'Placeholder Utility 2',
  });
  const secondUtilityProperty = createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't-utility-2', ownerId: 'gp-owner' });
  const bothOwned = [...oneOwned, { tile: secondUtilityTile, property: secondUtilityProperty }];
  assert.equal(calculateRent({ targetTile, targetProperty, ownerHoldings: bothOwned, diceRoll: 7 }), 70);
});

test('utility rent throws without a diceRoll', () => {
  const targetTile = createTile({ id: 't-utility', boardId: 'small', position: 6, tileType: 'utility', name: 'x' });
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't-utility', ownerId: 'gp-owner' });
  assert.throws(() =>
    calculateRent({ targetTile, targetProperty, ownerHoldings: [{ tile: targetTile, property: targetProperty }] })
  );
});

test('throws for a non-rentable tileType', () => {
  const targetTile = createTile({ id: 't-go', boardId: 'small', position: 0, tileType: 'go', name: 'GO' });
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't-go', ownerId: 'gp-owner' });
  assert.throws(() => calculateRent({ targetTile, targetProperty, ownerHoldings: [] }));
});

test('throws for an unowned target property', () => {
  const targetTile = propertyTile();
  const targetProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't-target' }); // ownerId defaults null
  assert.throws(() => calculateRent({ targetTile, targetProperty, ownerHoldings: [] }));
});
