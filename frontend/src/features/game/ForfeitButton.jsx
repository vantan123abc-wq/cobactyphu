import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction, disconnectSocket } from '../../network/socketClient'
import ActionNotice from './ActionNotice'
import styles from './ForfeitButton.module.css'

// "Đầu hàng" — voluntary surrender (2026-08-23, user request: "hãy làm
// tính năng đầu hàng cho phép người chơi bỏ cuộc và thoát trận đấu").
// Lives in GameView.jsx's topbar next to "Đăng xuất" rather than
// GameControls.jsx — this is a whole-match, any-time action (mirrors the
// backend's own FORFEIT_MATCH, deliberately turn/phase-independent — see
// turnMachine.js's resolveForfeit), not a turn-scoped control, so it
// doesn't belong among the roll/build/end-turn buttons that only make
// sense on your own turn.
//
// A destructive, irreversible action (WEBSOCKET_API.md's own FORFEIT_MATCH
// row: every owned property reverts to the Bank, all cash goes with it) —
// gated behind a real confirm step, not a single click, same posture this
// project's system-level safety rules require for anything hard to
// reverse.
//
// Two real outcomes are tracked, not assumed:
//   - success: the local player's OWN `bankrupt` flag flips true in the
//     next broadcast — confirmed by watching gameState itself, not just
//     "the send didn't throw" (sendGameAction is fire-and-forget over a
//     socket; the actual result only ever arrives as a later
//     S2C_STATE_UPDATE or S2C_ACTION_REJECTED). Once confirmed, this
//     leaves the match locally via the exact same disconnectSocket() +
//     resetAfterGame() pair GameOverScreen.jsx's own "Trở về sảnh" button
//     already uses — the match itself keeps running for whoever remains,
//     this player's own client just stops watching it.
//   - rejection (lastError, e.g. SOLE_SURVIVOR — the one real case where
//     forfeiting is refused: nobody would be left to continue the match):
//     shown inline, the confirm dialog stays open so the player can see
//     why and back out, rather than silently doing nothing.
export default function ForfeitButton() {
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const lastError = useGameStore((s) => s.lastError)
  const resetAfterGame = useGameStore((s) => s.resetAfterGame)

  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [rejection, setRejection] = useState(null) // the specific lastError object this attempt's own rejection produced, if any
  // lastError is store-wide, set by ANY rejected action this client ever
  // sends — a stale value already sitting there from something unrelated,
  // earlier in the session, must never read as "this forfeit was
  // rejected." Snapshotting the reference at the moment of sending and only
  // reacting to lastError actually CHANGING away from that snapshot (a
  // genuinely new rejection object) avoids that false positive.
  const [errorBaseline, setErrorBaseline] = useState(null)

  const me = gameState?.players.find((p) => p.playerId === user.id)

  useEffect(() => {
    if (!pending) return
    if (me?.bankrupt) {
      disconnectSocket()
      resetAfterGame()
    }
  }, [pending, me?.bankrupt, resetAfterGame])

  useEffect(() => {
    if (pending && lastError && lastError !== errorBaseline) {
      setPending(false)
      setRejection(lastError)
    }
  }, [pending, lastError, errorBaseline])

  // Nothing to surrender from, or already gone — no button at all rather
  // than a disabled one with nothing useful to explain.
  if (!gameState || !me || me.bankrupt || gameState.status !== 'in_progress') return null

  function confirm() {
    setRejection(null)
    setErrorBaseline(lastError)
    setPending(true)
    sendGameAction('FORFEIT_MATCH', {})
  }

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => {
          setRejection(null)
          setConfirming(true)
        }}
      >
        Đầu Hàng
      </button>

      {confirming && (
        <div className={styles.backdrop} onClick={() => !pending && setConfirming(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.title}>Đầu hàng và thoát trận đấu?</h3>
            <p className={styles.body}>
              Toàn bộ tiền mặt và bất động sản của bạn sẽ trả về Ngân Hàng. Trận đấu tiếp tục với những người chơi còn lại.
              Hành động này <strong>không thể hoàn tác</strong>.
            </p>
            {rejection && <ActionNotice error={rejection} />}
            <div className={styles.actions}>
              <button type="button" className={styles.cancelButton} disabled={pending} onClick={() => setConfirming(false)}>
                Hủy
              </button>
              <button type="button" className={styles.confirmButton} disabled={pending} onClick={confirm}>
                {pending ? 'Đang xử lý…' : 'Đầu hàng'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
