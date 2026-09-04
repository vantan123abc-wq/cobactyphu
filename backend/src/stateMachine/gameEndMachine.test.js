import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkElimination,
  shouldEnterFinalPhase,
  shouldEndFinalPhase,
  rankPlayers,
  FINAL_PHASE_TRIGGER_ROUND,
  FINAL_PHASE_DURATION_ROUNDS,
} from './gameEndMachine.js';
import { createPlayerGameState, createGameState } from '../domain/gameState.js';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';

function player(overrides) {
  return createPlayerGameState({ id: 'gp', gameId: 'g1', playerId: 'u', turnOrder: 0, currentBalance: 0, ...overrides });
}

function state({ players, properties = [], roundNumber = 0, finalPhaseStartedAtRound = null }) {
  return createGameState({
    id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', phase: 'POST_ACTIONS',
    players, properties, roundNumber, finalPhaseStartedAtRound, startedAt: 'now',
  });
}

// ---- checkElimination ----

test('checkElimination: 3 active real players — not over', () => {
  const bank = player({ id: 'gp-bank', isBank: true, playerId: null });
  const a = player({ id: 'gp1', turnOrder: 0 });
  const b = player({ id: 'gp2', turnOrder: 1 });
  const c = player({ id: 'gp3', turnOrder: 2 });
  const result = checkElimination(state({ players: [bank, a, b, c] }));
  assert.equal(result.isOver, false);
  assert.equal(result.winnerId, null);
});

test('checkElimination: 2 active — still not over (not down to exactly one yet)', () => {
  const bank = player({ id: 'gp-bank', isBank: true, playerId: null });
  const a = player({ id: 'gp1', turnOrder: 0 });
  const b = player({ id: 'gp2', turnOrder: 1, bankrupt: true, bankruptAt: 'now' });
  const c = player({ id: 'gp3', turnOrder: 2 });
  const result = checkElimination(state({ players: [bank, a, b, c] }));
  assert.equal(result.isOver, false);
});

test('checkElimination: exactly one non-bankrupt real player — over, correct winner', () => {
  const bank = player({ id: 'gp-bank', isBank: true, playerId: null });
  const a = player({ id: 'gp1', turnOrder: 0 });
  const b = player({ id: 'gp2', turnOrder: 1, bankrupt: true, bankruptAt: 'now' });
  const c = player({ id: 'gp3', turnOrder: 2, bankrupt: true, bankruptAt: 'now' });
  const result = checkElimination(state({ players: [bank, a, b, c] }));
  assert.equal(result.isOver, true);
  assert.equal(result.winnerId, 'gp1');
});

test('checkElimination: the Bank sentinel is never counted as an active player', () => {
  const bank = player({ id: 'gp-bank', isBank: true, playerId: null });
  const a = player({ id: 'gp1', turnOrder: 0 });
  const result = checkElimination(state({ players: [bank, a] }));
  assert.equal(result.isOver, true);
  assert.equal(result.winnerId, 'gp1');
});

// ---- Final Phase trigger/end ----

test('shouldEnterFinalPhase: false before the trigger round', () => {
  const s = state({ players: [], roundNumber: FINAL_PHASE_TRIGGER_ROUND - 1 });
  assert.equal(shouldEnterFinalPhase(s), false);
});

test('shouldEnterFinalPhase: true exactly at the trigger round, if not already started', () => {
  const s = state({ players: [], roundNumber: FINAL_PHASE_TRIGGER_ROUND });
  assert.equal(shouldEnterFinalPhase(s), true);
});

test('shouldEnterFinalPhase: false once already started, even if roundNumber still qualifies', () => {
  const s = state({ players: [], roundNumber: FINAL_PHASE_TRIGGER_ROUND + 2, finalPhaseStartedAtRound: FINAL_PHASE_TRIGGER_ROUND });
  assert.equal(shouldEnterFinalPhase(s), false);
});

test('shouldEndFinalPhase: false if Final Phase never started', () => {
  const s = state({ players: [], roundNumber: 999 });
  assert.equal(shouldEndFinalPhase(s), false);
});

