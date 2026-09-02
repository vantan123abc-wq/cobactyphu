import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, TRANSACTION_TYPES } from './applyTransaction.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';

function baseGameState(overrides = {}) {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 1000000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', currentBalance: 1500 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'bob', currentBalance: 1500 }),
  ];
  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    stateVersion: 5,
    players,
    startedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  });
}

test('normal transfer debits one player, credits the other, by the same amount', () => {
  const before = baseGameState();
  const { gameState: after, transaction } = applyTransaction(before, {
    fromPlayerId: 'gp-alice',
    toPlayerId: 'gp-bob',
    amount: 200,
    transactionType: 'rent',
  });

  const alice = after.players.find((p) => p.id === 'gp-alice');
  const bob = after.players.find((p) => p.id === 'gp-bob');
  assert.equal(alice.currentBalance, 1300);
  assert.equal(bob.currentBalance, 1700);
  assert.equal(transaction.resultingBalanceFrom, 1300);
  assert.equal(transaction.resultingBalanceTo, 1700);
  assert.equal(transaction.amount, 200);
  assert.equal(transaction.transactionType, 'rent');
});

test('stateVersion is left strictly untouched — the Economy layer no longer owns it', () => {
  const before = baseGameState({ stateVersion: 5 });
  const { gameState: after } = applyTransaction(before, {
    fromPlayerId: 'gp-alice',
    toPlayerId: 'gp-bob',
    amount: 50,
    transactionType: 'trade',
  });

  assert.equal(after.stateVersion, 5); // exactly the input value, not incremented
});

test('idempotencyKey is built from stateVersion as a read-only input (no longer incremented here)', () => {
  const before = baseGameState({ stateVersion: 5 });
  const { transaction } = applyTransaction(before, {
    fromPlayerId: 'gp-alice',
    toPlayerId: 'gp-bob',
    amount: 50,
    transactionType: 'trade',
  });

  assert.equal(transaction.idempotencyKey, 'g1:5');
});

test('the transaction record has no id or createdAt — those are DB-assigned, not fabricated here', () => {
  const before = baseGameState();
  const { transaction } = applyTransaction(before, {
    fromPlayerId: 'gp-alice',
    toPlayerId: 'gp-bob',
    amount: 50,
    transactionType: 'trade',
  });

  assert.equal('id' in transaction, false);
  assert.equal('createdAt' in transaction, false);
});

test('the original gameState is not mutated', () => {
  const before = baseGameState();
  const aliceBefore = before.players.find((p) => p.id === 'gp-alice').currentBalance;

  applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bob', amount: 200, transactionType: 'rent' });

  assert.equal(before.stateVersion, 5);
  assert.equal(before.players.find((p) => p.id === 'gp-alice').currentBalance, aliceBefore);
});

test('self-transfer is rejected', () => {
  const before = baseGameState();
  assert.throws(() =>
    applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-alice', amount: 100, transactionType: 'trade' })
  );
});

test('zero or negative amount is rejected', () => {
  const before = baseGameState();
  assert.throws(() =>
    applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bob', amount: 0, transactionType: 'trade' })
  );
  assert.throws(() =>
    applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bob', amount: -50, transactionType: 'trade' })
  );
});

test('a non-integer amount is rejected', () => {
  const before = baseGameState();
  assert.throws(() =>
    applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bob', amount: 10.5, transactionType: 'trade' })
  );
});

test('an unknown transactionType is rejected', () => {
  const before = baseGameState();
  assert.throws(() =>
    applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bob', amount: 100, transactionType: 'bribery' })
  );
});

test('every declared transactionType is accepted', () => {
  const before = baseGameState();
  for (const transactionType of TRANSACTION_TYPES) {
    assert.doesNotThrow(() =>
      applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bob', amount: 1, transactionType })
    );
  }
});

test('an unknown fromPlayerId or toPlayerId is rejected', () => {
  const before = baseGameState();
  assert.throws(() =>
    applyTransaction(before, { fromPlayerId: 'gp-ghost', toPlayerId: 'gp-bob', amount: 100, transactionType: 'trade' })
  );
  assert.throws(() =>
    applyTransaction(before, { fromPlayerId: 'gp-alice', toPlayerId: 'gp-ghost', amount: 100, transactionType: 'trade' })
  );
});

// REVERSED 2026-08-25. This test previously asserted the OPPOSITE — that a
// regular player CAN go negative here, on the stated grounds that enforcing
// `>= 0` was "P06-T02's job, not P06-T01's". That hand-off never actually
// happened at any global level: the rule ended up living only inside each
// caller's own discretionary check, and BUY_PROPERTY never had one, so a
// real live match produced a player sitting at $-293. The invariant is now
// enforced at this chokepoint, the one place every money movement passes
// through.
test('a real player can never be driven negative — enforced here, at the one chokepoint all money passes through', () => {
  const before = baseGameState();
  assert.throws(
    () =>
      applyTransaction(before, {
        fromPlayerId: 'gp-alice',
        toPlayerId: 'gp-bob',
        amount: 5000, // far more than alice's 1500
        transactionType: 'rent',
      }),
    RangeError
  );

  // Paying down to exactly zero stays legal — the boundary is `< 0`, not `<= 0`.
  const { gameState: after } = applyTransaction(before, {
    fromPlayerId: 'gp-alice',
    toPlayerId: 'gp-bob',
    amount: 1500,
    transactionType: 'rent',
  });
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 0);
});

test('the Bank is exempt from the non-negative rule — a deliberately overdraftable ledger participant', () => {
  // ECONOMY_SPECIFICATION.md: the Bank is finite but allowed to go negative,
  // with no bankruptcy of its own — that is what keeps the closed-economy
  // invariant exact, so the guard above must never apply to it.
  const before = baseGameState();
  const bank = before.players.find((p) => p.isBank);
  const { gameState: after } = applyTransaction(before, {
    fromPlayerId: bank.id,
    toPlayerId: 'gp-alice',
    amount: bank.currentBalance + 500,
    transactionType: 'pass_go_salary',
  });
  assert.equal(after.players.find((p) => p.isBank).currentBalance, -500);
});
