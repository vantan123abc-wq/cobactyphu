import test from 'node:test';
import assert from 'node:assert';
import { calculateFinalRent } from './calculateRentMiddleware.js';

test('calculateFinalRent in CLASSIC mode ignores perks', () => {
  const gameState = { ruleset: 'CLASSIC', players: [] };
  const targetTile = { tileType: 'property', baseRent: 100 };
  const targetProperty = { upgradeLevel: 0, ownerId: 'p2' };
  
  const rent = calculateFinalRent(gameState, 'p1', 'p2', targetTile, targetProperty, [], []);
  assert.strictEqual(rent, 100);
});

test('calculateFinalRent in ASYMMETRIC mode applies perks', () => {
  const gameState = { 
    ruleset: 'ASYMMETRIC',
    players: [
      { id: 'p1', activePerks: ['SHIELD_50'] },
      { id: 'p2', activePerks: ['BUFF_RENT_BLUE'] }
    ]
  };
  const targetTile = { tileType: 'property', baseRent: 100, color: 'BLUE' };
  const targetProperty = { upgradeLevel: 0, ownerId: 'p2' };
  
  // base = 100
  // p2 has BUFF_RENT_BLUE -> 200
  // p1 has SHIELD_50 -> 100
  const rent = calculateFinalRent(gameState, 'p1', 'p2', targetTile, targetProperty, [], []);
  assert.strictEqual(rent, 100);
});
