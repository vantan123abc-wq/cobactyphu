import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSolvency } from './bankruptcy.js';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';

function holding({ id, upgradeLevel = 0, mortgaged = false, houseCost = 50, mortgageValue = 30, tileType = 'property' }) {
  const tile = createTile({
    id,
    boardId: 'small',
    position: 1,
    tileType,
    name: 'x',
    houseCost: tileType === 'property' ? houseCost : null,
    mortgageValue,
  });
  const property = createProperty({ id: `p-${id}`, gameId: 'g1', boardTileId: id, ownerId: 'gp1', upgradeLevel, mortgaged });
  return { tile, property };
}

test('solvent from cash alone — no liquidation needed', () => {
  const result = checkSolvency({ cashOnHand: 200, debt: 100, holdings: [] });

  assert.equal(result.canPayInCash, true);
  assert.equal(result.isBankrupt, false);
  assert.equal(result.creditorReceives, 100);
  assert.equal(result.shortfall, 0);
});

test('not payable in cash alone, but liquidation covers the gap — solvent', () => {
  // cash 20, debt 100; one unmortgaged property worth 30 mortgage value = 50 total < 100... use two
  const holdings = [holding({ id: 't1', mortgageValue: 50 }), holding({ id: 't2', mortgageValue: 40 })];
  const result = checkSolvency({ cashOnHand: 20, debt: 100, holdings });

  assert.equal(result.canPayInCash, false);
  assert.equal(result.totalLiquidatableValue, 90);
  assert.equal(result.isBankrupt, false); // 20 + 90 = 110 >= 100
  assert.equal(result.creditorReceives, 100); // debt paid in full
  assert.equal(result.shortfall, 0);
});

test('liquidation insufficient — bankrupt, creditor gets whatever is left', () => {
  const holdings = [holding({ id: 't1', mortgageValue: 30 })];
  const result = checkSolvency({ cashOnHand: 10, debt: 100, holdings });

  assert.equal(result.totalLiquidatableValue, 30);
  assert.equal(result.isBankrupt, true); // 10 + 30 = 40 < 100
  assert.equal(result.creditorReceives, 40); // everything they had, not the full 100
  assert.equal(result.shortfall, 60);
});

test('exact-zero-remainder: cash + liquidation exactly equals debt is solvent, not bankrupt', () => {
  const holdings = [holding({ id: 't1', mortgageValue: 40 })];
  const result = checkSolvency({ cashOnHand: 60, debt: 100, holdings }); // 60 + 40 = 100

  assert.equal(result.isBankrupt, false);
  assert.equal(result.creditorReceives, 100);
  assert.equal(result.shortfall, 0);
});

test('house/hotel sell-back is exactly half houseCost, per upgradeLevel', () => {
  const holdings = [holding({ id: 't1', upgradeLevel: 3, houseCost: 50, mortgageValue: 0 })];
  const result = checkSolvency({ cashOnHand: 0, debt: 1, holdings });

  assert.equal(result.totalLiquidatableValue, 75); // floor(3 * 50 / 2)
});

test('an already-mortgaged property contributes 0, even if it somehow reports upgradeLevel > 0', () => {
  const holdings = [holding({ id: 't1', mortgaged: true, upgradeLevel: 2, houseCost: 50, mortgageValue: 40 })];
  const result = checkSolvency({ cashOnHand: 0, debt: 1, holdings });

  assert.equal(result.totalLiquidatableValue, 0);
});

test('non-property holdings (transport/utility, houseCost null) contribute mortgage value only, no crash', () => {
  const holdings = [holding({ id: 't1', tileType: 'transport', mortgageValue: 25 })];
  const result = checkSolvency({ cashOnHand: 0, debt: 1, holdings });

  assert.equal(result.totalLiquidatableValue, 25);
});