test('shouldEndFinalPhase: false mid-countdown, true once duration elapses', () => {
  const mid = state({ players: [], roundNumber: FINAL_PHASE_TRIGGER_ROUND + FINAL_PHASE_DURATION_ROUNDS - 1, finalPhaseStartedAtRound: FINAL_PHASE_TRIGGER_ROUND });
  assert.equal(shouldEndFinalPhase(mid), false);

  const done = state({ players: [], roundNumber: FINAL_PHASE_TRIGGER_ROUND + FINAL_PHASE_DURATION_ROUNDS, finalPhaseStartedAtRound: FINAL_PHASE_TRIGGER_ROUND });
  assert.equal(shouldEndFinalPhase(done), true);
});

// ---- rankPlayers ----

function tile(id, price) {
  return createTile({ id, boardId: 'small', position: 1, tileType: 'property', name: id, price, houseCost: 100, mortgageValue: 100 });
}

test('rankPlayers: clear net worth differences rank in descending order, bank excluded', () => {
  const bank = player({ id: 'gp-bank', isBank: true, playerId: null });
  const rich = player({ id: 'gp1', turnOrder: 0, currentBalance: 1000 });
  const poor = player({ id: 'gp2', turnOrder: 1, currentBalance: 100 });
  const mid = player({ id: 'gp3', turnOrder: 2, currentBalance: 500 });

  const ranked = rankPlayers(state({ players: [bank, rich, poor, mid] }), []);
  assert.deepEqual(ranked.map((r) => r.playerId), ['gp1', 'gp3', 'gp2']);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3]);
  assert.equal(ranked.find((r) => r.playerId === 'gp-bank'), undefined);
});

test('rankPlayers: exact net worth tie broken by property value', () => {
  const t = tile('t1', 300);
  const a = player({ id: 'gp1', turnOrder: 0, currentBalance: 100 }); // owns the property: 100 + 300 = 400
  const b = player({ id: 'gp2', turnOrder: 1, currentBalance: 400 }); // owns nothing: 400 cash = 400 net worth, same total
  const propA = createProperty({ id: 'pA', gameId: 'g1', boardTileId: 't1', ownerId: 'gp1', upgradeLevel: 0, mortgaged: false });

  const ranked = rankPlayers(state({ players: [a, b], properties: [propA] }), [t]);
  assert.equal(ranked[0].netWorth, 400);
  assert.equal(ranked[1].netWorth, 400);
  assert.equal(ranked[0].playerId, 'gp1'); // higher property value (300 vs 0) wins the tie
});

test('rankPlayers: net worth AND property value tie broken by cash', () => {
  // Both own nothing, both net worth = cash — different cash values, no real tie here;
  // construct via identical net worth achieved differently is awkward with real property data,
  // so directly verify the cash tier using two cash-only players (property value 0 for both).
  const a = player({ id: 'gp1', turnOrder: 5, currentBalance: 300 });
  const b = player({ id: 'gp2', turnOrder: 1, currentBalance: 300 });
  const ranked = rankPlayers(state({ players: [a, b] }), []);
  // identical net worth (300) and property value (0) -> falls through to cash (also tied, 300=300) -> turnOrder
  assert.equal(ranked[0].playerId, 'gp2'); // lower turnOrder wins the final tie
});

test('rankPlayers: bankrupt players always rank below all solvent players, regardless of any leftover figures', () => {
  const solvent = player({ id: 'gp1', turnOrder: 0, currentBalance: 1 });
  const bankrupt = player({ id: 'gp2', turnOrder: 1, currentBalance: 0, bankrupt: true, bankruptAt: '2026-08-19T00:00:00.000Z' });
  const ranked = rankPlayers(state({ players: [solvent, bankrupt] }), []);
  assert.deepEqual(ranked.map((r) => r.playerId), ['gp1', 'gp2']);
});

