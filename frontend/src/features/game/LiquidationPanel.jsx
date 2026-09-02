import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { GROUP_COLORS } from '../board/tileVisuals'
import styles from './LiquidationPanel.module.css'
import ActionNotice from './ActionNotice'

// Mirrored from backend constants — no shared package between frontend/backend.
const HOUSE_SELLBACK_RATIO = 0.5 // backend/src/economy/propertyEconomy.js
const MAX_UPGRADE_LEVEL = 5      // backend/src/domain/property.js
const MIN_UPGRADE_LEVEL = 0

// Renders only when the local player IS the debtor in a LIQUIDATION_REQUIRED
// phase. Everyone else sees null — this panel is an actionable emergency tool,
// not a spectator view.
//
// Actions available in LIQUIDATION_REQUIRED (turnMachine.js's own
// VALID_ACTIONS_BY_PHASE — not guessed, verified against the real backend):
//   SELL_HOUSE   { propertyId }  — sell one house back, upgradeLevel--
//   MORTGAGE     { propertyId }  — mortgage unmortgaged property
// NOT available: BUILD_HOUSE, UNMORTGAGE (those are POST_ACTIONS only).
//
// The server auto-advances once pendingLiquidation.amount <= me.currentBalance
// — this panel has no "confirm" button; it only provides sell/mortgage tools.
// The footer makes that clear to the player.
//
// Z-index 48: above PlayersPanel/Ledger/GameControls (z-index 10) and
// PropertyManager (top-right, no explicit z-index), below FlashAuction (50)
// and EventCardModal (45 — AWAITING_EVENT_CHOICE overrides liquidation at the
// server level, so both being visible at once shouldn't happen in practice;
// keeping FlashAuction above anyway as a safety margin).
export default function LiquidationPanel() {
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)

  const [busy, setBusy] = useState(false)

  // Reset click-guard on any real server response (success = new stateVersion,
  // rejection = new lastError) — same pattern PropertyManager.jsx uses.
  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  if (!gameState || gameState.phase !== 'LIQUIDATION_REQUIRED') return null
  if (!gameState.pendingLiquidation) return null

  // me.id is PlayerGameState.id (UUID, game-scoped) — what ownerId/debtorId
  // compare against. me.playerId is the auth/profile id that matches user.id.
  const me = gameState.players.find((p) => p.playerId === user.id)
  if (!me) return null

  // Only render for the actual debtor — everyone else just waits.
  if (gameState.pendingLiquidation.debtorId !== me.id) return null

  const { amount } = gameState.pendingLiquidation
  const balance = me.currentBalance
  const shortfall = Math.max(0, amount - balance)
  const isPaid = shortfall === 0

  // All properties owned by this player, each resolved against staticBoard.
  const myProperties = staticBoard
    ? gameState.properties
        .filter((p) => p.ownerId === me.id)
        .map((p) => ({
          property: p,
          tile: staticBoard.tiles.find((t) => t.id === p.boardTileId) ?? null,
        }))
        .filter((entry) => entry.tile !== null)
    : []

  function sellHouse(propertyId) {
    setBusy(true)
    sendGameAction('SELL_HOUSE', { propertyId })
  }

  function mortgage(propertyId) {
    setBusy(true)
    sendGameAction('MORTGAGE', { propertyId })
  }

  // Per-property action availability — mirrors turnMachine.js's own checks for
  // these two actions during LIQUIDATION_REQUIRED (not POST_ACTIONS logic):
  //   SELL_HOUSE: needs upgradeLevel > 0, not mortgaged, and — added
  //               2026-09-02 — the even-sell rule (this must be the owner's
  //               own highest lot in its colour group). That last one was
  //               missing here, so the button was offered for a sale the
  //               server rejects with UNEVEN_SELL.
  //   MORTGAGE:   needs not already mortgaged and no houses on this property
  //               (per-property since 2026-09-02 — mortgage no longer consults
  //               the rest of the colour group, on the server either)
  // Why this asset can't be liquidated right now, or null when it can.
  // Returns the reason itself (the buildRules.js idiom) rather than a bare
  // boolean, so the button's tooltip can state it instead of re-deriving it.
  function sellBlockReason(property, tile) {
    if (property.mortgaged) return 'Đang cầm cố'
    if (property.upgradeLevel <= MIN_UPGRADE_LEVEL) return 'Không có nhà để bán'
    if (tile.tileType !== 'property') return 'Không thể bán nhà loại đất này'
    if (tile.houseCost == null) return 'Không thể bán nhà loại đất này'
    // Even-sell (UNEVEN_SELL), added 2026-09-02: this panel previously
    // skipped the rule entirely and let the server reject the click. Scoped
    // to MY OWN lots in the group, exactly like handleSellHouse's
    // ownedGroupHoldingsFor — myProperties is already owner-filtered.
    if (tile.groupId) {
      const myLevelsInGroup = myProperties
        .filter((e) => e.tile.groupId === tile.groupId)
        .map((e) => e.property.upgradeLevel)
      if (myLevelsInGroup.length && property.upgradeLevel < Math.max(...myLevelsInGroup)) {
        return 'Phải bán đều — bán ô cao nhất của bạn trong nhóm trước'
      }
    }
    return null
  }

  function mortgageBlockReason(property) {
    if (property.mortgaged) return 'Đã cầm cố rồi'
    if (property.upgradeLevel > MIN_UPGRADE_LEVEL) return 'Phải bán hết nhà trên ô này trước'
    return null
  }

  function upgradeIcons(level) {
    if (level <= 0) return null
    if (level >= MAX_UPGRADE_LEVEL) return <span className={styles.hotelIcon}>🏨</span>
    return (
      <span className={styles.houseIcons}>
        {'🏠'.repeat(level)}
      </span>
    )
  }

  return (
    <div className={styles.panel} role="dialog" aria-label="Cần thanh lý tài sản">
      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.alertBanner}>
          <span className={styles.alertIcon}>⚠</span>
          CẦN THANH LÝ TÀI SẢN
        </div>
        <div className={styles.debtInfo}>
          <span className={isPaid ? styles.shortfallPaid : styles.shortfall}>
            {isPaid ? '✓ Đã đủ tiền!' : `Còn thiếu: $${shortfall}`}
          </span>
          <span className={styles.balance}>Số dư: ${balance}</span>
        </div>
        {lastError && (
          <ActionNotice error={lastError} compact />
        )}
      </div>

      {/* ── Property grid ── */}
      <div className={styles.body}>
        {!staticBoard && (
          <p className={styles.loading}>Đang tải dữ liệu bàn cờ…</p>
        )}

        {staticBoard && myProperties.length === 0 && (
          <p className={styles.empty}>Bạn không còn tài sản nào có thể thanh lý.</p>
        )}

        <div className={styles.grid}>
          {myProperties.map(({ property, tile }) => {
            const bandColor = tile.groupId ? (GROUP_COLORS[tile.groupId] ?? '#555') : '#555'
            const sellRefund = tile.houseCost != null
              ? Math.floor(tile.houseCost * HOUSE_SELLBACK_RATIO)
              : null
            const mortgagePayout = tile.mortgageValue ?? null
            const sellBlocked = sellBlockReason(property, tile)
            const mortgageBlocked = mortgageBlockReason(property)
            const sellable = sellBlocked === null
            const mortgageable = mortgageBlocked === null

            return (
              <div
                key={property.id}
                className={`${styles.card} ${property.mortgaged ? styles.cardMortgaged : ''}`}
              >
                {/* Color band */}
                <div className={styles.colorBand} style={{ background: bandColor }} />

                {/* Mortgaged overlay */}
                {property.mortgaged && (
                  <div className={styles.mortgagedOverlay}>
                    <span className={styles.mortgagedBadge}>ĐANG CẦM CỐ</span>
                  </div>
                )}

                {/* Card body */}
                <div className={styles.cardBody}>
                  <p className={styles.tileName}>{tile.name}</p>
                  <div className={styles.upgradeRow}>
                    {upgradeIcons(property.upgradeLevel) ?? (
                      <span className={styles.noHouses}>Chưa xây</span>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.sellBtn}
                    disabled={busy || !sellable}
                    title={sellBlocked ?? undefined}
                    onClick={() => sellHouse(property.id)}
                  >
                    Bán Nhà{sellRefund != null && sellable ? ` +$${sellRefund}` : ''}
                  </button>

                  <button
                    type="button"
                    className={styles.mortgageBtn}
                    disabled={busy || !mortgageable}
                    title={mortgageBlocked ?? undefined}
                    onClick={() => mortgage(property.id)}
                  >
                    Cầm Cố{mortgagePayout != null && mortgageable ? ` +$${mortgagePayout}` : ''}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className={styles.footer}>
        <span className={styles.footerHint}>
          Sau khi đủ tiền trả nợ, hệ thống sẽ tự động tiếp tục
        </span>
        <button type="button" className={styles.waitBtn} disabled>
          {isPaid ? '✓ Đang xử lý…' : 'Chờ đủ tiền…'}
        </button>
      </div>
    </div>
  )
}
