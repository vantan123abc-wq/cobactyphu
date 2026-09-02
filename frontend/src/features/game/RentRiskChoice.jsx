import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getRoom } from '../../network/api'
import { GROUP_COLORS, CHANCE_FORTUNE_COLOR } from '../board/tileVisuals'
import TileIcon from '../board/TileIcon'
import styles from './RentRiskChoice.module.css'
import ActionNotice from './ActionNotice'

// Rent Gamble (BOARD_SPECIFICATION.md) — revised 2026-08-25 from this
// mechanic's original everybody-waits design, per an explicit user
// correction: "nếu quyết định chọn gambling thì người chọn hoặc được x2
// hoặc không nhận được số tiền còn người vào đất chỉ mất x1 số tiền thôi
// chứ sao lại mất x2 và không cần chờ người khác quyết định chọn gì" — the
// payer must only ever lose exactly the standard 1x rent, and must never
// wait on the owner's decision. turnMachine.js's PAYING_RENT case now
// settles rent in full, immediately, at landing — every player-facing
// balance change from that (including the payer's) already happens and is
// already shown (Ledger.jsx, PlayersPanel.jsx's own floating money-change
// indicator) before this component ever has anything to say.
//
// What's left for this component is genuinely optional and single-actor:
// gameState.pendingRentGamble (`{ propertyId, ownerId, payerId, amount }`,
// set by turnMachine.js right after a cash rent settlement) means the
// OWNER may choose to risk the `amount` they just banked on a 50/50 double
// — funded by the Bank, not the payer (the user's confirmed choice between
// the two ways to fund a win with the payer's liability now fixed at 1x).
// Nobody else has anything to decide or wait on, so nobody else sees this
// at all — a small non-blocking corner drawer, matching
// PropertyActionDrawer.jsx's single-actor architecture, not FlashAuction's
// whole-room modal the original design (correctly, for what it was) used.
// It can sit unresolved indefinitely (phase-independent, no timer entry in
// timers.js — nothing is blocked on it, so there is nothing to time out)
// until the owner acts, goes bankrupt (turnMachine.js's applyBankruptcy
// clears it), or the match ends.
//
// GAMBLE_RENT's payload is empty — same as FOLD_AUCTION. The acting
// player's id (`payload.playerId`) and the coin-flip (`gambleRoll`) are
// both server-injected (socketServer.js), never client-supplied, so there
// is nothing here to compute or send beyond the bare action type.
//
// The win/lose outcome gets no bespoke display here either: it's a normal
// `rent_gamble` transaction (Bank↔owner) the instant it resolves, so the
// same generic machinery that already announces every other balance change
// announces this one too — nothing left to duplicate.
export default function RentRiskChoice() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)

  const [displayNames, setDisplayNames] = useState({})
  const [busy, setBusy] = useState(false)
  // Dismissing "no thanks" is purely local — declining costs nothing and
  // sends no action, the money is already the owner's. Keyed by the pending
  // offer's own content (not a ref/identity check) so it survives the
  // unrelated re-renders every other player's turn produces, but still
  // clears the instant a *genuinely* new offer replaces it — safe because
  // pendingRentGamble is a singleton field that only ever becomes non-null
  // again after passing back through null (handleGambleRent/applyBankruptcy
  // both clear it before anything else could set it), so a key match here
  // can only mean "still the same still-open offer."
  const [dismissedKey, setDismissedKey] = useState(null)

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // name-lookup failure is a UX nicety miss only, never blocks the decision
  }, [roomId, session.access_token])

  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  const pending = gameState?.pendingRentGamble ?? null

  if (!gameState || !staticBoard || !pending) {
    return null
  }

  const { propertyId, ownerId, payerId, amount } = pending
  const me = gameState.players.find((p) => p.playerId === user.id)
  const iAmOwner = me != null && me.id === ownerId

  if (!iAmOwner) {
    return null // nothing to decide or wait on — not even the payer sees this
  }

  const pendingKey = `${propertyId}:${payerId}:${amount}`
  if (dismissedKey === pendingKey) {
    return null
  }

  const payer = gameState.players.find((p) => p.id === payerId)
  const property = gameState.properties.find((p) => p.id === propertyId)
  const tile = property ? staticBoard.tiles.find((t) => t.id === property.boardTileId) : null

  const nameFor = (player) => displayNames[player?.playerId] ?? player?.playerId ?? '…'

  const groupColor = tile?.groupId ? GROUP_COLORS[tile.groupId] : undefined
  const headerColor = tile ? (CHANCE_FORTUNE_COLOR[tile.tileType] ?? groupColor) : undefined

  function gamble() {
    setBusy(true)
    sendGameAction('GAMBLE_RENT')
  }

  function keep() {
    setDismissedKey(pendingKey)
  }

  return (
    <div className={styles.drawer}>
      <div className={styles.card}>
        {tile && (
          <div className={styles.cardHeader} style={{ background: headerColor ?? 'var(--code-bg)' }}>
            <TileIcon type={tile.tileType} className={styles.icon} />
          </div>
        )}
        <div className={styles.cardBody}>
          <p className={styles.explainer}>
            Bạn vừa nhận <strong>${amount}</strong> tiền thuê từ <strong>{nameFor(payer)}</strong>
            {tile ? ` tại ${tile.name}` : ''}. Đánh cược với Ngân hàng?
          </p>

          <div className={styles.actions}>
            <button type="button" className={styles.keepButton} disabled={busy} onClick={keep}>
              Giữ nguyên
            </button>
            <button type="button" className={styles.gambleButton} disabled={busy} onClick={gamble}>
              🎲 Đánh cược
            </button>
          </div>
          <p className={styles.odds}>{`50%: +$${amount} thêm (x2) · 50%: mất $${amount} (về $0)`}</p>

          {lastError && (
            <ActionNotice error={lastError} />
          )}
        </div>
      </div>
    </div>
  )
}
