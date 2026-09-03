// Mirrors backend/src/domain/movementDictionary.js's MOVEMENT_CARDS exactly
// — no shared package between frontend/backend in this repo, same standing
// as every other mirrored backend constant already in this codebase
// (GameControls.jsx's own JAIL_FINE, PropertyActionDrawer.jsx/BoardTile.jsx's
// MAX_UPGRADE_LEVEL). Keep in sync by hand if the backend deck ever changes —
// there is no runtime fetch for this the way GET /api/v1/boards or
// /api/v1/event-cards exist for board tiles/event cards, because unlike
// those two this is small, fixed, and ships with the client build already.
//
// `random`/`ignorePassThrough`/`cost` are read directly by
// MovementHandControls.jsx to decide button copy and whether a card can ever
// be legally player-chosen for its exact step count (a `random` card's real
// steps are server-rolled — cardRoll is injected server-side, never sent by
// this client, same as ROLL_DICE never sends a client-computed die).
export const MOVEMENT_CARDS = {
  MOVE_5: { steps: 5, direction: 1, cost: 0, description: 'Đi 5 bước.' },
  MOVE_6: { steps: 6, direction: 1, cost: 0, description: 'Đi 6 bước.' },
  MOVE_7: { steps: 7, direction: 1, cost: 0, description: 'Đi 7 bước.' },
  MOVE_8: { steps: 8, direction: 1, cost: 0, description: 'Đi 8 bước.' },
  MOVE_9: { steps: 9, direction: 1, cost: 0, description: 'Đi 9 bước.' },
  STEP_1: { steps: 1, direction: 1, cost: 50, description: 'Đi 1 bước (50$).' },
  STEP_2: { steps: 2, direction: 1, cost: 50, description: 'Đi 2 bước (50$).' },
  STEP_3: { steps: 3, direction: 1, cost: 50, description: 'Đi 3 bước (50$).' },
  SPRINT_12: { steps: 12, direction: 1, cost: 100, description: 'Chạy bứt tốc 12 bước (100$).' },
  BACKUP_3: { steps: 3, direction: -1, cost: 0, description: 'Đi lùi 3 bước.' },
  MOVE_RANDOM_2_12: { random: [2, 12], direction: 1, cost: 0, description: 'Đổ 2 viên xúc xắc ngẫu nhiên (2-12 bước).' },
  JUMP_2: { steps: 2, direction: 1, cost: 0, ignorePassThrough: true, description: 'Nhảy cóc 2 bước (Miễn nhiễm hiệu ứng lướt).' },
  JUMP_3: { steps: 3, direction: 1, cost: 0, ignorePassThrough: true, description: 'Nhảy cóc 3 bước (Miễn nhiễm hiệu ứng lướt).' },
}

// Short face label for a card — its step count (with direction/randomness
// spelled out), not the id itself (a raw 'MOVE_RANDOM_2_12' means nothing to
// a player at a glance). Falls back to the raw id for a card this frontend
// mirror doesn't recognize yet, rather than crashing on a lookup miss — the
// backend is the source of truth and could ship a new card before this file
// is updated to match.
export function cardLabel(cardId) {
  const card = MOVEMENT_CARDS[cardId]
  if (!card) return cardId
  if (card.random) return `🎲 ${card.random[0]}–${card.random[1]}`
  const arrow = card.direction < 0 ? '◀' : '▶'
  return `${arrow} ${card.steps}`
}

// Card-back visual: pure UI classification, not a backend field. `HIDDEN`
// (engine/stateRedaction.js's HIDDEN_CARD sentinel — deliberately re-typed
// here rather than imported, same "no shared package" standing as
// MOVEMENT_CARDS above) is a face-down opponent card; anything else in
// MOVEMENT_CARDS is real, own or DENIAL-revealed. An id absent from
// MOVEMENT_CARDS is unrecognized (server ahead of this mirror), rendered as
// a face-down "?" card rather than crashing.
export const HIDDEN_CARD = 'HIDDEN'

export function isKnownCard(cardId) {
  return Object.hasOwn(MOVEMENT_CARDS, cardId)
}
