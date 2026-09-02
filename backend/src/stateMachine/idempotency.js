// Action idempotency — GAME_STATE_MACHINE.md §6, points 1 and 2 only
// (true-duplicate-submission dedup, and the monotonic stateVersion
// counter). Point 3 (reconnect replay) is a client-behavior rule, not
// server mechanism — nothing to build for it here. Pure module: no I/O, no
// wall-clock reads (`now` always arrives as an input, same convention
// turnMachine.js/timers.js already established), no Socket.IO/session
// concept of any kind — none exists yet (P09 isn't built).
//
// Deliberately NOT wired into turnMachine.js — P07-T03's own plan row
// says "Files to modify: None", and turnMachine.js's file header commits
// it to staying a pure orchestrator over P05/P06 with no session or
// idempotency concept of its own. applyWithIdempotency below is the
// higher-order composition a future caller (a Socket.IO handler, P09)
// wraps *around* transitionTurn — this module never imports
// turnMachine.js, only accepts a same-shaped function as `transitionFn`,
// already bound to whatever extra arguments it needs (boardTiles, now)
// by that future caller. Keeping this decoupled is what lets it be built
// and fully tested now, without a socket layer existing yet — the same
// "pure logic before the I/O wiring" sequencing P05–P07 already used.

// GAME_STATE_MACHINE.md §6 point 1: "a short-lived per-socket cache of
// recently-processed ids ([PROPOSED] last ~60 seconds)". [PROPOSED], same
// standing as JAIL_FINE/MAX_JAIL_TURNS elsewhere in this backend —
// implemented literally pending your confirmation, not left unenforced.
export const IDEMPOTENCY_CACHE_WINDOW_SECONDS = 60;

/**
 * @typedef {Object} IdempotencyCache
 * @property {Map<string, string>} entries - clientActionId -> recordedAt (ISO timestamp)
 */

/**
 * @returns {IdempotencyCache} an empty cache
 */
export function createIdempotencyCache() {
  return { entries: new Map() };
}

/**
 * Whether clientActionId was already recorded and is still within the
 * cache window as of `now`. An entry older than
 * IDEMPOTENCY_CACHE_WINDOW_SECONDS reads as "not processed" — §6 point 1
 * describes a short-lived cache, not a permanent dedup log, so an expired
 * id is legitimately eligible to be reapplied.
 * @param {IdempotencyCache} cache
 * @param {string} clientActionId
 * @param {string} now - ISO timestamp
 * @returns {boolean}
 */
export function isActionProcessed(cache, clientActionId, now) {
  const recordedAt = cache.entries.get(clientActionId);
  if (recordedAt === undefined) {
    return false;
  }
  const ageSeconds = (new Date(now).getTime() - new Date(recordedAt).getTime()) / 1000;
  return ageSeconds < IDEMPOTENCY_CACHE_WINDOW_SECONDS;
}

/**
 * Records clientActionId as processed as of `now`. Re-recording an id
 * already present simply refreshes recordedAt — applyWithIdempotency only
 * ever calls this once per successful transition, so overlap isn't a
 * real case, just a harmless one to leave unguarded.
 * @param {IdempotencyCache} cache
 * @param {string} clientActionId
 * @param {string} now - ISO timestamp
 */
export function recordAction(cache, clientActionId, now) {
  cache.entries.set(clientActionId, now);
}

/**
 * The higher-order composition GAME_STATE_MACHINE.md §6 describes, kept
 * out of turnMachine.js itself — see the file header. Wraps any
 * transition function shaped `(gameState, action) -> { gameState,
 * transactions }`; the caller is responsible for pre-binding anything
 * else a real transitionFn needs (turnMachine.js's transitionTurn also
 * takes boardTiles/now — bind those in a closure before passing it here).
 *
 * - A clientActionId still inside the cache window is a no-op: the
 *   passed-in gameState is returned unchanged, no transactions, and
 *   transitionFn is never called — §6 point 1's "re-acknowledges without
 *   reapplying".
 * - Otherwise transitionFn runs for real. If it throws (e.g.
 *   turnMachine.js's InvalidTurnActionError for a genuinely rejected
 *   action), the throw propagates as-is and this function does nothing
 *   else — stateVersion is never touched and clientActionId is never
 *   recorded for a rejected action, matching the acceptance criteria
 *   ("never on a rejected one") without any special-case error handling.
 * - On success, stateVersion increments by exactly one relative to the
 *   *input* gameState (not whatever transitionFn's own output carries,
 *   since transitionFn has no stateVersion concept of its own), and
 *   clientActionId is recorded.
 *
 * @param {{ stateVersion: number }} gameState - at minimum carries stateVersion; in practice a full GameState (domain/gameState.js)
 * @param {{ clientActionId: string }} action - at minimum carries clientActionId; in practice a real turnMachine.js action, `{ type, payload?, clientActionId }`
 * @param {IdempotencyCache} cache
 * @param {(gameState: object, action: object) => { gameState: object, transactions: object[] }} transitionFn
 * @param {string} now - ISO timestamp; both the cache-window clock and the recorded time
 * @returns {{ gameState: object, transactions: object[], deduped: boolean }}
 */
export function applyWithIdempotency(gameState, action, cache, transitionFn, now) {
  if (!action.clientActionId) {
    throw new TypeError('applyWithIdempotency: action.clientActionId is required');
  }

  if (isActionProcessed(cache, action.clientActionId, now)) {
    return { gameState, transactions: [], deduped: true };
  }

  const result = transitionFn(gameState, action);
  recordAction(cache, action.clientActionId, now);

  // Finding #15/#20/#24's idempotencyKey collision, fixed here, 2026-08-21:
  // economy/applyTransaction.js's own idempotencyKey is `${gameId}:${stateVersion}`,
  // computed while gameState.stateVersion is still this action's OLD value
  // for the *entire* transitionFn call (this function only increments it
  // afterward, below) — so if transitionFn produced more than one real
  // transaction (an ACCEPT_TRADE with money moving both directions, Flash
  // Auction settlement plus Near-Miss rewards, ...), every one of them
  // computed the identical key. Not yet observable in production (no real
  // `game_transactions` table write exists yet — P13), but would silently
  // collide once one does. Fixed centrally, right here, rather than
  // threading a per-call sequence number through every applyTransaction
  // call site across turnMachine.js/tradeMachine.js — this is the one place
  // that already sees every transaction a single external action produced,
  // as one array, in call order, so appending that per-transaction index is
  // enough to make each key unique within the action while staying globally
  // unique across actions (the base key already differs per action, since
  // stateVersion is monotonic).
  const transactions = result.transactions.map((transaction, index) => ({
    ...transaction,
    idempotencyKey: `${transaction.idempotencyKey}:${index}`,
  }));

  return {
    gameState: { ...result.gameState, stateVersion: gameState.stateVersion + 1 },
    transactions,
    deduped: false,
  };
}
