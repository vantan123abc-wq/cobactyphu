import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { getRoom } from '../../network/api'
import { disconnectSocket } from '../../network/socketClient'
import styles from './GameOverScreen.module.css'

// Win Condition design (2026-08-19) §I: "ranked list: place, name, final net
// worth, one breakdown line... No charts, no history. Do not design an
// overly complicated scoreboard." The plan's own sketch of that breakdown
// line named three parts (cash / property / buildings) — but the server
// side of this feature (gameEndMachine.js's rankPlayers(), reusing
// netWorth.js's propertyNetWorth()) only ever computes land+building value
// as one combined figure per property, never split apart; splitting it
// would mean reworking already-tested engine code for a purely cosmetic
// gain. Simplified here to a two-part line (cash / property, with the
// label spelling out that property includes buildings) — a deliberate,
// minor refinement of the plan's literal wording, in the same spirit as
// that plan's own "don't overcomplicate the scoreboard" instruction, not a
// silent scope cut.
//
// Post-game actions (2026-08-22): "Trở về sảnh" button added at the bottom.
// Calls resetAfterGame() + disconnectSocket() to tear down the current session.
// After reset, App.jsx's conditional render (roomState === null → LobbyDiagnostic)
// handles navigation automatically — no router needed.
// The server doesn't have a "rematch" endpoint — a new game always means the
// host creates a fresh room in LobbyDiagnostic, so no separate "play again"
// button exists here; the hint text makes that clear.
const END_REASON_LABEL = {
  elimination: 'Chỉ còn một người trụ lại — thắng do loại toàn bộ đối thủ.',
  final_phase: 'Giai Đoạn Cuối đã kết thúc — người có tổng tài sản ròng cao nhất thắng.',
}

export default function GameOverScreen() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const resetAfterGame = useGameStore((s) => s.resetAfterGame)

  const [displayNames, setDisplayNames] = useState({})
  const [leaving, setLeaving] = useState(false)

  // Same one-shot REST lookup GameControls.jsx/EventCardModal.jsx already
  // use — GameState.players has no displayName field at all (only
  // playerId/turnOrder/currentBalance/...), see GameControls.jsx's own
  // header for why.
  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {})
  }, [roomId, session.access_token])

  if (!gameState || gameState.status !== 'finished') return null

  const me = gameState.players.find((p) => p.playerId === user.id)
  const nameFor = (player) => displayNames[player.playerId] ?? player.playerId ?? '…'
  const iWon = me?.finalRank === 1

  const standings = gameState.players
    .filter((p) => !p.isBank)
    .slice()
    .sort((a, b) => (a.finalRank ?? Infinity) - (b.finalRank ?? Infinity))

  function handleLeave() {
    setLeaving(true)
    disconnectSocket()
    // resetAfterGame sets roomState → null, which makes App.jsx unmount
    // GameView and render LobbyDiagnostic — no navigation or router needed.
    resetAfterGame()
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.modal}>
        {/* Winner celebration or neutral header */}
        {iWon ? (
          <div className={styles.winnerBanner}>
            <span className={styles.winnerCrown}>🏆</span>
            <p className={styles.winnerLabel}>Chúc mừng! Bạn đã thắng!</p>
          </div>
        ) : (
          <p className={styles.eyebrow}>🏁 Ván Đấu Kết Thúc</p>
        )}

        <p className={styles.reason}>{END_REASON_LABEL[gameState.endReason] ?? 'Ván đấu đã kết thúc.'}</p>

        <ol className={styles.standings}>
          {standings.map((p) => (
            <li key={p.id} className={p.id === me?.id ? styles.rowMe : styles.row}>
              <span className={styles.place}>{p.finalRank === 1 ? '🏆' : `#${p.finalRank ?? '?'}`}</span>
              <div className={styles.rowBody}>
                <p className={styles.name}>
                  {nameFor(p)}
                  {p.bankrupt ? <span className={styles.bankruptTag}> · phá sản</span> : null}
                </p>
                <p className={styles.breakdown}>
                  Tiền mặt ${p.finalCash ?? 0} · Bất động sản (gồm nhà/khách sạn) ${p.finalPropertyValue ?? 0}
                </p>
              </div>
              <span className={styles.netWorth}>${p.finalNetWorth ?? 0}</span>
            </li>
          ))}
        </ol>

        {/* Post-game action */}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.leaveButton}
            disabled={leaving}
            onClick={handleLeave}
          >
            {leaving ? 'Đang thoát…' : '🚪 Trở về sảnh'}
          </button>
        </div>

        <p className={styles.hint}>Để chơi lại, hãy về sảnh và tạo phòng mới.</p>
      </div>
    </div>
  )
}
