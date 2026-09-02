// Ledger application — DATABASE_DESIGN.md §12's from/to, always-positive
// game_transactions shape. Pure function: no I/O, no database driver, no
// Express, no Socket.IO.
//
// Scope boundary (explicit, per approval): this function does the
// mechanical math only — debit fromPlayerId, credit toPlayerId, by the
// exact same amount. It does NOT enforce "balance >= 0" for regular
// players or "Bank may go negative" — that's P06-T02's job. Full
// closed-economy invariant verification across a whole game is P06-T04's.
//
// `id` and `created_at` are deliberately not part of the returned
// transaction record — both have DB-level DEFAULTs (gen_random_uuid(),
// now()) in game_transactions, and fabricating either here would make this
// function non-deterministic (a hidden randomness/current-time dependency),
// which a "pure" function in this phase shouldn't have. The DB (or whatever
// inserts this record) assigns them at write time, same as it always would.
//
// Architecture rule (revised): the Economy/Ledger layer moves money; the
// Orchestrator/Idempotency layer (stateMachine/idempotency.js, P07-T03) is
// the sole owner of GameState.stateVersion. This function used to also
// increment it on every call, which double- (or triple-)counted a single
// external action that triggers more than one transaction (e.g. a PASS_GO
// payout followed by a rent payment from one ROLL_DICE) once the
// idempotency layer added its own increment on top. Fixed by removing the
// increment here entirely — stateVersion now passes through unchanged.

export const TRANSACTION_TYPES = Object.freeze([
  'initial_balance',
  'purchase',
  'rent',
  'pass_go_salary',
  'tax',
  'event_card',
  'jail_fine',
  'build',
  'sell_house',
  'mortgage',
  'unmortgage',
  'trade',
  'flash_auction',
  'hostile_acquisition',
  'rent_gamble',
  'bankruptcy_transfer',
  'free_parking_jackpot', // Phase 14 (2026-08-19), migration 0004 — see that file's own header
]);

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {Object} request
 * @param {string} request.fromPlayerId - PlayerGameState.id being debited
 * @param {string} request.toPlayerId - PlayerGameState.id being credited
 * @param {number} request.amount - positive integer
 * @param {(typeof TRANSACTION_TYPES[number])} request.transactionType
 * @returns {{
 *   gameState: import('../domain/gameState.js').GameState,
 *   transaction: {
 *     gameId: string,
 *     fromGamePlayerId: string,
 *     toGamePlayerId: string,
 *     amount: number,
 *     transactionType: string,
 *     idempotencyKey: string,
 *     resultingBalanceFrom: number,
 *     resultingBalanceTo: number,
 *   }
 * }}
 */
export function applyTransaction(gameState, { fromPlayerId, toPlayerId, amount, transactionType }) {
  if (fromPlayerId === toPlayerId) {
    throw new TypeError('applyTransaction: fromPlayerId and toPlayerId must differ');
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TypeError(`applyTransaction: amount must be a positive integer — got ${amount}`);
  }
  if (!TRANSACTION_TYPES.includes(transactionType)) {
    throw new TypeError(`applyTransaction: unknown transactionType '${transactionType}'`);
  }

  const fromPlayer = gameState.players.find((p) => p.id === fromPlayerId);
  const toPlayer = gameState.players.find((p) => p.id === toPlayerId);
  if (!fromPlayer) {
    throw new TypeError(`applyTransaction: fromPlayerId '${fromPlayerId}' not found in gameState.players`);
  }
  if (!toPlayer) {
    throw new TypeError(`applyTransaction: toPlayerId '${toPlayerId}' not found in gameState.players`);
  }

  // Idempotency key uses the current stateVersion as a read-only input —
  // this function no longer advances the counter itself (see file header).
  //
  // The key produced HERE is deliberately not unique on its own: several
  // transactions from one external action (an ACCEPT_TRADE moving money
  // both ways, Flash Auction settlement plus Near-Miss rewards) all read
  // the same pre-increment stateVersion and so compute the same string.
  // That collision was finding #15/#20/#24 and is **RESOLVED** as of
  // 2026-08-21 — stateMachine/idempotency.js's applyWithIdempotency()
  // appends a per-transaction array index (`:0`, `:1`, …) to every
  // transaction it returns, which is the one place that sees all of an
  // action's transactions together, in call order. So the value assigned
  // below is a base, finished by the orchestrator; callers and tests
  // should expect the suffixed form. (This comment previously said the
  // collision still needed a real fix "before P13" — stale by two days,
  // corrected 2026-08-23 during a bug sweep.)
  const idempotencyKey = `${gameState.id}:${gameState.stateVersion}`;

  const resultingBalanceFrom = fromPlayer.currentBalance - amount;
  const resultingBalanceTo = toPlayer.currentBalance + amount;

  // Hard invariant, added 2026-08-25: a real player's balance can never go
  // negative. GAME_DESIGN_SPEC.md §21 has always said so, but nothing
  // actually enforced it — the rule lived only in each caller's own
  // discretionary check, and BUY_PROPERTY simply never had one, which is
  // exactly how a live match ended up with a player at $-293.
  //
  // Enforced HERE, at the single chokepoint every money movement in the
  // game passes through, rather than by auditing ~20 call sites and hoping
  // the next one added remembers: any future unguarded debit now fails
  // loudly and immediately instead of silently corrupting the economy and
  // surfacing hours later as a negative number on someone's card. Callers
  // that can legitimately refuse (a purchase, a build) still do their own
  // check first and reject with a friendly errorCode — this is the net
  // beneath them, not a replacement for them.
  //
  // The Bank is deliberately exempt: ECONOMY_SPECIFICATION.md defines it as
  // a finite but overdraftable ledger participant ("allowed to go negative,
  // no bankruptcy of its own"), which is what keeps the closed-economy
  // invariant exact. Only real players are constrained.
  if (!fromPlayer.isBank && resultingBalanceFrom < 0) {
    throw new RangeError(
      `applyTransaction: '${transactionType}' of ${amount} would take player '${fromPlayerId}' from ` +
        `${fromPlayer.currentBalance} to ${resultingBalanceFrom} — a player balance may never go negative. ` +
        `An unaffordable debt must go through settleDebt() (liquidation/bankruptcy), and an unaffordable ` +
        `voluntary purchase must be rejected before reaching this function.`
    );
  }

  const players = gameState.players.map((p) => {
    if (p.id === fromPlayerId) return { ...p, currentBalance: resultingBalanceFrom };
    if (p.id === toPlayerId) return { ...p, currentBalance: resultingBalanceTo };
    return p;
  });

  const newGameState = {
    ...gameState,
    players,
  };

  const transaction = {
    gameId: gameState.id,
    fromGamePlayerId: fromPlayerId,
    toGamePlayerId: toPlayerId,
    amount,
    transactionType,
    idempotencyKey,
    resultingBalanceFrom,
    resultingBalanceTo,
  };

  return { gameState: newGameState, transaction };
}
