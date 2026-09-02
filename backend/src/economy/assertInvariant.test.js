import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEconomyInvariant, EconomyInvariantError } from './assertInvariant.js';
import { applyTransaction } from './applyTransaction.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';

const MATCH_POOL = 20000; // == BANK_RESERVE_INITIAL, ECONOMY_SPECIFICATION.md §0/§8 placeholder value

function baseGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: MATCH_POOL - 3000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', currentBalance: 1500 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'bob', currentBalance: 1500 }),
  ];
  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    stateVersion: 2,
    players,
    startedAt: '2026-08-17T00:00:00.000Z',
  });
}

test('returns true when Σ(players[].currentBalance) equals matchPool', () => {
  // Bank (17000) + Alice (1500) + Bob (1500) = 20000
  assert.equal(verifyEconomyInvariant(baseGameState(), MATCH_POOL), true);
});

test('throws EconomyInvariantError when a coin was artificially injected (sum > matchPool)', () => {
  const corrupted = baseGameState();
  corrupted.players.find((p) => p.id === 'gp-alice').currentBalance += 1; // +1 coin from nowhere

  assert.throws(() => verifyEconomyInvariant(corrupted, MATCH_POOL), EconomyInvariantError);
});

test('throws EconomyInvariantError when a coin vanished (sum < matchPool)', () => {
  const corrupted = baseGameState();
  corrupted.players.find((p) => p.id === 'gp-bob').currentBalance -= 1; // 1 coin vanished

  assert.throws(() => verifyEconomyInvariant(corrupted, MATCH_POOL), EconomyInvariantError);
});

test('the thrown error carries actionable details: matchPool, actualTotal, and signed difference', () => {
  const corrupted = baseGameState();
  corrupted.players.find((p) => p.id === 'gp-alice').currentBalance += 250;

  try {
    verifyEconomyInvariant(corrupted, MATCH_POOL);
    assert.fail('expected verifyEconomyInvariant to throw');
  } catch (error) {
    assert.ok(error instanceof EconomyInvariantError);
    assert.equal(error.name, 'EconomyInvariantError');
    assert.equal(error.matchPool, MATCH_POOL);
    assert.equal(error.actualTotal, MATCH_POOL + 250);
    assert.equal(error.difference, 250);
  }
});

test('sums every player including the Bank sentinel row, not just the real players', () => {
  const state = baseGameState();
  // Deliberately wrong pool that only accounts for Alice + Bob, omitting the Bank —
  // proves the Bank row is actually included in the sum, not silently skipped.
  assert.throws(() => verifyEconomyInvariant(state, 3000), EconomyInvariantError);
});

test('integration: the invariant still holds after a realistic sequence of applyTransaction calls', () => {
  let state = baseGameState();
  assert.equal(verifyEconomyInvariant(state, MATCH_POOL), true);

  const steps = [
    { fromPlayerId: 'gp-bank', toPlayerId: 'gp-alice', amount: 200, transactionType: 'pass_go_salary' },
    { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bank', amount: 60, transactionType: 'purchase' },
    { fromPlayerId: 'gp-bob', toPlayerId: 'gp-alice', amount: 30, transactionType: 'rent' },
    { fromPlayerId: 'gp-bank', toPlayerId: 'gp-bob', amount: 50, transactionType: 'mortgage' },
    { fromPlayerId: 'gp-bob', toPlayerId: 'gp-bank', amount: 100, transactionType: 'tax' },
  ];

  for (const request of steps) {
    ({ gameState: state } = applyTransaction(state, request));
    assert.equal(verifyEconomyInvariant(state, MATCH_POOL), true); // holds after every single transaction, not just at the end
  }
});
