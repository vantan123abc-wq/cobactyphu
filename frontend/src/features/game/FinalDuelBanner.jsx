import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { getRoom } from '../../network/api'
import { playerNetWorth } from './netWorthMirror'
import styles from './FinalDuelBanner.module.css'

// Final Duel (2026-08-25, user request) — a one-shot announcement the
// instant a multi-player match narrows to its last two survivors. Purely a
// moment of tension: it changes NO rules at all. The win condition is
// unchanged (Last Tycoon Standing — gameEndMachine.js's checkElimination),
// the economy is unchanged, and Final Phase's own round-20 countdown
// (FinalPhaseBanner.jsx) still runs independently alongside this and can
// still end the match on net worth first. The user's own framing for why it
// earns its place: "Không còn cảm giác 'game chưa biết bao giờ kết thúc'".
//
// Deliberately NO backend field for this. Every input is already in the
// broadcast gameState (bankrupt players are never removed from
// `players` — that's the whole point of the spectator design,
// GAME_DESIGN_SPEC.md §17), so this derives the condition client-side
// rather than adding a GameState field that could drift out of sync with
// the player list it would be summarising. Same reasoning PlayersPanel.jsx
// already uses to derive its own standings instead of reading a stored rank.
//
// The `startedWithMoreThanTwo` half is load-bearing, not defensive padding:
// a 2-player match is perfectly legal (GAME_DESIGN_SPEC.md §4 allows 2-6),
// and without it `activeCount === 2` would be true from the very first turn
// of every such match — firing a "FINAL DUEL" announcement at match start,
// which is both wrong and silly. A match that began as a duel has no
// narrowing moment to announce; only one that lost players does.
function Side({ player, name, gameState, staticBoard }) {
  return (
    <div className={styles.side}>
      <span className={styles.playerName}>{name}</span>
      <span className={styles.cash}>${player.currentBalance}</span>
      <span className={styles.worthLabel}>Tổng tài sản</span>
      <span className={styles.worth}>${playerNetWorth(gameState, staticBoard, player)}</span>
    </div>
  )
}

export default function FinalDuelBanner() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)

  const [displayNames, setDisplayNames] = useState({})
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // a name-lookup miss is cosmetic only — the banner still shows real balances
  }, [roomId, session.access_token])

  if (!gameState || !staticBoard || dismissed) return null

  const realPlayers = gameState.players.filter((p) => !p.isBank)
  const survivors = realPlayers.filter((p) => !p.bankrupt)
  if (survivors.length !== 2 || realPlayers.length <= 2) return null

  // Once two players remain, the count can only ever fall to one (which ends
  // the match outright) — it can never climb back to three. So "dismissed"
  // needs no re-arming key at all, unlike FinalPhaseBanner.jsx's own
  // round-number-keyed dismissal: this condition is one-way and terminal.
  const nameFor = (p) => (p.playerId === user?.id ? 'Bạn' : (displayNames[p.playerId] ?? p.playerId ?? '…'))

  return (
    <div className={styles.wrap}>
      <div className={styles.banner}>
        <p className={styles.title}>🔥 SONG ĐẤU CUỐI CÙNG</p>
        <p className={styles.subtitle}>Chỉ còn hai người trụ lại</p>

        <div className={styles.versus}>
          <Side player={survivors[0]} name={nameFor(survivors[0])} gameState={gameState} staticBoard={staticBoard} />
          <span className={styles.vs}>VS</span>
          <Side player={survivors[1]} name={nameFor(survivors[1])} gameState={gameState} staticBoard={staticBoard} />
        </div>

        <p className={styles.body}>Người còn đứng vững cuối cùng sẽ thắng.</p>
        <button type="button" className={styles.dismissButton} onClick={() => setDismissed(true)}>
          Vào trận
        </button>
      </div>
    </div>
  )
}
