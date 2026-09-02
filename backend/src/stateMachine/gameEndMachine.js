// Win Condition & Game-End — the hybrid model from the approved design
// (2026-08-19): a player wins immediately the instant only one non-bankrupt
// player remains (checked after every bankruptcy, not just at Final
// Phase); otherwise, once the game reaches FINAL_PHASE_TRIGGER_ROUND, a
// FINAL_PHASE_DURATION_ROUNDS-round countdown begins, and the still-
// solvent player with the highest Net Worth wins when it ends. Pure
// functions only: no I/O, no mutation, no wall-clock reads — turnMachine.js
// is what actually applies these decisions to GameState (voiding pending
// trades/auctions, setting status/finalRank), the same "compute here,
// mutate there" boundary every other engine-layer module in this backend
// already draws.
//
// Deliberately not built as separate observable GAME_PHASES values
// (LIQUIDATING/PLAYER_ELIMINATED/GAME_OVER_CHECK, as GAME_STATE_MACHINE.md
// §2's diagram names them) — nothing ever needs to *act* while any of
// those would be current, so turnMachine.js collapses them into instant
// sub-steps around calls into this file instead. A deliberate simplification
// of that diagram, not an oversight — see the Win Condition design doc §E4.

import { propertyNetWorth } from '../engine/netWorth.js';

// RAISED 20 -> 45 on 2026-08-25, on an explicit user decision, and the
// reasoning matters more than the number: at 20 the net-worth ending was not
// a safeguard, it was the NORMAL way a match ended. 25 rounds is simply not
// long enough to eliminate every opponent in a Monopoly-shaped game, so in
// practice the primary win condition had become "richest at round 25" and
// Last Tycoon Standing was the exception — an inversion of the approved
// design (BOARD_SPECIFICATION.md / GAME_DESIGN_SPEC.md §17), and precisely
// the passive-play risk the win-condition proposal itself called out ("nếu
// người chơi biết 'Tôi chỉ cần có Net Worth cao hơn' thì họ có thể chơi cực
// kỳ thụ động").
//
// At 45 the countdown is a genuine rare backstop: elimination is the real
// race again, and the net-worth ending exists only to stop a stalemate
// running forever. The match is still GUARANTEED to end — that property was
// never up for negotiation, only how often it decides the winner.
export const FINAL_PHASE_TRIGGER_ROUND = 45;
export const FINAL_PHASE_DURATION_ROUNDS = 5; // long enough for a real "final stretch" of decisions; short enough to stay urgent

/**
 * Elimination win: exactly one non-bankrupt real player remains. Checked
 * by the caller after every bankruptcy resolves, not just at turn
 * boundaries — a single rent payment that bankrupts the second-to-last
 * player ends the game on the spot (GAME_DESIGN_SPEC.md §17's own words).
 * @param {import('../domain/gameState.js').GameState} gameState
 * @returns {{ isOver: boolean, winnerId: string|null }}
 */
export function checkElimination(gameState) {
  const active = gameState.players.filter((p) => !p.isBank && !p.bankrupt);
  return active.length === 1 ? { isOver: true, winnerId: active[0].id } : { isOver: false, winnerId: null };
}

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @returns {boolean} true exactly once — the caller is expected to set finalPhaseStartedAtRound immediately after acting on this, which makes it false again next time
 */
export function shouldEnterFinalPhase(gameState) {
  return gameState.finalPhaseStartedAtRound === null && gameState.roundNumber >= FINAL_PHASE_TRIGGER_ROUND;
}

/** @param {import('../domain/gameState.js').GameState} gameState @returns {boolean} */
export function shouldEndFinalPhase(gameState) {
  return (
    gameState.finalPhaseStartedAtRound !== null &&
    gameState.roundNumber >= gameState.finalPhaseStartedAtRound + FINAL_PHASE_DURATION_ROUNDS
  );
}

/**
 * Full standings for every real (non-Bank) player — Win Condition design
 * §L's tie-break order for solvent players (net worth desc, then property
 * value desc, then cash desc, then turnOrder asc — always decisive, never
 * undefined), with bankrupt players ranked below all solvent ones, ordered
 * by bankruptAt descending (most-recently-bankrupted first — they survived
 * longer, GAME_DESIGN_SPEC.md §22's own "most recently bankrupted = higher
 * placement" convention, extended here to also cover the net-worth ending,
 * not just pure elimination).
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @returns {Array<{ playerId: string, rank: number, netWorth: number, cash: number, propertyValue: number }>} rank is 1-indexed, 1 = winner; cash/propertyValue are netWorth's own two components, carried through for the frontend Game Over screen's breakdown line (Win Condition design §I) rather than making the caller re-derive them
 */
export function rankPlayers(gameState, boardTiles) {
  const realPlayers = gameState.players.filter((p) => !p.isBank);

  const solvent = realPlayers
    .filter((p) => !p.bankrupt)
    .map((p) => {
      const propertyValue = gameState.properties
        .filter((prop) => prop.ownerId === p.id)
        .reduce((sum, prop) => {
          const tile = boardTiles.find((t) => t.id === prop.boardTileId);
          return sum + propertyNetWorth(tile, prop);
        }, 0);
      return { playerId: p.id, netWorth: p.currentBalance + propertyValue, propertyValue, cash: p.currentBalance, turnOrder: p.turnOrder };
    })
    .sort((a, b) => {
      if (b.netWorth !== a.netWorth) return b.netWorth - a.netWorth;
      if (b.propertyValue !== a.propertyValue) return b.propertyValue - a.propertyValue;
      if (b.cash !== a.cash) return b.cash - a.cash;
      return a.turnOrder - b.turnOrder;
    });

  const bankrupt = realPlayers
    .filter((p) => p.bankrupt)
    .sort((a, b) => new Date(b.bankruptAt).getTime() - new Date(a.bankruptAt).getTime())
    .map((p) => ({ playerId: p.id, netWorth: 0, cash: 0, propertyValue: 0 })); // a real bankruptcy transfers everything away — there is nothing left to break down

  return [
    ...solvent.map(({ playerId, netWorth, cash, propertyValue }) => ({ playerId, netWorth, cash, propertyValue })),
    ...bankrupt,
  ].map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));
}
