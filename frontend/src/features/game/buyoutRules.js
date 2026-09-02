// Shared HOSTILE_BUYOUT preconditions — a client-side mirror of
// turnMachine.js's handleHostileBuyout, extracted 2026-09-02.
//
// Created for the same reason buildRules.js was: the exact same precondition
// logic existed in GameControls.jsx and was MISSING from PropertyActionDrawer,
// which offered a fully-enabled "Cường đoạt" button on a monopoly-protected
// property. The click went to the server and came back as a raw internal
// rejection the player then saw on screen. One copy, two consumers, so the
// two surfaces can no longer disagree about what the server will accept.
//
// Order matters and mirrors the server's own: handleHostileBuyout tests
// MONOPOLY_PROTECTED before HOUSE_PROTECTED, so when a target is both fully
// setted and built up, this reports the reason the server would actually give.

/** @returns {{ property, tile, cost }|null} the live buyout target, or null when none is pending. */
export function buyoutTarget(gameState, staticBoard) {
  const id = gameState?.pendingHostileBuyoutPropertyId
  if (!id) return null
  const property = gameState.properties?.find((p) => p.id === id) ?? null
  if (!property) return null
  const tile = staticBoard?.tiles?.find((t) => t.id === property.boardTileId) ?? null
  if (!tile) return null
  // 2× (price + buildings) — mirrors HOSTILE_BUYOUT_MULTIPLIER in turnMachine.js.
  const cost = 2 * (tile.price + property.upgradeLevel * (tile.houseCost ?? 0))
  return { property, tile, cost }
}

/**
 * Why this buyout would be refused, as player-facing Vietnamese — or null if
 * it would genuinely go through.
 */
export function buyoutBlockReason(gameState, staticBoard, me) {
  const target = buyoutTarget(gameState, staticBoard)
  if (!target) return 'Hiện không có ô nào để cưỡng đoạt'
  const { property, tile, cost } = target

  if (tile.groupId) {
    const groupTiles = staticBoard.tiles.filter((t) => t.groupId === tile.groupId)
    const wholeGroupSameOwner =
      groupTiles.length > 0 &&
      groupTiles.every((t) => gameState.properties.find((p) => p.boardTileId === t.id)?.ownerId === property.ownerId)
    if (wholeGroupSameOwner) return 'Ô này thuộc nhóm độc quyền đã hoàn chỉnh — không thể cưỡng đoạt'
  }

  if ((property.upgradeLevel ?? 0) > 0) return 'Ô này đã xây nhà — không thể cưỡng đoạt'
  if ((me?.currentBalance ?? 0) < cost) return `Không đủ tiền — cần $${cost}`
  return null
}
