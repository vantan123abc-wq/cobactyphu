import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getRoom } from '../../network/api'
import { GROUP_COLORS } from '../board/tileVisuals'
import TileIcon from '../board/TileIcon'
import ActionNotice from './ActionNotice'
import styles from './DraftPhase.module.css'

// Draft Phase (ASYMMETRIC only) — the very first thing a player sees once a
// match starts, per backend/src/api/controllers/room.controller.js's own
// initializeGameState(): an ASYMMETRIC match's phase starts at
// 'DRAFTING_ACTIVE', not 'TURN_START'. Modeled directly on FlashAuction.jsx —
// same overlay shape, same displayName-lookup effect, same deadline countdown
// — since the two problems are genuinely similar: a time-boxed decision that
// isn't always this player's to make, shown to the whole table at once.
//
// Verified against the real backend before writing this, not guessed:
// - VALID_ACTIONS_BY_PHASE.DRAFTING_ACTIVE (turnMachine.js) is exactly
//   ['DRAFT_PICK', 'DRAFT_PASS'] — DRAFT_PICK takes `{ tileId }`, DRAFT_PASS
//   takes no payload at all (mirrors AWAITING_PURCHASE's own
//   BUY_PROPERTY/SKIP_PURCHASE split).
// - GameState.draftState (domain/gameState.js) is
//   `{ round, pickOrder, currentPickIndex, availableTileIds }` — `pickOrder`
//   is an array of PlayerGameState.id (game_players.id, the SAME id-space
//   FlashAuction.jsx's own auction.activeBidders already uses), NOT
//   playerId. `availableTileIds` are board_tiles ids — resolved against
//   staticBoard.tiles the same two-hop way FlashAuction.jsx resolves its own
//   auction.propertyId.
// - getCurrentPlayer() (turnMachine.js) is draft-aware: it resolves through
//   draftState.pickOrder/currentPickIndex during this phase, which is what
//   makes socketServer.js's NOT_YOUR_TURN guard correctly reject an
//   out-of-order DRAFT_PICK server-side — this component's own isMyPick
//   check below is a UI convenience (disable the wrong buttons), not the
//   real enforcement.
// - engine/draftPhase.js only ever offers `property`-type tiles (never
//   transport/utility) — nothing here needs to special-case a station or
//   utility card, the offer array simply never contains one.
export default function DraftPhase() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)
  const deadlineAt = useGameStore((s) => s.deadlineAt)

  const [displayNames, setDisplayNames] = useState({})
  const [busy, setBusy] = useState(false)
  const [timeLeft, setTimeLeft] = useState(0)

  useEffect(() => {
    if (!deadlineAt) return
    const update = () => setTimeLeft(Math.max(0, Math.floor((new Date(deadlineAt) - new Date()) / 1000)))
    update()
    const intId = setInterval(update, 1000)
    return () => clearInterval(intId)
  }, [deadlineAt])

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // a name-lookup failure is a UX nicety miss only, never blocks drafting
  }, [roomId, session.access_token])

  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  if (!gameState || !staticBoard || gameState.phase !== 'DRAFTING_ACTIVE' || !gameState.draftState) {
    return null
  }

  const { round, pickOrder, currentPickIndex, availableTileIds } = gameState.draftState
  const me = gameState.players.find((p) => p.playerId === user.id)
  const currentPickerId = pickOrder[currentPickIndex]
  const isMyPick = me != null && me.id === currentPickerId

  const nameFor = (gamePlayerId) => {
    const p = gameState.players.find((pl) => pl.id === gamePlayerId)
    return displayNames[p?.playerId] ?? p?.playerId ?? '…'
  }

  // staticBoard.boardId === gameState.boardId guards the same brief window
  // ledgerFormat/socketClient's own comments describe: right after the very
  // first S2C_STATE_UPDATE of a session, before ensureStaticBoardLoaded()'s
  // fire-and-forget fetch has resolved yet, staticBoard can still be the
  // PREVIOUS match's board (or none). Filtered out here rather than crashing
  // on a lookup miss — the tile grid below just renders fewer cards for one
  // tick until the real board data lands and this component re-renders.
  const availableTiles =
    staticBoard.boardId === gameState.boardId
      ? availableTileIds.map((id) => staticBoard.tiles.find((t) => t.id === id)).filter(Boolean)
      : []

  function pick(tileId) {
    setBusy(true)
    sendGameAction('DRAFT_PICK', { tileId })
  }

  function pass() {
    setBusy(true)
    sendGameAction('DRAFT_PASS')
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.modal}>
        <p className={styles.eyebrow}>🃏 Vòng Draft — Chọn Đất (Vòng {round}/2)</p>

        {deadlineAt && (
          <p className={timeLeft <= 5 ? `${styles.timer} ${styles.timerUrgent}` : styles.timer}>Còn {timeLeft}s</p>
        )}

        {/* Snake pick order — the whole point of a Constrained Draft (see
            draftPhase.js's own file header) is visible, not a black box: who
            already picked this round, who's up now, who's still waiting. */}
        <div className={styles.pickOrder}>
          {pickOrder.map((pid, i) => {
            const stateClass = i < currentPickIndex ? styles.pickChipDone : i === currentPickIndex ? styles.pickChipActive : ''
            return (
              <span key={pid} className={`${styles.pickChip} ${stateClass}`}>
                {i < currentPickIndex ? '✓ ' : ''}
                {nameFor(pid)}
              </span>
            )
          })}
        </div>

        {isMyPick ? (
          <>
            <p className={styles.status}>Lượt của bạn — chọn 1 trong {availableTiles.length} ô đất:</p>
            <div className={styles.tileGrid}>
              {availableTiles.map((tile) => {
                const affordable = (me?.currentBalance ?? 0) >= tile.price
                return (
                  <button
                    key={tile.id}
                    type="button"
                    className={styles.tileCard}
                    style={{ borderColor: GROUP_COLORS[tile.groupId] ?? 'var(--border)' }}
                    disabled={busy || !affordable}
                    title={affordable ? undefined : 'Không đủ tiền mặt cho ô này'}
                    onClick={() => pick(tile.id)}
                  >
                    <TileIcon type={tile.tileType} className={styles.icon} />
                    <span className={styles.tileName}>{tile.name}</span>
                    <span className={styles.tilePrice}>${tile.price}</span>
                  </button>
                )
              })}
            </div>
            <button type="button" className={styles.passButton} disabled={busy} onClick={pass}>
              Bỏ qua (không mua ô nào)
            </button>
          </>
        ) : (
          <p className={styles.status}>Đang chờ {nameFor(currentPickerId)} chọn…</p>
        )}

        {/* compact: same crowded-time-pressured-modal reasoning FlashAuction.jsx's
            own equivalent line already gives — the tile grid needs the space. */}
        {lastError && <ActionNotice error={lastError} compact />}
      </div>
    </div>
  )
}
