import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propertyNetWorth, netWorth } from './netWorth.js';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';
import { createPlayerGameState, createGameState } from '../domain/gameState.js';

function tileAndProperty({ id, price = 200, houseCost = 100, mortgageValue = 100, upgradeLevel = 0, mortgaged = false }) {
  const tile = createTile({ id, boardId: 'small', position: 1, tileType: 'property', name: 'x', price, houseCost, mortgageValue });
  const property = createProperty({ id: `p-${id}`, gameId: 'g1', boardTileId: id, ownerId: 'gp1', upgradeLevel, mortgaged });
  return { tile, property };
}

test('unmortgaged, unimproved property counts at full price', () => {
  const { tile, property } = tileAndProperty({ id: 't1', price: 200 });
  assert.equal(propertyNetWorth(tile, property), 200);
});

test('mortgaged property counts at price minus the real unmortgage cost (ceil((mortgageValue * 11) / 10)), not bare mortgageValue', () => {
  const { tile, property } = tileAndProperty({ id: 't1', price: 200, mortgageValue: 100, mortgaged: true });
  // payoff = ceil((100 * 11) / 10) = 110; landValue = 200 - 110 = 90
  assert.equal(propertyNetWorth(tile, property), 90);
});

test('mortgaged property value never goes negative even if payoff would exceed price', () => {
  const { tile, property } = tileAndProperty({ id: 't1', price: 50, mortgageValue: 100, mortgaged: true });
  // payoff = ceil((100 * 11) / 10) = 110 > price 50 — clamped to 0, not negative
  assert.equal(propertyNetWorth(tile, property), 0);
});

test('buildings count at houseCost * HOUSE_SELLBACK_RATIO per level (sell-back value, not full houseCost)', () => {
  const { tile, property } = tileAndProperty({ id: 't1', price: 200, houseCost: 100, upgradeLevel: 3 });
  // land 200 + buildings floor(3 * 100 * 0.5) = 150 -> 350
  assert.equal(propertyNetWorth(tile, property), 350);
});

test('a mortgaged property with houses (should not normally happen — mortgaging requires 0 houses) contributes 0 building value, matching bankruptcy.js\'s own convention', () => {
  const { tile, property } = tileAndProperty({ id: 't1', price: 200, houseCost: 100, upgradeLevel: 2, mortgaged: true });
  const payoff = Math.ceil((100 * 11) / 10); // mortgageValue defaults to 100
  assert.equal(propertyNetWorth(tile, property), Math.max(0, 200 - payoff)); // building term is 0
});

test('netWorth(): cash alone, no properties', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 0 });
  const me = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'u1', turnOrder: 0, currentBalance: 500 });
  const gameState = createGameState({
    id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', phase: 'POST_ACTIONS',
    players: [bank, me], properties: [], startedAt: 'now',
  });

  assert.equal(netWorth(gameState, [], 'gp1'), 500);
});

test('netWorth(): cash plus multiple owned properties, mixed mortgaged/unmortgaged/improved', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 0 });
  const me = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'u1', turnOrder: 0, currentBalance: 300 });

  const tileA = createTile({ id: 'tA', boardId: 'small', position: 1, tileType: 'property', name: 'A', price: 200, houseCost: 100, mortgageValue: 100 });
  const tileB = createTile({ id: 'tB', boardId: 'small', position: 2, tileType: 'property', name: 'B', price: 150, houseCost: 80, mortgageValue: 75 });
  const propA = createProperty({ id: 'pA', gameId: 'g1', boardTileId: 'tA', ownerId: 'gp1', upgradeLevel: 2, mortgaged: false }); // 200 + floor(2*100*0.5)=100 -> 300
  const propB = createProperty({ id: 'pB', gameId: 'g1', boardTileId: 'tB', ownerId: 'gp1', upgradeLevel: 0, mortgaged: true }); // 150 - ceil(75*1.1)=83 -> 67

  const gameState = createGameState({
    id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', phase: 'POST_ACTIONS',
    players: [bank, me], properties: [propA, propB], startedAt: 'now',
  });

  // 300 (cash) + 300 (A) + 67 (B) = 667
  assert.equal(netWorth(gameState, [tileA, tileB], 'gp1'), 667);
});

test('netWorth(): properties owned by other players are excluded', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 0 });
  const me = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'u1', turnOrder: 0, currentBalance: 100 });
  const opp = createPlayerGameState({ id: 'gp2', gameId: 'g1', playerId: 'u2', turnOrder: 1, currentBalance: 100 });

  const tile = createTile({ id: 't1', boardId: 'small', position: 1, tileType: 'property', name: 'x', price: 999, houseCost: 100, mortgageValue: 100 });
  const opponentProperty = createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp2', upgradeLevel: 0, mortgaged: false });

  const gameState = createGameState({
    id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', phase: 'POST_ACTIONS',
    players: [bank, me, opp], properties: [opponentProperty], startedAt: 'now',
  });

  assert.equal(netWorth(gameState, [tile], 'gp1'), 100); // just cash, opponent's 999-value property not counted
});
