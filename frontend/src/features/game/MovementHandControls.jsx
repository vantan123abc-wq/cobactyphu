import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { MOVEMENT_CARDS, cardLabel } from './movementCards'
import ActionNotice from './ActionNotice'
import styles from './MovementHandControls.module.css'

// PLAYING_CARD (ASYMMETRIC only) — the direct counterpart to ROLLING's dice
// button (GameControls.jsx), split into its own file rather than folded
// inline there: unlike JAIL_DECISION's small fixed action set (which
// GameControls.jsx's own header says fits directly), this phase has a
// variable-length hand, two actions PER card, and — for PLACE_TRAP — a whole
// separate target-picking flow reaching into GameBoard.jsx. Self-gates and
// mounts in GameView.jsx the same way PropertyActionDrawer/FlashAuction do;
// GameControls.jsx lists 'PLAYING_CARD' in its own HANDLED_PHASES for the
// same reason it already lists FLASH_AUCTION_ACTIVE/DRAFTING_ACTIVE there.
//
// Verified against the real backend before writing this:
// - VALID_ACTIONS_BY_PHASE.PLAYING_CARD (turnMachine.js) is
//   ['PLAY_MOVEMENT_CARD', 'PLACE_TRAP'] — PLACE_TRAP shares this phase
//   rather than getting its own (turnMachine.js's own comment: placing a
//   trap spends a card INSTEAD OF moving, so it's a real alternative to
//   playing one, not a separate decision point).
// - PLAY_MOVEMENT_CARD payload is `{ cardId }` only, even for the one
//   `random` card (MOVE_RANDOM_2_12) — its real step count (cardRoll) is
//   server-generated (socketServer.js's serverGeneratedFields), a
//   client-sent value would just be discarded.
// - PLACE_TRAP payload is `{ cardId, trapType, targetPosition }` — trapType
//   is exactly 'ROADBLOCK' | 'TOLL_BOOTH' (trapEngine.js's TRAP_TYPES),
//   targetPosition a board `position` (not a tile id).
export default function MovementHandControls() {
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const lastError = useGameStore((s) => s.lastError)
  const trapDraft = useGameStore((s) => s.trapDraft)
  const setTrapDraft = useGameStore((s) => s.setTrapDraft)

  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  // A trap mid-pick must never survive this component going away — the local
  // player's turn/phase moving on (an AFK default fired, the flow completed,
  // or anything else), otherwise GameBoard.jsx would keep showing every tile
  // as targetable with no picker UI left to receive the click.
  useEffect(() => () => setTrapDraft(null), [setTrapDraft])

  if (!gameState) return null
  const me = gameState.players.find((p) => p.playerId === user.id)
  const isMyTurn = me != null && me.turnOrder === gameState.currentTurnIndex
  if (!isMyTurn || gameState.phase !== 'PLAYING_CARD') return null

  const hand = me.movementHand ?? []
  const isMyCardTargeting = trapDraft != null && hand.includes(trapDraft.cardId)

  function playCard(cardId) {
    setBusy(true)
    sendGameAction('PLAY_MOVEMENT_CARD', { cardId })
  }

  function startTrap(cardId) {
    setTrapDraft({ cardId, targetPosition: null })
  }

  function placeTrap(trapType) {
    setBusy(true)
    sendGameAction('PLACE_TRAP', { cardId: trapDraft.cardId, trapType, targetPosition: trapDraft.targetPosition })
    setTrapDraft(null)
  }

  // ── Sub-view: choosing ROADBLOCK vs TOLL_BOOTH, once a tile is picked ──
  if (isMyCardTargeting && trapDraft.targetPosition != null) {
    return (
      <section className={styles.panel}>
        <p className={styles.eyebrow}>🪤 Đặt bẫy tại ô #{trapDraft.targetPosition}</p>
        <div className={styles.trapTypeRow}>
          <button type="button" className={styles.trapTypeButton} disabled={busy} onClick={() => placeTrap('ROADBLOCK')}>
            <span className={styles.trapTypeName}>🚧 Chướng Ngại Vật</span>
            <span className={styles.trapTypeDesc}>Chặn đứng người đi ngang — kích hoạt một lần rồi biến mất.</span>
          </button>
          <button type="button" className={styles.trapTypeButton} disabled={busy} onClick={() => placeTrap('TOLL_BOOTH')}>
            <span className={styles.trapTypeName}>💰 Trạm Thu Phí</span>
            <span className={styles.trapTypeDesc}>Thu $100 mỗi lần có người đi ngang — tồn tại nhiều lượt.</span>
          </button>
        </div>
        <button type="button" className={styles.cancelButton} disabled={busy} onClick={() => setTrapDraft(null)}>
          Hủy đặt bẫy
        </button>
        {lastError && <ActionNotice error={lastError} compact />}
      </section>
    )
  }

  // ── Sub-view: still picking a tile on the board ──
  if (isMyCardTargeting) {
    return (
      <section className={styles.panel}>
        <p className={styles.targetingHint}>🎯 Bấm vào một ô bất kỳ trên bàn cờ để đặt bẫy…</p>
        <button type="button" className={styles.cancelButton} onClick={() => setTrapDraft(null)}>
          Hủy
        </button>
      </section>
    )
  }

  // ── Default view: the hand itself ──
  return (
    <section className={styles.panel}>
      <p className={styles.eyebrow}>🃏 Bài Di Chuyển</p>
      <div className={styles.handRow}>
        {hand.map((cardId, i) => {
          const card = MOVEMENT_CARDS[cardId]
          return (
            <div key={`${cardId}-${i}`} className={styles.card}>
              <span className={styles.cardSteps}>{cardLabel(cardId)}</span>
              <span className={styles.cardDesc}>{card?.description ?? cardId}</span>
              <div className={styles.cardActions}>
                <button type="button" className={styles.playButton} disabled={busy} onClick={() => playCard(cardId)}>
                  ▶️ Đi
                </button>
                <button type="button" className={styles.trapButton} disabled={busy} onClick={() => startTrap(cardId)}>
                  🪤 Đặt Bẫy
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {lastError && <ActionNotice error={lastError} compact />}
    </section>
  )
}
