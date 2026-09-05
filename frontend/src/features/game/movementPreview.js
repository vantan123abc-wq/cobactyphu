// "Chơi lá này thì tới đâu?" — client-side preview of a movement card's
// destination (2026-09-05, user request: "cho người chơi biết chọn đi đâu
// sẽ tới đâu"). Before this, a card just said "▶ 8 Đi 8 bước" with nothing
// telling the player which tile that actually is.
//
// This is a real walk simulation, not a naive `currentPosition + steps` —
// mirroring the SAME pass-through rules backend/src/engine/
// movementMiddleware.js applies, restricted to what a client can legitimately
// already see: property ownership, upgrade levels and Thế Lực tiers are all
// public information on this board (everyone sees whose tile is whose), and
// board/synergy.js's synergyByTileId already computes exactly that per tile.
// The one thing that stays honestly unpredictable is another player's own
// hidden trap — this preview can only account for the VIEWER'S OWN traps,
// which is all engine/stateRedaction.js ever lets a client resolve to a real
// board position in the first place (see GameBoard.jsx's own comment on the
// same trick: a trap arriving with a non-null tileIndex is, by construction,
// the viewer's own).
//
// Effects that DON'T move anyone (EXECUTION's toll, ECONOMY's card reroll,
// DENIAL's reveal, INFRA's toll) are irrelevant to a position preview and
// deliberately not simulated here — this file only answers "where," not
// "what it costs."

import { MOVEMENT_CARDS } from './movementCards'
import { synergyByTileId } from '../board/synergy'

/**
 * Port of synergyEngine.js's own highestRentTileOf — the destination a
 * MOBILITY tier-2 owner's forced TELEPORT lands a victim on. Same "current
 * rent, upgradeLevel first then base rent" ranking; same PROPERTY-tiles-only
 * restriction (a station can't be teleported onto, so chaining is
 * structurally impossible).
 */
function highestRentTileOf(properties, tiles, ownerId) {
  const owned = properties
    .filter((p) => p.ownerId === ownerId && !p.mortgaged)
    .map((p) => ({ property: p, tile: tiles.find((t) => t.id === p.boardTileId) }))
    .filter(({ tile }) => tile && tile.tileType === 'property')
  if (owned.length === 0) return null
  const rentOf = ({ property, tile }) =>
    property.upgradeLevel > 0 ? (tile.rentTable?.[property.upgradeLevel - 1] ?? 0) : (tile.baseRent ?? 0)
  return owned.reduce((best, candidate) => (rentOf(candidate) > rentOf(best) ? candidate : best)).tile
}

/**
 * Port of synergyEngine.js's own nudgeDirection — +1/-1/0, which way a
 * MOBILITY owner's pass-through shove pushes someone standing at
 * `fromPosition`, aimed at whichever of the owner's PROPERTY tiles is
 * nearest.
 */
function nudgeDirection(properties, tiles, ownerId, fromPosition, boardSize) {
  const targets = properties
    .filter((p) => p.ownerId === ownerId && !p.mortgaged)
    .map((p) => tiles.find((t) => t.id === p.boardTileId))
    .filter((t) => t && t.tileType === 'property')
    .map((t) => t.position)
  if (targets.length === 0) return 0
  const forwardDistance = (from, to) => (to - from + boardSize) % boardSize
  const best = (offset) => Math.min(...targets.map((t) => forwardDistance((fromPosition + offset + boardSize) % boardSize, t)))
  const ahead = best(1)
  const behind = best(-1)
  if (ahead === behind) return 0
  return ahead < behind ? 1 : -1
}

/**
 * @param {import('../../store/gameStore').default} gameState - the live gameState
 * @param {{tiles: object[]}} staticBoard
 * @param {object} player - the viewer's own PlayerGameState (movement always starts from their own position)
 * @param {string} cardId
 * @returns {null|{uncertain: true}|{uncertain: false, tileName: string, stoppedByOwnTrap: boolean, teleported: boolean}}
 *   null when there isn't enough data yet (board not loaded, unknown card).
 *   `uncertain` for MOVE_RANDOM_2_12 — its real step count is server-rolled,
 *   never known before playing it, same reason ROLL_DICE never previews a
 *   destination either.
 */
export function previewMovementCard(gameState, staticBoard, player, cardId) {
  const card = MOVEMENT_CARDS[cardId]
  const tiles = staticBoard?.tiles ?? []
  const boardSize = tiles.length
  if (!card || boardSize === 0 || player == null) return null
  if (card.random) return { uncertain: true }

  const properties = gameState?.properties ?? []
  const synergyMap = synergyByTileId(properties, tiles) // keyed by tile.id
  const tileByPosition = new Map(tiles.map((t) => [t.position, t]))
  // A trap redacted down to an anonymous stub always carries tileIndex: null
  // (engine/stateRedaction.js's maskTrap) — so any entry with a real number
  // here is, by construction, the viewer's own. No ownerId check needed,
  // same reasoning GameBoard.jsx's own hidden-trap badge already relies on.
  const ownTrapByPosition = new Map(
    (gameState?.activeTraps ?? []).filter((t) => typeof t.tileIndex === 'number').map((t) => [t.tileIndex, t])
  )

  let pos = player.currentPosition
  let remaining = card.steps
  let stoppedByOwnTrap = false
  // Bounded the same way movementMiddleware.js's own walk loop is (steps +
  // boardTileCount) — a defensive cap, not a rule this preview expects to
  // ever actually hit.
  let guard = 0
  const maxIterations = card.steps + boardSize

  while (remaining > 0 && guard++ < maxIterations) {
    pos = ((pos + card.direction) % boardSize + boardSize) % boardSize
    remaining--
    if (remaining === 0) break // the landing tile is not also a crossing

    const tile = tileByPosition.get(pos)
    const synergy = tile ? synergyMap.get(tile.id) : null

    // JUMP_2/JUMP_3 skip every archetype pass-through (their whole point),
    // but NOT traps — movementMiddleware.js checks traps before its own
    // ignorePassThrough guard, so a jump still triggers one.
    if (!card.ignorePassThrough && synergy && synergy.ownerId !== player.id) {
      if (synergy.archetype === 'CONTROL') {
        remaining -= 1
        if (remaining <= 0) break
      } else if (synergy.archetype === 'MOBILITY') {
        const shove = nudgeDirection(properties, tiles, synergy.ownerId, pos, boardSize)
        if (shove !== 0) {
          remaining += shove
          if (remaining <= 0) break
        }
      }
    }

    const trap = ownTrapByPosition.get(pos)
    if (trap?.type === 'ROADBLOCK') {
      stoppedByOwnTrap = true
      break
    }
    // TOLL_BOOTH charges but never stops the walk — nothing to do here.
  }

  let finalTile = tileByPosition.get(pos) ?? null
  let teleported = false
  if (finalTile && !stoppedByOwnTrap) {
    const synergy = synergyMap.get(finalTile.id)
    // Landing-time TELEPORT (synergyEngine.js's landingEffect, MOBILITY tier
    // 2 only) — the single effect in the ruleset a victim cannot dodge, and
    // exactly why it deserves a loud warning here rather than a silent
    // wrong-looking destination.
    if (synergy && synergy.archetype === 'MOBILITY' && synergy.tier >= 2 && synergy.ownerId !== player.id) {
      const target = highestRentTileOf(properties, tiles, synergy.ownerId)
      if (target) {
        finalTile = target
        teleported = true
      }
    }
  }

  return {
    uncertain: false,
    tileName: finalTile?.name ?? '?',
    stoppedByOwnTrap,
    teleported,
  }
}
