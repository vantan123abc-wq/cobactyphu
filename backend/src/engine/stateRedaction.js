// Per-viewer state redaction — ASYMMETRIC_MODE_SPEC.md's own premise for
// DENIAL/JUMP-vs-ECONOMY ("bluff", "đọc vị") only holds if hands are
// actually hidden. Until this file existed, socketServer.js broadcast one
// shared GameState to the whole room (`io.to(roomId).emit(...)`) — every
// player's movementHand was visible to everyone, always. synergyEngine.js's
// own DENIAL comments flagged this exact gap as "INERT until redaction
// lands"; this is that redaction.
//
// Pure and allocation-light on purpose (the caller runs this once per
// connected socket, on every single state broadcast): `maskPlayer` returns
// the SAME player object, untouched, in every case where nothing needs
// hiding — own hand, the Bank sentinel row, an empty hand, a fully-revealed
// hand — and only allocates a new object for a real opponent whose hand
// actually needs masking. `maskGameState` itself is a single shallow
// `{...gameState, players: [...]}` — nothing under `properties`,
// `activeTraps`, `movementDeck`, etc. is touched or copied, because none of
// it is currently secret (only a player's own movementHand is — CoBacTyPhu
// has no hidden deeds, no hidden money, no bäy invisible to their owner).

/** Sentinel standing in for a real cardId in a redacted hand — never a real
 * key in movementDictionary.js's MOVEMENT_CARDS, so a client can distinguish
 * "face-down card" from any real card by a simple equality check. */
export const HIDDEN_CARD = 'HIDDEN';

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {string|null|undefined} viewerId - the PlayerGameState.id this copy
 *   is being prepared for. A value that matches no real player (null,
 *   undefined, or a stale id) is NOT a bug to guard against — it's the safe
 *   default: nothing in `maskPlayer` below can ever match it, so every
 *   opponent hand comes back fully hidden, which is the correct behavior for
 *   an unrecognized viewer rather than a special case worth branching on.
 * @returns {import('../domain/gameState.js').GameState} CLASSIC: the exact
 *   same reference, untouched — there is nothing to redact and no ASYMMETRIC
 *   overhead should leak into a CLASSIC broadcast. ASYMMETRIC: a shallow copy
 *   with each opponent's movementHand replaced per maskPlayer's rules.
 */
export function maskGameState(gameState, viewerId) {
  if (gameState.ruleset !== 'ASYMMETRIC') return gameState;

  return {
    ...gameState,
    players: gameState.players.map((player) => maskPlayer(player, viewerId, gameState.roundNumber)),
  };
}

/**
 * @param {import('../domain/gameState.js').PlayerGameState} player
 * @param {string|null|undefined} viewerId
 * @param {number} currentRound - gameState.roundNumber, needed to evaluate a
 *   handRevealedTo entry's untilRound expiry
 */
function maskPlayer(player, viewerId, currentRound) {
  // Own hand, the Bank (isBank rows carry no movementHand concept at all),
  // and an empty hand (nothing to hide either way) all pass straight
  // through — same object reference, zero allocation.
  if (player.isBank || player.id === viewerId || !player.movementHand?.length) {
    return player;
  }

  // DENIAL's reveal (synergyEngine.js's REVEAL_NEXT_CARD/REVEAL_HAND,
  // applyCardEffect's own handRevealedTo writer) — the one case an
  // opponent's hand becomes visible to someone who isn't its owner. Lazily
  // expired here at read time (currentRound <= untilRound) rather than
  // pruned when it lapses; a stale entry left behind just stops matching,
  // the same lazy-expiry convention propertyProtection's own field already
  // uses elsewhere in this codebase.
  const reveal = player.handRevealedTo?.find((r) => r.viewerId === viewerId && currentRound <= r.untilRound);

  if (reveal?.scope === 'FULL') {
    return player; // landing's 2-round full reveal — everything visible
  }

  if (reveal?.scope === 'NEXT_CARD') {
    // Pass-through's lighter reveal is genuinely underspecified beyond
    // "one card, not the whole hand": PLAY_MOVEMENT_CARD lets a player play
    // ANY card in their hand by id, not a fixed head-of-queue order, so
    // there is no real "the next card" to point at. Index 0 is the least-
    // arbitrary reading available (the array's own first slot) — worth
    // revisiting if a real "next card" concept (a queue, a marked card)
    // ever gets designed, but until then this is what REVEAL_NEXT_CARD
    // actually reveals.
    return { ...player, movementHand: player.movementHand.map((cardId, i) => (i === 0 ? cardId : HIDDEN_CARD)) };
  }

  return { ...player, movementHand: player.movementHand.map(() => HIDDEN_CARD) };
}
