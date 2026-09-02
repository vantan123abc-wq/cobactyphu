import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getRoom } from '../../network/api'
import { GROUP_COLORS, CHANCE_FORTUNE_COLOR } from '../board/tileVisuals'
import TileIcon from '../board/TileIcon'
import { buildBlockReason, effectiveBuildCost, nextBuildLabel, ownedGroupHoldingsFor } from './buildRules'
import styles from './PropertyManager.module.css'
import ActionNotice from './ActionNotice'

// Mirrors backend/src/domain/property.js's own constants — no shared
// package between frontend/backend in this repo (same standing as
// tileVisuals.js's own GROUP_COLORS/CHANCE_FORTUNE_COLOR, independently
// re-declared rather than imported across the client/server boundary).
const MIN_UPGRADE_LEVEL = 0
const MAX_UPGRADE_LEVEL = 5 // properties.upgrade_level CHECK (BETWEEN 0 AND 5); level 5 renders as a hotel, 1-4 as houses

// Mirrors backend/src/economy/propertyEconomy.js's own HOUSE_SELLBACK_RATIO —
// needed client-side only to preview costs and to disable buttons the server
// would reject anyway, never to compute a real settlement (the server always
// recomputes for real). The unmortgage-cost formula below is the other half
// of that mirroring (see its own comment) but no longer needs a separate
// MORTGAGE_INTEREST_RATE constant now that it's expressed as an integer
// fraction directly.
const HOUSE_SELLBACK_RATIO = 0.5

