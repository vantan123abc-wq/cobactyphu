import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayerGameState,
  createGameState,
  GAME_STATUSES,
  GAME_PHASES,
} from './gameState.js';

test('constructs a real player row', () => {
  const player = createPlayerGameState({
    id: 'gp1',
    gameId: 'g1',
    playerId: 'profile1',
    turnOrder: 0,
    currentBalance: 1500,
  });

  assert.equal(player.isBank, false);
  assert.equal(player.playerId, 'profile1');
  assert.equal(player.currentPosition, 0);
});

test('constructs the Bank sentinel row (isBank true, playerId null)', () => {
  const bank = createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 1000000 });

  assert.equal(bank.isBank, true);
  assert.equal(bank.playerId, null);
});

test('a fresh player defaults every Win Condition/game-end field to null/false — nothing pre-set before a match actually ends', () => {
  const player = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'profile1', turnOrder: 0, currentBalance: 1500 });

  assert.equal(player.bankrupt, false);
  assert.equal(player.bankruptAt, null);
  assert.equal(player.finalRank, null);
  assert.equal(player.finalNetWorth, null);
  assert.equal(player.finalCash, null);
  assert.equal(player.finalPropertyValue, null);
});

test('createPlayerGameState accepts explicit final-standing values (matches settleGameEnd()s own write shape)', () => {
  const player = createPlayerGameState({
    id: 'gp1',
    gameId: 'g1',
    playerId: 'profile1',
    currentBalance: 0,
    bankrupt: true,
    bankruptAt: '2026-08-19T00:00:00.000Z',
    finalRank: 2,
    finalNetWorth: 0,
    finalCash: 0,
    finalPropertyValue: 0,
  });

  assert.equal(player.finalRank, 2);
  assert.equal(player.finalNetWorth, 0);
});

test('zodiac (2026-08-22): defaults null, but accepts an explicit value (room.controller.js\'s initializeGameState() own write shape)', () => {
  const noZodiac = createPlayerGameState({ id: 'gp1', gameId: 'g1', playerId: 'profile1', turnOrder: 0, currentBalance: 1500 });
  assert.equal(noZodiac.zodiac, null);

  const withZodiac = createPlayerGameState({
    id: 'gp2',
    gameId: 'g1',
    playerId: 'profile2',
    turnOrder: 1,
    currentBalance: 1500,
    zodiac: 'thin', // Rồng (dragon)
  });
  assert.equal(withZodiac.zodiac, 'thin');
});

test('rejects isBank/playerId combinations that violate the game_players CHECK constraint', () => {
  assert.throws(() =>
    createPlayerGameState({ id: 'gp1', gameId: 'g1', isBank: true, playerId: 'profile1', currentBalance: 0 })
  );
  assert.throws(() =>
    createPlayerGameState({ id: 'gp1', gameId: 'g1', isBank: false, playerId: null, currentBalance: 0 })
  );
});

test('constructs an in-progress GameState with a phase set', () => {
  const state = createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    startedAt: '2026-08-17T00:00:00.000Z',
  });

  assert.equal(state.status, 'in_progress');
  assert.equal(state.phase, 'POST_ACTIONS');
  assert.deepEqual(state.players, []);
  assert.deepEqual(state.properties, []);
});

test('lastRollWasDouble defaults to null and can be set explicitly', () => {
  const fresh = createGameState({ id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', startedAt: 'now' });
  assert.equal(fresh.lastRollWasDouble, null);

  const mid = createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    startedAt: 'now',
    lastRollWasDouble: true,
  });
  assert.equal(mid.lastRollWasDouble, true);
});

test('constructs a finished GameState with no phase', () => {
  const state = createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'finished',
    startedAt: '2026-08-17T00:00:00.000Z',
    endedAt: '2026-08-17T01:00:00.000Z',
  });

  assert.equal(state.phase, null);
});

test('every declared status and phase is accepted individually', () => {
  for (const status of GAME_STATUSES) {
    assert.doesNotThrow(() =>
      createGameState({ id: 'g', roomId: 'r', boardId: 'small', status, startedAt: 'now' })
    );
  }
  for (const phase of GAME_PHASES) {
    assert.doesNotThrow(() =>
      createGameState({ id: 'g', roomId: 'r', boardId: 'small', status: 'in_progress', phase, startedAt: 'now' })
    );
  }
});

test('rejects an unknown status or phase', () => {
  assert.throws(() =>
    createGameState({ id: 'g', roomId: 'r', boardId: 'small', status: 'waiting_for_players', startedAt: 'now' })
  );
  assert.throws(() =>
    createGameState({
      id: 'g',
      roomId: 'r',
      boardId: 'small',
      status: 'in_progress',
      // A still-[PROPOSED], not-yet-wired mechanic's phase name — FLASH_AUCTION_ACTIVE
      // used to serve this role until P07-T06 added it to GAME_PHASES for real.
      phase: 'HOSTILE_ACQUISITION_PENDING',
      startedAt: 'now',
    })
  );
});

test('pendingLiquidation/roundNumber/finalPhaseStartedAtRound default correctly and can be set explicitly (Win Condition design)', () => {
  const fresh = createGameState({ id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', startedAt: 'now' });
  assert.equal(fresh.pendingLiquidation, null);
  assert.equal(fresh.roundNumber, 0);
  assert.equal(fresh.finalPhaseStartedAtRound, null);

  const mid = createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    startedAt: 'now',
    pendingLiquidation: { debtorId: 'gp1', creditorId: 'gp2', amount: 100, transactionType: 'rent' },
    roundNumber: 21,
    finalPhaseStartedAtRound: 20,
  });
  assert.deepEqual(mid.pendingLiquidation, { debtorId: 'gp1', creditorId: 'gp2', amount: 100, transactionType: 'rent' });
  assert.equal(mid.roundNumber, 21);
  assert.equal(mid.finalPhaseStartedAtRound, 20);
});

test('Phase 14 fields: houseSupply/hotelSupply default to the classic physical set, freeParkingJackpot/pendingHostileBuyoutPropertyId default empty, all explicitly settable', () => {
  const fresh = createGameState({ id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', startedAt: 'now' });
  assert.equal(fresh.houseSupply, 32);
  assert.equal(fresh.hotelSupply, 12);
  assert.equal(fresh.freeParkingJackpot, 0);
  assert.equal(fresh.pendingHostileBuyoutPropertyId, null);

  const mid = createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    startedAt: 'now',
    houseSupply: 10,
    hotelSupply: 3,
    freeParkingJackpot: 450,
    pendingHostileBuyoutPropertyId: 'p1',
  });
  assert.equal(mid.houseSupply, 10);
  assert.equal(mid.hotelSupply, 3);
  assert.equal(mid.freeParkingJackpot, 450);
  assert.equal(mid.pendingHostileBuyoutPropertyId, 'p1');
});

test('rejects a phase set on a non-in_progress game', () => {
  assert.throws(() =>
    createGameState({
      id: 'g',
      roomId: 'r',
      boardId: 'small',
      status: 'finished',
      phase: 'POST_ACTIONS',
      startedAt: 'now',
    })
  );
});