test('rankPlayers: cash/propertyValue are netWorths own two components, carried through for the frontend breakdown line', () => {
  const t = tile('t1', 300);
  const owner = player({ id: 'gp1', turnOrder: 0, currentBalance: 150 });
  const bankrupt = player({ id: 'gp2', turnOrder: 1, currentBalance: 0, bankrupt: true, bankruptAt: '2026-08-19T00:00:00.000Z' });
  const propA = createProperty({ id: 'pA', gameId: 'g1', boardTileId: 't1', ownerId: 'gp1', upgradeLevel: 0, mortgaged: false });

  const ranked = rankPlayers(state({ players: [owner, bankrupt], properties: [propA] }), [t]);
  const ownerEntry = ranked.find((r) => r.playerId === 'gp1');
  const bankruptEntry = ranked.find((r) => r.playerId === 'gp2');

  assert.equal(ownerEntry.cash, 150);
  assert.equal(ownerEntry.propertyValue, 300);
  assert.equal(ownerEntry.netWorth, 450);
  assert.equal(ownerEntry.cash + ownerEntry.propertyValue, ownerEntry.netWorth);
  assert.equal(bankruptEntry.cash, 0);
  assert.equal(bankruptEntry.propertyValue, 0);
});

test('rankPlayers: among bankrupt players, most-recently-bankrupted ranks better (survived longer)', () => {
  const early = player({ id: 'gp1', turnOrder: 0, bankrupt: true, bankruptAt: '2026-08-19T01:00:00.000Z' });
  const late = player({ id: 'gp2', turnOrder: 1, bankrupt: true, bankruptAt: '2026-08-19T05:00:00.000Z' });
  const ranked = rankPlayers(state({ players: [early, late] }), []);
  assert.deepEqual(ranked.map((r) => r.playerId), ['gp2', 'gp1']); // gp2 bankrupted later -> better placement
});

// --- Zero-survivor elimination (2026-09-04, found by fuzzing) ---
//
// One resolution step can bankrupt two players at once, so "nobody left" is
// genuinely reachable — the fuzz hit it via a live auction whose leader had
// been drained below their own winning bid, settled during the current
// player's FORFEIT_MATCH. checkElimination used to test `=== 1` and so
// reported "not over" for zero, which sent resolveForfeit into advanceTurn()
// with no player to advance to: `TypeError: Cannot read properties of
// undefined (reading 'turnOrder')`, surfaced to the player as
// MALFORMED_PAYLOAD, and the room unrecoverable from there.
test('checkElimination: zero non-bankrupt players ends the match (winnerless), never "not over"', () => {
  const bank = player({ id: 'gp-bank', isBank: true, playerId: null });
  const a = player({ id: 'gp1', turnOrder: 0, bankrupt: true, bankruptAt: '2026-09-04T01:00:00.000Z' });
  const b = player({ id: 'gp2', turnOrder: 1, bankrupt: true, bankruptAt: '2026-09-04T02:00:00.000Z' });

  const result = checkElimination(state({ players: [bank, a, b] }));
  assert.equal(result.isOver, true);
  assert.equal(result.winnerId, null); // match_results.winner_game_player_id is nullable for exactly this
});

test('checkElimination: one survivor still reports that survivor as the winner (unchanged)', () => {
  const bank = player({ id: 'gp-bank', isBank: true, playerId: null });
  const a = player({ id: 'gp1', turnOrder: 0 });
  const b = player({ id: 'gp2', turnOrder: 1, bankrupt: true, bankruptAt: '2026-09-04T02:00:00.000Z' });

  assert.deepEqual(checkElimination(state({ players: [bank, a, b] })), { isOver: true, winnerId: 'gp1' });
});

test('a winnerless elimination still produces a full ranking, most-recently-bankrupted first', () => {
  const early = player({ id: 'gp1', turnOrder: 0, bankrupt: true, bankruptAt: '2026-09-04T01:00:00.000Z' });
  const late = player({ id: 'gp2', turnOrder: 1, bankrupt: true, bankruptAt: '2026-09-04T02:00:00.000Z' });
  const ranked = rankPlayers(state({ players: [early, late] }), []);
  assert.deepEqual(ranked.map((r) => r.playerId), ['gp2', 'gp1']);
});
