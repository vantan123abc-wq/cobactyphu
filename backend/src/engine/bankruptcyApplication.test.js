import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBankruptcySettlement } from './bankruptcyApplication.js';
import { createPlayerGameState, createGameState } from '../domain/gameState.js';
import { createProperty } from '../domain/property.js';

function baseState({ players, properties }) {
  return createGameState({
    id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', phase: 'POST_ACTIONS',
    players, properties, startedAt: 'now',
  });
}

test('debt owed to a real player: all remaining properties transfer to that player, cash amount is the debtor\'s full remaining balance', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 0 });
  const debtor = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'u1', turnOrder: 0, currentBalance: 42 });
  const creditor = createPlayerGameState({ id: 'gp2', gameId: 'g1', playerId: 'u2', turnOrder: 1, currentBalance: 500 });
  const propA = createProperty({ id: 'pA', gameId: 'g1', boardTileId: 'tA', ownerId: 'gp1', upgradeLevel: 0, mortgaged: false });
  const propB = createProperty({ id: 'pB', gameId: 'g1', boardTileId: 'tB', ownerId: 'gp1', upgradeLevel: 1, mortgaged: true });

  const gameState = baseState({ players: [bank, debtor, creditor], properties: [propA, propB] });
  const result = computeBankruptcySettlement(gameState, 'gp1', 'gp2');

  assert.equal(result.cashAmount, 42);
  assert.deepEqual(
    result.propertyTransfers.sort((a, b) => a.propertyId.localeCompare(b.propertyId)),
    [
      { propertyId: 'pA', toPlayerId: 'gp2' },
      { propertyId: 'pB', toPlayerId: 'gp2' },
    ]
  );
});

test('debt owed to the Bank: properties revert to unowned (toPlayerId null), not "owned by the Bank"', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 0 });
  const debtor = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'u1', turnOrder: 0, currentBalance: 10 });
  const propA = createProperty({ id: 'pA', gameId: 'g1', boardTileId: 'tA', ownerId: 'gp1', upgradeLevel: 0, mortgaged: false });

  const gameState = baseState({ players: [bank, debtor], properties: [propA] });
  const result = computeBankruptcySettlement(gameState, 'gp1', 'gp-bank');

  assert.equal(result.cashAmount, 10);
  assert.deepEqual(result.propertyTransfers, [{ propertyId: 'pA', toPlayerId: null }]);
});

test('a debtor who owns nothing produces an empty transfer list, not an error', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 0 });
  const debtor = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'u1', turnOrder: 0, currentBalance: 5 });

  const gameState = baseState({ players: [bank, debtor], properties: [] });
  const result = computeBankruptcySettlement(gameState, 'gp1', 'gp-bank');

  assert.deepEqual(result.propertyTransfers, []);
  assert.equal(result.cashAmount, 5);
});

test('only the debtor\'s own properties are included, not other players\' or already-transferred ones', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 0 });
  const debtor = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'u1', turnOrder: 0, currentBalance: 0 });
  const other = createPlayerGameState({ id: 'gp2', gameId: 'g1', playerId: 'u2', turnOrder: 1, currentBalance: 0 });
  const debtorProp = createProperty({ id: 'pA', gameId: 'g1', boardTileId: 'tA', ownerId: 'gp1', upgradeLevel: 0, mortgaged: false });
  const otherProp = createProperty({ id: 'pB', gameId: 'g1', boardTileId: 'tB', ownerId: 'gp2', upgradeLevel: 0, mortgaged: false });
  const unownedProp = createProperty({ id: 'pC', gameId: 'g1', boardTileId: 'tC', ownerId: null, upgradeLevel: 0, mortgaged: false });

  const gameState = baseState({ players: [bank, debtor, other], properties: [debtorProp, otherProp, unownedProp] });
  const result = computeBankruptcySettlement(gameState, 'gp1', 'gp-bank');

  assert.deepEqual(result.propertyTransfers, [{ propertyId: 'pA', toPlayerId: null }]);
});
