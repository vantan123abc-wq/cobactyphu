import { useState } from 'react'
import { useGameStore } from '../../store/gameStore'
import { FINAL_PHASE_DURATION_ROUNDS } from './winConditionConstants'
import styles from './FinalPhaseBanner.module.css'

// Win Condition design (2026-08-19) — one-shot announcement the instant
// gameState.finalPhaseStartedAtRound flips from null to a real round
// number. Unlike EventCardModal.jsx's own toast (dismissed by watching
// stateVersion, since its trigger field resets to null every time),
// finalPhaseStartedAtRound is set exactly once for the whole match and
// never reset (turnMachine.js's own advanceTurn() comment: "a match only
// enters Final Phase once") — so "dismissed" has to be tracked against
// *that specific round number* instead, not the ever-changing
// stateVersion, or this would never be dismissible at all.
export default function FinalPhaseBanner() {
  const gameState = useGameStore((s) => s.currentGameState)
  const [dismissedRound, setDismissedRound] = useState(null)

  if (!gameState || gameState.finalPhaseStartedAtRound == null) return null
  if (dismissedRound === gameState.finalPhaseStartedAtRound) return null

  return (
    <div className={styles.wrap}>
      <div className={styles.banner}>
        <p className={styles.title}>🔥 GIAI ĐOẠN CUỐI</p>
        <p className={styles.subtitle}>Còn {FINAL_PHASE_DURATION_ROUNDS} vòng nữa</p>
        <p className={styles.body}>Xây dựng cơ nghiệp của bạn. Người giàu nhất khi kết thúc sẽ thắng.</p>
        <button
          type="button"
          className={styles.dismissButton}
          onClick={() => setDismissedRound(gameState.finalPhaseStartedAtRound)}
        >
          Đã hiểu
        </button>
      </div>
    </div>
  )
}
