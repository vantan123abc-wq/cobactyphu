import { useEffect, useRef } from 'react'
import { useAuth } from './features/auth/AuthContext'
import { useGameStore } from './store/gameStore'
import { getMe } from './network/api'
import { connectSocket, joinRoom } from './network/socketClient'
import Login from './pages/Login'
import LobbyDiagnostic from './features/lobby/LobbyDiagnostic'
import Lobby from './features/lobby/Lobby'
import GameView from './features/game/GameView'
import './App.css'

// No router — this project deliberately has none yet (PROJECT_STATUS.md:
// "no routing library in the frontend... will need real routing by P08's
// Lobby UI"); the three views below slot into the same plain
// conditional-render pattern already used for Login, rather than
// introducing a router for this.
//
// P11-T05: three-way view split, not two —
// - no roomState yet -> LobbyDiagnostic (create/join-room entry screen;
//   still the only thing that gets a player *into* a room at all).
// - roomState exists, game hasn't started -> Lobby (roster, ready, start).
// - game started -> GameView (P11-T06: GameBoard + GameControls together —
//   see GameView.jsx for why this is one composed view, not GameBoard
//   rendered here directly).
// "Started" reads gameState.phase or currentGameState presence as a
// fallback to roomState.roomStatus, not roomStatus alone. roomState.roomStatus
// is now kept live for every connected client via S2C_ROOM_UPDATED
// (WEBSOCKET_API.md §6, wired 2026-08-21 — Lobby.jsx's own header has the
// full story), closing the staleness gap this comment used to describe —
// the OR is kept anyway as a second, independent signal: currentGameState
// only ever gets set by a real S2C_STATE_UPDATE broadcast, a genuine
// "this game is live" fact regardless of whether the room-status push
// happened to arrive (e.g. a client that was offline for the push but
// reconnects mid-match via C2S_RECONNECT, which emits S2C_STATE_UPDATE
// directly, §5).
// Session resume (P03-T03, wired 2026-08-21) — before this, a page reload
// always landed back on the empty LobbyDiagnostic screen, even mid-match:
// roomState lives only in this in-memory Zustand store, and the socket was
// never proactively connected just from being logged in (only
// LobbyDiagnostic.jsx's own create/join clicks ever called connectSocket()).
// GET /api/v1/auth/me's activeRoomId/activeGameId (API_CONTRACT.md) exist
// specifically to answer "was this user already somewhere" in one call —
// attempted exactly once per login (a ref, not a state/effect dependency
// guard, so a later Supabase token refresh — a new `session` object, same
// user — can't accidentally re-trigger it and stomp on room state the user
// has since built up normally through the UI), and skipped entirely if
// roomState is already non-null by the time it would run (a real
// create/join already happened first, faster than this resolved).
function useSessionResume(user, session) {
  const attempted = useRef(false)

  useEffect(() => {
    if (!user || attempted.current) return
    if (useGameStore.getState().roomState) return
    attempted.current = true

    getMe(session.access_token)
      .then((me) => {
        if (!me.activeRoomId || useGameStore.getState().roomState) return
        const socket = connectSocket(session.access_token)
        const attach = () => {
          // An active game needs a real resync (C2S_RECONNECT — the same
          // event/handler socketClient.js's own S2C_ROOM_UPDATED listener
          // already uses for the "already connected when the match started"
          // case, WEBSOCKET_API.md §5) to get both S2C_ROOM_JOINED and a
          // real S2C_STATE_UPDATE in one round trip. Lobby-only (no game
          // yet) uses the ordinary C2S_JOIN_ROOM attach instead — reusing
          // C2S_RECONNECT there would fail its own ROOM_NOT_IN_PROGRESS
          // check for nothing.
          if (me.activeGameId) {
            socket.emit('C2S_RECONNECT', { roomId: me.activeRoomId })
          } else {
            joinRoom(me.activeRoomId)
          }
        }
        if (socket.connected) attach()
        else socket.once('connect', attach)
      })
      .catch((err) => console.error('Session resume (GET /auth/me) failed:', err.message))
  }, [user, session])
}

function App() {
  const { user, session, loading } = useAuth()
  const roomState = useGameStore((s) => s.roomState)
  const currentGameState = useGameStore((s) => s.currentGameState)

  useSessionResume(user, session)

  if (loading) {
    return (
      <section id="center">
        <p>Đang tải…</p>
      </section>
    )
  }

  if (!user) {
    return <Login />
  }

  const gameHasStarted = roomState?.roomStatus === 'in_progress' || currentGameState !== null

  // GameView redesign (2026-08-22): GameView.jsx now renders its own top bar
  // (same greeting text + the same supabase.auth.signOut() call, restyled
  // into its dedicated navy/gold shell) — this outer header is suppressed
  // specifically while GameView is showing, so there's no mismatched double
  // header (the app's normal light/dark-adaptive header sitting directly
  // above the in-game screen's own fixed dark theme).
  if (gameHasStarted && roomState) {
    return <GameView />
  }

  return (
    <>
      {!roomState && <LobbyDiagnostic />}
      {roomState && !gameHasStarted && <Lobby />}
    </>
  )
}

export default App