// Verified against the real backend before writing this (P11-T09's own
// instruction, same as the two prior game-action UI slices this session):
//
// - Action names are exactly BUILD_HOUSE/SELL_HOUSE/MORTGAGE/UNMORTGAGE
//   (turnMachine.js's VALID_ACTIONS_BY_PHASE.POST_ACTIONS, WEBSOCKET_API.md
//   §1) — no separate UPGRADE_PROPERTY action exists anywhere. All four take
//   payload `{ propertyId }`, never `{ tileIndex }` — and propertyId is
//   Property.id (the game-scoped ownership row, `gameState.properties`),
//   not board_tiles.id, same distinction FlashAuction.jsx's own propertyId
//   lookup already established.
// - The dynamic-state field is `property.mortgaged`, not `isMortgaged` as
//   this task's own brief phrased it (domain/property.js's real Property
//   shape) — corrected the same way GAME_STATE_MACHINE's currentTurn-that-
//   doesn't-exist mistake was corrected in earlier slices.
// - Static per-tile costs live on the Tile, not computed here:
//   tile.houseCost (build cost, and 2x HOUSE_SELLBACK_RATIO for a sell
//   refund) and tile.mortgageValue (mortgage payout, and the unmortgage cost
//   below) — domain/tile.js's real field names, confirmed against
//   economy/propertyEconomy.js's own calculate* functions rather than
//   guessed. Both are null for transport/utility tiles (houseCost) —
//   Build/Sell are gated on tile.tileType === 'property' accordingly,
//   mirroring turnMachine.js's handleBuildHouse's own explicit tileType check.
// - The unmortgage-cost formula (below) is `tile.mortgageValue`, never
//   `property.mortgageValue` as a since-corrected draft of this task's own
//   brief once phrased it — Property (the game-scoped ownership row) has no
//   such field at all (domain/property.js), only Tile does.
// - None of the four actions advance the turn (WEBSOCKET_API.md's own
//   table, each row) — POST_ACTIONS stays POST_ACTIONS after a successful
//   one, so this panel deliberately never closes itself on success.
//
// Real, already-known consequence of today's live seed data (not a bug in
// this component): BUILD_HOUSE's full-group-ownership precondition
// (groupHoldingsFor in turnMachine.js) can only ever pass when the target's
// color group actually has members, and PROJECT_STATUS.md's own open items
// already flag that board_tiles.group_id is null everywhere in the real
// seed data right now — so Build (and by extension Sell, which can never
// have a house to sell if Build never succeeds) will show as correctly
// *disabled* against the live board today, not broken; the group-ownership
// check below reproduces that same real precondition rather than skip it.
//
// Win Condition design (2026-08-19): also usable during LIQUIDATION_REQUIRED
// — turnMachine.js's VALID_ACTIONS_BY_PHASE.LIQUIDATION_REQUIRED reuses
// SELL_HOUSE/MORTGAGE verbatim (not BUILD_HOUSE/UNMORTGAGE), so only those
// two are phase-gated to also accept LIQUIDATION_REQUIRED here, matching
// the backend exactly. GameControls.jsx's own new LIQUIDATION_REQUIRED
// status line is what tells the player *that* they need to act at all —
// this panel only ever appears once they've selected a property, which
// they may not have done yet the instant liquidation begins.
export default function PropertyManager() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)
  const selectedPropertyId = useGameStore((s) => s.selectedPropertyId)
  const selectProperty = useGameStore((s) => s.selectProperty)

  const [displayNames, setDisplayNames] = useState({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // name-lookup failure is a UX nicety miss only, never blocks property actions
  }, [roomId, session.access_token])

  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  if (!selectedPropertyId || !gameState || !staticBoard) {
    return null
  }

  const property = gameState.properties.find((p) => p.id === selectedPropertyId)
  const tile = property ? staticBoard.tiles.find((t) => t.id === property.boardTileId) : null
  if (!property || !tile) {
    return null // selection points at a property that no longer resolves (stale id, board not loaded yet) — nothing sane to show
  }

  const me = gameState.players.find((p) => p.playerId === user.id)
  const owner = gameState.players.find((p) => p.id === property.ownerId) ?? null
  const isMyTurn = me != null && me.turnOrder === gameState.currentTurnIndex
  const isOwner = me != null && property.ownerId === me.id
  const nameFor = (player) => displayNames[player?.playerId] ?? player?.playerId ?? '…'

  // The SELL precondition below reads from this (even-sell: only the
  // OWNER'S OWN highest lot in the group is sell-eligible). BUILD's own group
  // checks moved to buildRules.js (2026-08-23). MORTGAGE went per-property
  // 2026-09-02 — it no longer consults the group at all.
  //
  // 2026-09-02 bug fix: this used to scan the whole colour group regardless of
  // owner, while handleSellHouse has scanned only the acting player's own
  // holdings since 2026-08-25 (ownedGroupHoldingsFor). Since building stopped
  // requiring the full group, a group can be split between owners — so a
  // rival's taller building in your group disabled your own "Bán Nhà" button
  // for a sale the server would have allowed. Worst case it fired during
  // LIQUIDATION_REQUIRED, locking a player out of raising cash to avoid
  // bankruptcy. Now reuses buildRules.js's ownedGroupHoldingsFor, the same
  // mirror the build side already went through.
  const myGroupHoldings = ownedGroupHoldingsFor(gameState, staticBoard, tile, property, property.ownerId)
  const maxLevelInGroup = Math.max(...myGroupHoldings.map((h) => h.property?.upgradeLevel ?? 0))

  const houseCost = tile.houseCost ?? null
  // The build's REAL cost, including both modifiers handleBuildHouse applies
  // (buildRules.js) — distinct from `houseCost`, which stays the tile's own
  // printed base price and is what the sell-back refund is computed from.
  const buildCost = effectiveBuildCost(tile, gameState, me)
  const sellRefund = houseCost != null ? Math.floor(houseCost * HOUSE_SELLBACK_RATIO) : null
  // Integer-safe — matches economy/propertyEconomy.js's calculateUnmortgage
  // fix exactly (finding #26, PROJECT_STATUS.md): `tile.mortgageValue * 1.1`
  // overcharged by $1 on ~5% of values due to IEEE-754 float imprecision
  // (e.g. 100 * 1.1 === 110.00000000000001, so Math.ceil rounded up to 111
  // instead of 110). This preview must stay byte-for-byte in sync with what
  // the server actually charges, not just "close enough."
  const unmortgageCost = tile.mortgageValue != null ? Math.ceil((tile.mortgageValue * 11) / 10) : null
  const balance = me?.currentBalance ?? 0

  // LIQUIDATION_REQUIRED only ever applies to whichever player is the
  // pending debtor — checked explicitly rather than assumed, since it's
  // cheap and this is the one place a wrong assumption here would let the
  // wrong player try to liquidate someone else's debt away.
  const isLiquidating = gameState.phase === 'LIQUIDATION_REQUIRED' && gameState.pendingLiquidation?.debtorId === me?.id

  function phaseReason(allowDuringLiquidation) {
    if (!isMyTurn) return 'Chưa đến lượt bạn'
    if (gameState.phase === 'POST_ACTIONS') return null
    if (allowDuringLiquidation && isLiquidating) return null
    return 'Chỉ dùng được sau khi di chuyển xong (giai đoạn hành động)'
  }

  // 2026-08-23: the full precondition ladder that used to live inline here
  // moved to buildRules.js, so PropertyActionDrawer.jsx's own AWAITING_UPGRADE
  // build button enforces exactly the same rules (it previously enforced
  // almost none — see that file). Only the phase/turn gate stays here, since
  // the two callers sit in genuinely different phases. That extraction also
  // fixed a real drift this version had: its affordability check compared
  // against the bare `tile.houseCost`, ignoring buildCostModifierAmount /
  // nextBuildDiscount, which handleBuildHouse itself does apply.
  function buildReason() {
    const notActionable = phaseReason(false) // BUILD_HOUSE isn't legal during LIQUIDATION_REQUIRED (turnMachine.js's own VALID_ACTIONS_BY_PHASE)
    if (notActionable) return notActionable
    return buildBlockReason({ gameState, staticBoard, tile, property, player: me })
  }

  function sellReason() {
    const notActionable = phaseReason(true) // reused verbatim for LIQUIDATION_REQUIRED
    if (notActionable) return notActionable
    if (!isOwner) return 'Bạn không sở hữu ô này'
    if (property.upgradeLevel <= MIN_UPGRADE_LEVEL) return 'Không có nhà để bán'
    if (property.upgradeLevel < maxLevelInGroup) return 'Phải bán đều — bán ô cao nhất trong nhóm trước'
    return null
  }

  function mortgageReason() {
    const notActionable = phaseReason(true) // reused verbatim for LIQUIDATION_REQUIRED
    if (notActionable) return notActionable
    if (!isOwner) return 'Bạn không sở hữu ô này'
    if (property.mortgaged) return 'Đã cầm cố rồi'
    if (property.upgradeLevel > MIN_UPGRADE_LEVEL) return 'Phải bán hết nhà trên ô này trước'
    return null
  }

  function unmortgageReason() {
    const notActionable = phaseReason(false) // UNMORTGAGE isn't legal during LIQUIDATION_REQUIRED either
    if (notActionable) return notActionable
    if (!isOwner) return 'Bạn không sở hữu ô này'
    if (!property.mortgaged) return 'Chưa cầm cố'
    if (unmortgageCost == null || balance < unmortgageCost) return 'Không đủ tiền'
    return null
  }

  const disabledBuild = buildReason()
  const disabledSell = sellReason()
  const disabledMortgage = mortgageReason()
  const disabledUnmortgage = unmortgageReason()

  function act(actionType) {
    setBusy(true)
    sendGameAction(actionType, { propertyId: property.id })
  }

  const groupColor = tile.groupId ? GROUP_COLORS[tile.groupId] : undefined
  const headerColor = CHANCE_FORTUNE_COLOR[tile.tileType] ?? groupColor ?? '#6b7280' // neutral gray for transport/utility, which have neither a color group nor a chance/fortune type

  // Rent-table display (GameView redesign, 2026-08-22) — new here, using
  // real data that already existed but was never surfaced by this panel:
  // domain/tile.js's real shape splits base rent (no houses, tile.baseRent)
  // from the per-house-level progression (tile.rentTable[0] = 1 house,
  // ...[3] = 4 houses, ...[4] = hotel — 5 entries covering upgradeLevel 1-5,
  // MAX_UPGRADE_LEVEL's own real ceiling). Deliberately the *printed* table,
  // not "your exact rent right now" — reproducing calculateRent.js's own
  // full-group-ownership doubling bonus here too would risk this
  // display-only card silently drifting from the real server-computed
  // amount; showing the plain table (same as the reference card's own
  // static "With 1 House / 2 Houses / ..." rows) avoids that risk. Only
  // shown for tileType 'property' — transport/utility rent is computed
  // entirely differently (dice-multiplier / ownership-count formulas with
  // no printed table at all, PROJECT_STATUS.md's own "Real board content"
  // section), so a table here for those types would just be invented.
  const rentRows =
    tile.tileType === 'property' && tile.rentTable
      ? tile.rentTable.map((rent, i) => ({ level: i + 1, rent }))
      : []

  return (
    <div className={styles.backdrop} onClick={() => selectProperty(property.id)}>
      {/* stopPropagation: the backdrop's own onClick closes the panel (click-outside-to-dismiss) — without this, any click inside the card would bubble up and close it too */}
      <div className={styles.panel} style={{ '--group-color': headerColor }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header} style={{ background: headerColor }}>
        <TileIcon type={tile.tileType} className={styles.icon} />
        {isOwner && <span className={styles.ownerBadge}>SỞ HỮU CỦA BẠN</span>}
        <button type="button" className={styles.closeButton} onClick={() => selectProperty(property.id)} aria-label="Đóng">
          ✕
        </button>
      </div>

      <div className={styles.body}>
        {isLiquidating && (
          <p className={styles.liquidationBanner}>
            Bạn cần thanh lý tài sản để trả nợ ${gameState.pendingLiquidation.amount} — bán nhà hoặc cầm cố tài sản bạn sở hữu.
          </p>
        )}

        <h3 className={styles.name}>{tile.name}</h3>

        <div className={styles.statusRow}>
          <span className={styles.owner}>{owner ? (isOwner ? 'Sở hữu: Bạn' : `Sở hữu: ${nameFor(owner)}`) : 'Chưa có chủ'}</span>
          {property.mortgaged && <span className={styles.mortgagedBadge}>ĐANG CẦM CỐ</span>}
        </div>

        {tile.tileType === 'property' && typeof tile.baseRent === 'number' && (
          <p className={styles.rentHeadline}>TIỀN THUÊ ${tile.baseRent}</p>
        )}

        {rentRows.length > 0 && (
          <div className={styles.rentTable}>
            {rentRows.map(({ level, rent }) => (
              <div key={level} className={styles.rentRow}>
                <span className={styles.rentRowLabel}>{level < MAX_UPGRADE_LEVEL ? `Với ${level} nhà` : 'Với khách sạn'}</span>
                <span className={styles.rentRowValue}>${rent}</span>
              </div>
            ))}
            {/* This table is the tile's printed rent, like a title-deed card.
                The real charge doubles at every row when one player owns the
                whole colour group unmortgaged (calculateRent.js, revised
                2026-09-02) — stated rather than folded in, so this stays a
                static reference; the live "what it costs right now" figure is
                on the board tile itself (rentPreview.js). */}
            {tile.groupId && <p className={styles.rentNote}>×2 ở mọi mức nếu bạn giữ trọn bộ nhóm màu (không ô nào cầm cố).</p>}
          </div>
        )}

        {tile.tileType === 'transport' && typeof tile.baseRent === 'number' && (
          <div className={styles.rentTable}>
            <p className={styles.rentHeadline}>TIỀN THUÊ KHI CÙNG SỞ HỮU</p>
            <div className={styles.rentRow}><span className={styles.rentRowLabel}>1 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent}</span></div>
            <div className={styles.rentRow}><span className={styles.rentRowLabel}>2 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent * 2}</span></div>
            <div className={styles.rentRow}><span className={styles.rentRowLabel}>3 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent * 4}</span></div>
            <div className={styles.rentRow}><span className={styles.rentRowLabel}>4 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent * 8}</span></div>
          </div>
        )}

        {tile.tileType === 'utility' && (
          <div className={styles.rentTable}>
            <p className={styles.rentHeadline}>THUÊ BẰNG SỐ XÚC XẮC NHÂN LÊN</p>
            <div className={styles.rentRow}><span className={styles.rentRowLabel}>1 công ty</span><span className={styles.rentRowValue}>4 x Xúc xắc</span></div>
            <div className={styles.rentRow}><span className={styles.rentRowLabel}>2 công ty</span><span className={styles.rentRowValue}>10 x Xúc xắc</span></div>
          </div>
        )}

        {tile.tileType === 'property' && (
          <div className={styles.upgradeRow}>
            <span className={styles.upgradeLabel}>Nhà đã xây:</span>
            {property.upgradeLevel === 0 && <span className={styles.upgradeValue}>Chưa xây</span>}
            {property.upgradeLevel > 0 && property.upgradeLevel < MAX_UPGRADE_LEVEL && (
              <span className={styles.upgradeValue}>{'🏠'.repeat(property.upgradeLevel)}</span>
            )}
            {property.upgradeLevel === MAX_UPGRADE_LEVEL && <span className={styles.upgradeValue}>🏨 Khách sạn</span>}
          </div>
        )}

        {tile.tileType === 'property' && (
          <p className={styles.supplyRow}>
            🏠 Nhà còn: {gameState.houseSupply} · 🏨 Khách sạn còn: {gameState.hotelSupply}
          </p>
        )}

        <div className={styles.actions}>
          {/* Label reflects what the next build actually produces — a
              player sitting at 4 houses is told they're buying a HOTEL, not
              an indistinguishable fifth "house" (buildRules.js). */}
          <button type="button" className={styles.actionButton} disabled={busy || !!disabledBuild} title={disabledBuild ?? undefined} onClick={() => act('BUILD_HOUSE')}>
            {nextBuildLabel(property).label}
            {buildCost != null ? ` ($${buildCost})` : ''}
          </button>
          <button type="button" className={styles.actionButton} disabled={busy || !!disabledSell} title={disabledSell ?? undefined} onClick={() => act('SELL_HOUSE')}>
            Bán Nhà{sellRefund != null ? ` (+$${sellRefund})` : ''}
          </button>
          <button type="button" className={styles.actionButton} disabled={busy || !!disabledMortgage} title={disabledMortgage ?? undefined} onClick={() => act('MORTGAGE')}>
            Cầm Cố{tile.mortgageValue != null ? ` (+$${tile.mortgageValue})` : ''}
          </button>
          <button type="button" className={styles.actionButton} disabled={busy || !!disabledUnmortgage} title={disabledUnmortgage ?? undefined} onClick={() => act('UNMORTGAGE')}>
            Chuộc Đất{unmortgageCost != null ? ` ($${unmortgageCost})` : ''}
          </button>
        </div>

        {lastError && (
          <ActionNotice error={lastError} />
        )}

        {typeof tile.mortgageValue === 'number' && <p className={styles.mortgageFooter}>Giá trị cầm cố ${tile.mortgageValue}</p>}
        </div>
      </div>
    </div>
  )
}
