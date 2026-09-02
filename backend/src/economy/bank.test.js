import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBankPlayer, getBankBalance } from './bank.js';
import { applyTransaction } from './applyTransaction.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';

const BANK_RESERVE_INITIAL = 20580; // classic Monopoly bank total, used only as a plausible starting figure for these tests
const PASS_GO_SALARY = 200; // GAME_DESIGN_SPEC.md §0, PROPOSED classic value

function baseGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: BANK_RESERVE_INITIAL }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', currentBalance: 1500 }),
  ];
  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    stateVersion: 0,
    players,
    startedAt: '2026-08-17T00:00:00.000Z',
  });
}

test('getBankPlayer finds the isBank row among other players', () => {
  const bank = getBankPlayer(baseGameState());
  assert.equal(bank.id, 'gp-bank');
  assert.equal(bank.isBank, true);
});

test('getBankPlayer throws when no Bank row exists', () => {
  const state = baseGameState();
  const noBank = { ...state, players: state.players.filter((p) => !p.isBank) };
  assert.throws(() => getBankPlayer(noBank));
});

test('getBankPlayer throws when more than one Bank row exists', () => {
  const state = baseGameState();
  const extraBank = createPlayerGameState({ id: 'gp-bank-2', gameId: 'g1', isBank: true, currentBalance: 0 });
  const twoBanks = { ...state, players: [...state.players, extraBank] };
  assert.throws(() => getBankPlayer(twoBanks));
});

test('getBankBalance returns the Bank row\'s currentBalance', () => {
  assert.equal(getBankBalance(baseGameState()), BANK_RESERVE_INITIAL);
});

test('repeated GO payouts drive the Bank balance below zero — applyTransaction never throws, no bankruptcy logic is involved', () => {
  let state = baseGameState();

  // Enough PASS_GO_SALARY payouts, with no offsetting purchases, to exceed BANK_RESERVE_INITIAL.
  const payoutsNeeded = Math.floor(BANK_RESERVE_INITIAL / PASS_GO_SALARY) + 5;

  for (let i = 0; i < payoutsNeeded; i++) {
    const { gameState: next } = applyTransaction(state, {
      fromPlayerId: 'gp-bank',
      toPlayerId: 'gp-alice',
      amount: PASS_GO_SALARY,
      transactionType: 'pass_go_salary',
    });
    state = next; // applyTransaction never throws, even once the Bank goes negative
  }

  const finalBankBalance = getBankBalance(state);
  const alice = state.players.find((p) => p.id === 'gp-alice');

  assert.equal(finalBankBalance, BANK_RESERVE_INITIAL - payoutsNeeded * PASS_GO_SALARY);
  assert.ok(finalBankBalance < 0, 'Bank balance should have gone negative — that is the point of this test');
  assert.equal(alice.currentBalance, 1500 + payoutsNeeded * PASS_GO_SALARY);
  assert.equal(state.stateVersion, 0); // unchanged — applyTransaction no longer owns stateVersion
});

test('the Bank going negative does not corrupt or special-case anything on the receiving player', () => {
  let state = baseGameState();
  for (let i = 0; i < 200; i++) {
    ({ gameState: state } = applyTransaction(state, {
      fromPlayerId: 'gp-bank',
      toPlayerId: 'gp-alice',
      amount: PASS_GO_SALARY,
      transactionType: 'pass_go_salary',
    }));
  }

  const alice = state.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.bankrupt, false);
  assert.equal(alice.currentBalance, 1500 + 200 * PASS_GO_SALARY);
});
