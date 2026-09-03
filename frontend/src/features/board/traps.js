// Presentation strings for ASYMMETRIC's placed traps (backend/src/engine/
// trapEngine.js's TRAP_TYPES). Its own tiny module because two components in
// two different places need the identical wording — BoardTile.jsx labels the
// marker for a trap you planted, GameBoard.jsx labels the explosion when one
// fires — and the same hazard described two different ways on the same board
// would read as two different mechanics.
//
// Presentation only: no positions, no ownership, no rules. Which traps a
// viewer is even told about is decided server-side (engine/stateRedaction.js),
// not here.

export const TRAP_ICON = {
  ROADBLOCK: '🚧',
  TOLL_BOOTH: '💰',
}

/** Short name, for a title/tooltip on a trap the viewer owns. */
export const TRAP_LABEL = {
  ROADBLOCK: 'Chốt Chặn — chặn đứng 1 người rồi biến mất',
  TOLL_BOOTH: 'Trạm Thu Phí — thu $100 mỗi lượt có người đi qua',
}

export function trapIcon(type) {
  return TRAP_ICON[type] ?? '⚠️'
}

export function trapLabel(type) {
  return TRAP_LABEL[type] ?? 'Bẫy'
}
