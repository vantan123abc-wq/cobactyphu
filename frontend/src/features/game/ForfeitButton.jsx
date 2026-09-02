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
//     this player's own client just stops watching it. **Only when the
//     match really does keep running**: surrendering as the second-to-last
//     player ends it outright, and leaving then would discard the result
//     screen (see the effect's own comment, fixed 2026-09-02).
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

  // Surrendering as the second-to-last player does not "leave a match that
  // carries on" — resolveForfeit ends it there and then, and whoever is left
  // wins by elimination. Mirrors that function's own `stillStanding` exactly,
  // so the dialog below can state the real consequence instead of the
  // 3+-player one it used to promise in every case (at a 2-player table it
  // was wrong 100% of the time).
  const survivors = gameState?.players.filter((p) => !p.isBank && !p.bankrupt && p.id !== me?.id) ?? []
  const endsTheMatch = survivors.length === 1

  useEffect(() => {
    if (!pending || !me?.bankrupt) return

    // 2026-09-02 bug fix — "ấn đầu hàng nhưng không kết thúc ván đấu".
    //
    // Surrendering as the second-to-last player ENDS the match: resolveForfeit
    // -> applyBankruptcy -> settleGameEnd sets status 'finished', endReason
    // 'elimination', and final ranks (verified against the real engine for
    // both the current-turn and non-current-turn forfeiter). The server was
    // always right; this client threw the result away. The moment `bankrupt`
    // arrived it called resetAfterGame(), which nulls currentGameState — so
    // GameOverScreen (`status !== 'finished'` -> null) could never render and
    // the player was dropped straight back to the lobby with no result,
    // no final rank, and every appearance of the match simply not ending.
    //
    // Leaving is only correct while the match CARRIES ON without me — the
    // 3+ player case this was written for. When my own surrender ended it,
    // stay: GameOverScreen owns the screen now and has its own "Trở về sảnh".
    if (gameState?.status === 'finished') {
      setPending(false)
      return
    }

    disconnectSocket()
    resetAfterGame()
  }, [pending, me?.bankrupt, gameState?.status, resetAfterGame])

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

      {/* The backdrop is now perfectly layered over the board because .topbar (its ancestor)
          has z-index: 50, which strictly defeats .body's z-index: 1. No portal needed. */}
      {confirming && (
        <div className={styles.backdrop} onClick={() => !pending && setConfirming(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.title}>{endsTheMatch ? 'Đầu hàng và kết thúc trận đấu?' : 'Đầu hàng và thoát trận đấu?'}</h3>
            <p className={styles.body}>
              Toàn bộ tiền mặt và bất động sản của bạn sẽ trả về Ngân Hàng.{' '}
              {endsTheMatch ? (
                <>
                  Bạn là người cuối cùng ngoài đối thủ, nên đầu hàng sẽ <strong>kết thúc trận đấu ngay lập tức</strong> và
                  người còn lại thắng.
                </>
              ) : (
                'Trận đấu tiếp tục với những người chơi còn lại.'
              )}{' '}
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
