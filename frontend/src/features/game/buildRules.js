// Shared BUILD_HOUSE preconditions — a faithful client-side mirror of
// backend/src/stateMachine/turnMachine.js's handleBuildHouse, extracted
// 2026-08-23 after a real user report: PropertyActionDrawer.jsx's
// AWAITING_UPGRADE "Xây Nhà" button checked only `tile.tileType ===
// 'property'` and nothing else, so it happily offered a build the server
// then rejected outright (`INCOMPLETE_GROUP: ... does not own every
// property in group 'yellow'`, shown raw to the player). PropertyManager.jsx
// already had a complete check of its own; rather than write a third copy
// for the drawer, both now read this one module.
//
// Everything below mirrors handleBuildHouse's real validation ORDER too,
// not just its rules — the reason shown to a player should be the same one
// the server would have given, not whichever condition this file happened
// to test first.
//
// Deliberately does NOT include the phase/turn check: the two callers sit
// in genuinely different phases (PropertyActionDrawer in AWAITING_UPGRADE,
// PropertyManager in POST_ACTIONS) and each already owns that gating.

// Mirrors backend/src/domain/property.js — no shared package crosses the
// frontend/backend boundary in this repo (same standing as tileVisuals.js's
// own re-declared constants).
export const MAX_UPGRADE_LEVEL = 5

/**
 * The real cost of the next build on `tile` for `player`, including both
 * modifiers handleBuildHouse itself applies — GameState.buildCostModifierAmount
 * (K07/K08's global, round-scoped material-price swing) and
 * PlayerGameState.nextBuildDiscount (C07/C12-B's one-shot personal
 * discount), stacked additively and floored at $0, byte-for-byte matching
 * that function's own `Math.max(0, baseAmount + modifier - discount)`.
 *
 * Wired in 2026-08-23 as part of this extraction: PropertyManager.jsx's own
 * previous affordability check compared the player's balance against the
 * *bare* `tile.houseCost`, ignoring both modifiers — a real (if small)
 * drift, since a player holding a $100 discount could be told "Không đủ
 * tiền" for a build they could in fact afford. Fixed here for both callers
 * at once rather than separately.
 * @returns {number|null} null when the tile has no houseCost at all (transport/utility)
 */
export function effectiveBuildCost(tile, gameState, player) {
  if (tile?.houseCost == null) return null
  return Math.max(0, tile.houseCost + (gameState?.buildCostModifierAmount ?? 0) - (player?.nextBuildDiscount ?? 0))
}

/**
 * Every {tile, property} pair sharing `tile`'s color group — mirrors
 * turnMachine.js's own groupHoldingsFor, including its "an ungrouped tile
 * resolves to an empty list" convention.
 */
export function groupHoldingsFor(gameState, staticBoard, tile) {
  if (!tile?.groupId || !staticBoard?.tiles) return []
  return staticBoard.tiles
    .filter((t) => t.groupId === tile.groupId)
    .map((t) => ({ tile: t, property: gameState.properties.find((p) => p.boardTileId === t.id) }))
}

/**
 * The subset of that group `ownerId` actually owns — mirrors
 * turnMachine.js's ownedGroupHoldingsFor, including its fallback to the
 * target property itself for an ungrouped tile, so the group-mortgage check
 * below always has at least one row to look at.
 */
export function ownedGroupHoldingsFor(gameState, staticBoard, tile, property, ownerId) {
  const mine = groupHoldingsFor(gameState, staticBoard, tile).filter((h) => h.property?.ownerId === ownerId)
  return mine.length > 0 ? mine : [{ tile, property }]
}

/**
 * Why this player cannot build one more unit on this property right now, or
 * null if they genuinely can.
 * @returns {string|null} a player-facing Vietnamese reason, or null when the build is legal
 */
export function buildBlockReason({ gameState, staticBoard, tile, property, player }) {
  if (!gameState || !staticBoard || !tile || !property || !player) return 'Chưa đủ dữ liệu'

  if (tile.tileType !== 'property') return 'Chỉ nhà phố mới xây được nhà'
  if (property.ownerId !== player.id) return 'Bạn không sở hữu ô này'
  if (property.upgradeLevel >= MAX_UPGRADE_LEVEL) return 'Đã đạt mức tối đa (khách sạn)'

  // 2026-08-25, user request: mirrors handleBuildHouse's own RECENTLY_ACQUIRED
  // check byte-for-byte (property.js's acquiredAtRound doc comment has the
  // full reasoning) — must wait until at least the owner's own next turn
  // after buying or hostile-buying-out this property.
  if (property.acquiredAtRound != null && (gameState?.roundNumber ?? 0) <= property.acquiredAtRound) {
    return 'Vừa mới sở hữu — đợi qua lượt sau của bạn'
  }

  // 2026-08-25: the full-group ("monopoly") requirement that stood here is
  // gone, mirroring handleBuildHouse — landing on your own property is now
  // enough to build on it. The one rule below is, exactly as on the server,
  // scoped to the properties THIS player owns in the group; scanning the
  // whole group would let a rival's tile block your own build (see
  // ownedGroupHoldingsFor's comment in turnMachine.js).
  //
  // The even-build rule that also lived here was removed 2026-09-02, matching
  // handleBuildHouse — a measured A/B showed it prevented no exploit (see
  // PROJECT_STATUS.md), and it was a holdover from the monopoly-gated build
  // rule this game already dropped.
  const myGroupHoldings = ownedGroupHoldingsFor(gameState, staticBoard, tile, property, player.id)

  if (myGroupHoldings.some((h) => h.property?.mortgaged)) return 'Ô của bạn trong nhóm này đang cầm cố'

  // The 4-houses-to-1-hotel conversion draws from the *hotel* pool, not the
  // house pool — a hotel is a physically different piece, not four houses
  // stacked (handleBuildHouse's own comment and rule).
  const willConvertToHotel = property.upgradeLevel === MAX_UPGRADE_LEVEL - 1
  if (willConvertToHotel ? (gameState.hotelSupply ?? 0) <= 0 : (gameState.houseSupply ?? 0) <= 0) {
    return willConvertToHotel ? 'Hết khách sạn trong kho chung' : 'Hết nhà trong kho chung'
  }

  const cost = effectiveBuildCost(tile, gameState, player)
  if (cost == null || player.currentBalance < cost) return 'Không đủ tiền'

  return null
}

/**
 * What the next build on this property actually produces — used for button
 * copy, so a player at 4 houses is told they're buying a HOTEL (and what it
 * costs them in houses), not another indistinguishable "house".
 * @returns {{ isHotel: boolean, label: string }}
 */
export function nextBuildLabel(property) {
  const level = property?.upgradeLevel ?? 0
  if (level === MAX_UPGRADE_LEVEL - 1) return { isHotel: true, label: 'Xây Khách Sạn' }
  return { isHotel: false, label: `Xây Nhà (${level + 1}/${MAX_UPGRADE_LEVEL - 1})` }
}
