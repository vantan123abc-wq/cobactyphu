import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePurchase,
  calculateMortgage,
  calculateUnmortgage,
  calculateBuildHouse,
  calculateSellHouse,
  HOUSE_SELLBACK_RATIO,
  MORTGAGE_INTEREST_RATE,
} from './propertyEconomy.js';
import { createTile } from '../domain/tile.js';

function propertyTile(overrides = {}) {
  return createTile({
    id: 't1',
    boardId: 'small',
    position: 1,
    tileType: 'property',
    name: 'Placeholder Ave',
    price: 60,
    baseRent: 2,
    rentTable: [10, 30, 90, 160, 250],
    houseCost: 50,
    mortgageValue: 30,
    ...overrides,
  });
}

test('§3 row 2 — purchase: player pays price to the Bank', () => {
  const result = calculatePurchase(propertyTile({ price: 60 }));
  assert.deepEqual(result, { amount: 60, transactionType: 'purchase', direction: 'player_to_bank' });
});

test('§3 row 13 — mortgage: Bank pays mortgageValue to the player', () => {
  const result = calculateMortgage(propertyTile({ mortgageValue: 30 }));
  assert.deepEqual(result, { amount: 30, transactionType: 'mortgage', direction: 'bank_to_player' });
});

test('§3 row 14 — unmortgage: player pays mortgageValue × 1.1 (rounded up) to the Bank', () => {
  const result = calculateUnmortgage(propertyTile({ mortgageValue: 25 })); // 25 * 1.1 = 27.5
  assert.equal(result.amount, 28); // ceil — player never underpays due to rounding
  assert.equal(result.transactionType, 'unmortgage');
  assert.equal(result.direction, 'player_to_bank');
});

test('§3 row 14 — unmortgage does not overcharge on values affected by float imprecision (finding #26)', () => {
  // Regression test: `100 * 1.1 === 110.00000000000001` in IEEE-754, so the
  // old `Math.ceil(mortgageValue * MORTGAGE_INTEREST_RATE)` form overcharged
  // by $1 here (111 instead of 110). The fixed integer-safe formula
  // (`Math.ceil((mortgageValue * 11) / 10)`) must not regress this.
  assert.equal(calculateUnmortgage(propertyTile({ mortgageValue: 100 })).amount, 110);
  assert.equal(calculateUnmortgage(propertyTile({ mortgageValue: 90 })).amount, 99);
  assert.equal(calculateUnmortgage(propertyTile({ mortgageValue: 110 })).amount, 121);
});

test('§3 row 11 — build: player pays houseCost to the Bank, one unit', () => {
  const result = calculateBuildHouse(propertyTile({ houseCost: 50 }));
  assert.deepEqual(result, { amount: 50, transactionType: 'build', direction: 'player_to_bank' });
});

test('§3 row 12 — sell house: Bank pays houseCost × 0.5 (rounded down) to the player, one unit', () => {
  const result = calculateSellHouse(propertyTile({ houseCost: 55 })); // 55 * 0.5 = 27.5
  assert.equal(result.amount, 27); // floor — player never receives a rounding windfall
  assert.equal(result.transactionType, 'sell_house');
  assert.equal(result.direction, 'bank_to_player');
});

test('sell-house amount is not scaled by upgradeLevel — always one unit, unlike bankruptcy.js liquidation', () => {
  // calculateSellHouse takes a Tile only, no Property/upgradeLevel input at all —
  // this test documents that boundary rather than exercising a branch.
  const result = calculateSellHouse(propertyTile({ houseCost: 50 }));
  assert.equal(result.amount, 25); // exactly one unit's sell-back, never 2x/3x
});

test('exported constants match ECONOMY_SPECIFICATION.md §8', () => {
  assert.equal(HOUSE_SELLBACK_RATIO, 0.5);
  assert.equal(MORTGAGE_INTEREST_RATE, 1.1);
});
