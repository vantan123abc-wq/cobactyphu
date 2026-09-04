import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { getRoom, setReady, setZodiac, startGame, leaveRoom, kickPlayer } from '../../network/api'
import { ZODIAC, zodiacEmoji } from '../board/zodiac'
import styles from './Lobby.module.css'

// Room roster (players[]/hostId/joinCode) is deliberately fetched here via
// REST, not read from useGameStore's `roomState`. That store field mirrors
// S2C_ROOM_JOINED's real payload exactly (`{ roomId, playerId, members,
// roomStatus }` — WEBSOCKET_API.md §4) — `members` is only ever an array of
// playerId *strings*, no displayName/isHost/isReady. The richer shape this
// screen needs only exists on the REST side (API_CONTRACT.md's
// `GET /api/v1/rooms/:id` -> `{ ..., players: [{ playerId, displayName,
// isReady, isHost }] }`), so it's local component state, refreshed here,
// not bolted onto the store's socket-shaped field.
//
// Real-time push, wired 2026-08-21 (WEBSOCKET_API.md §6, S2C_ROOM_UPDATED):
// socketClient.js's listener bumps the store's roomUpdatedAt the instant any
// room-mutating REST call (join/ready/start/leave/kick, by any member)
// succeeds, and the effect below re-fetches on that bump — so another
// player's ready-toggle or the host's Start click now reaches this screen
// immediately, not just on the next poll tick. The poll stays as a fallback
// (a missed/late socket message, or this client reconnecting) rather than
// being replaced outright — same "fast path plus an existing fallback, not
// instead of it" posture GameControls.jsx's own handleStart() local-patch
// already uses.
// 12s, was 3s (2026-09-04). At 3s every client in the lobby fired a
// `GET /rooms/:id` — three sequential Supabase queries each — twenty times a
// minute, forever, against a free-tier Render instance on a shared CPU. A
// 4-player lobby generated roughly four database queries per second of pure
// background noise, which slowed down the actions people were actually
// waiting on. Now that S2C_ROOM_UPDATED carries the roster itself, this poll
// is only a safety net for a socket that dropped without reconnecting, so it
// does not need to be fast.
const POLL_INTERVAL_MS = 12000
const MIN_PLAYERS = 2 // GAME_DESIGN_SPEC.md §0, CONFIRMED — duplicated here, not imported; no shared package crosses the frontend/backend boundary in this project

export default function Lobby() {
  const { session, user } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const roomState = useGameStore((s) => s.roomState)
  const setRoomState = useGameStore((s) => s.setRoomState)
  const setRoomExitNotice = useGameStore((s) => s.setRoomExitNotice)
  const roomUpdatedAt = useGameStore((s) => s.roomUpdatedAt)
  const pushedRoom = useGameStore((s) => s.pushedRoom)

  const [room, setRoom] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Leave/kick UI, 2026-08-21. A kicked player has no dedicated "you were
  // kicked" signal anywhere in the wire contract (S2C_ROOM_UPDATED just
  // says roomStatus changed, and a kicked player's own socket is still in
  // that room's broadcast group — flagged, not fixed, in WEBSOCKET_API.md
  // §6's own writeup) — but the *same* push already triggers this refresh,
  // and a kicked player's own GET /rooms/:id now 404s NOT_FOUND (getRoom's
  // real, already-existing privacy rule: "not a member" reads identically
  // to "doesn't exist"). Reusing that instead of building new wire protocol:
  // a 404 here means "I'm not in this room anymore," full stop — clear
  // roomState (routes back to LobbyDiagnostic) and leave a one-line notice
  // there instead of getting stuck showing an error on a room screen the
  // player has actually already been removed from.
  // Real race found live-testing this same slice, fixed here: a poll tick
  // (or a push-triggered refresh) already in flight when the user clicks
  // "Rời phòng" resolves *after* handleLeave's own setRoomState(null) —
  // since leaving empties this room for a solo host, that stale response's
  // own membership check also now fails, so its catch block would set the
  // *kicked* wording over a perfectly deliberate self-leave. Guarded by
  // comparing this call's own roomId against whatever the store's
  // roomState.roomId actually is *at the moment the response lands*, not
  // the one this closure captured at call time — a mismatch (including
  // roomState already being null) means the user has already moved on,
  // and the response is simply stale, not new information to act on.
  const refresh = useCallback(async () => {
    if (!roomId) return
    try {
      const fresh = await getRoom(session.access_token, roomId)
      if (useGameStore.getState().roomState?.roomId !== roomId) return
      setRoom(fresh)
    } catch (err) {
      if (useGameStore.getState().roomState?.roomId !== roomId) return
      if (err.code === 'NOT_FOUND') {
        setRoomExitNotice('Bạn không còn ở trong phòng này (có thể đã bị đuổi, hoặc phòng không còn tồn tại).')
        setRoomState(null)
        return
      }
      setError(err.message)
    }
  }, [roomId, session.access_token, setRoomExitNotice, setRoomState])

  // One REST read on mount, then a slow poll purely as a safety net for a
  // dropped socket. The push below is the real path now.
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  // The push carries the whole roster as of 2026-09-04, so this renders
  // straight from it instead of answering it with a REST round trip. That
  // round trip was the actual reason another player's "Sẵn Sàng" took about a
  // second to appear: GET /rooms/:id is three sequential Supabase queries, and
  // the deployed backend runs in Render's Oregon region while the database
  // answers from Asia and the players are in Vietnam — so the client paid a
  // Pacific crossing to re-fetch data the server had already put on the wire.
  // An older server that sends no `room` still falls through to refresh(), so
  // this degrades rather than breaks.
  useEffect(() => {
    if (!roomUpdatedAt || !roomId) return
    if (!pushedRoom || pushedRoom.roomId !== roomId) {
      refresh()
      return
    }
    // Being absent from the pushed roster is now the fastest and most direct
    // "you are no longer in this room" signal there is — it arrives on the
    // same push as the removal itself. The 404-on-refetch rule this screen
    // relied on before still exists and still works (the poll above will hit
    // it), but it could only fire on the next fetch, and this path
    // deliberately stops fetching.
    if (!pushedRoom.players?.some((p) => p.playerId === user.id)) {
      setRoomExitNotice('Bạn không còn ở trong phòng này (có thể đã bị đuổi, hoặc phòng không còn tồn tại).')
      setRoomState(null)
      return
    }
    setRoom(pushedRoom)
  }, [roomUpdatedAt, pushedRoom, roomId, user.id, refresh, setRoomExitNotice, setRoomState])

  const players = room?.players ?? []
  const me = players.find((p) => p.playerId === user.id)
  const isHost = room?.hostId === user.id
  const allNonHostReady = players.filter((p) => !p.isHost).every((p) => p.isReady)
  const canStart = isHost && players.length >= MIN_PLAYERS && allNonHostReady

  async function handleToggleReady() {
    if (!me) return
    setBusy(true)
    setError(null)
    try {
      await setReady(session.access_token, roomId, !me.isReady)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleStart() {
    setBusy(true)
    setError(null)
    try {
      await startGame(session.access_token, roomId)
      // Locally reflect it for the host's own view immediately, rather than
      // waiting on the round-trip of its own S2C_ROOM_UPDATED push (below) —
      // that push now also reaches every *other* connected player the same
      // instant (WEBSOCKET_API.md §6, wired 2026-08-21, closing the gap this
      // comment used to describe), so this patch is now a same-client
      // optimism shortcut, not the only way anyone finds out.
      setRoomState({ ...roomState, roomStatus: 'in_progress' })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // Available to any member, host included — GAME_DESIGN_SPEC.md §4: the
  // host leaving transfers the role to the next-joined player, entirely
  // server-side, no client input needed for that. No local optimistic
  // patch needed either (unlike handleStart above) — success routes back
  // to LobbyDiagnostic by clearing roomState, which unmounts this
  // component outright, so there's no "own view" left to keep in sync.
  async function handleLeave() {
    setBusy(true)
    setError(null)
    try {
      await leaveRoom(session.access_token, roomId)
      setRoomState(null)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  // Zodiac picker (2026-08-22) — chosen here, in the lobby, before a match
  // starts; a player who never picks gets a random one assigned at game
  // start (room.controller.js's initializeGameState). Toggle-off on
  // re-clicking your own current pick, same "click the already-selected
  // thing again to clear it" convention BoardTile.jsx's own onClick wiring
  // already established elsewhere in this app.
  async function handlePickZodiac(key) {
    if (!me) return
    setBusy(true)
    setError(null)
    try {
      await setZodiac(session.access_token, roomId, me.zodiac === key ? null : key)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // Host-only (the button below is only ever rendered for the host, against
  // a non-host row — mirrors the server's own NOT_HOST/CANNOT_KICK_HOST
  // checks so a doomed click is never even possible from this UI).
  async function handleKick(targetPlayerId, targetDisplayName) {
    if (!window.confirm(`Đuổi ${targetDisplayName} khỏi phòng?`)) return
    setBusy(true)
    setError(null)
    try {
      await kickPlayer(session.access_token, roomId, targetPlayerId)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!room) {
    return (
      <section className={styles.lobby}>
        <p>Đang tải phòng…</p>
        {error && <p className={styles.error}>{error}</p>}
      </section>
    )
  }

  return (
    <section className={styles.lobby}>
      <h2>Phòng chờ</h2>

      <div className={styles.joinCode}>
        <span className={styles.joinCodeLabel}>Mã phòng</span>
        <span className={styles.joinCodeValue}>{room.joinCode}</span>
      </div>

      <div style={{ textAlign: 'center', marginBottom: '24px', color: '#666', fontWeight: 'bold' }}>
        Chế độ: {room.ruleset === 'ASYMMETRIC' ? 'Đột Phá (Thế Lực Nhóm Màu)' : 'Cổ Điển'}
      </div>

      <ul className={styles.playerList}>
        {players.map((player) => (
          <li key={player.playerId} className={styles.playerRow}>
            <span className={styles.playerName}>
              {/* A player who hasn't picked yet (zodiac null) shows no
                  glyph at all here — the real, final assignment (their own
                  pick, or a random one) only happens at game start, so
                  showing a placeholder emoji now would just be misleading. */}
              {player.zodiac && <span className={styles.zodiacGlyph}>{zodiacEmoji(player.zodiac)}</span>}
              {player.displayName}
              {player.isHost && <span className={styles.hostBadge}>Chủ phòng</span>}
            </span>
            {!player.isHost && (
              <span className={styles.playerRowEnd}>
                <span className={player.isReady ? styles.readyYes : styles.readyNo}>
                  {player.isReady ? 'Sẵn sàng' : 'Chưa sẵn sàng'}
                </span>
                {isHost && (
                  <button
                    type="button"
                    className={styles.kickButton}
                    disabled={busy}
                    onClick={() => handleKick(player.playerId, player.displayName)}
                  >
                    Đuổi
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>

      {me && (
        <div className={styles.zodiacPicker}>
          <p className={styles.zodiacPickerLabel}>
            Chọn nhân vật (con giáp) — bỏ trống thì game sẽ tự chọn ngẫu nhiên khi bắt đầu
          </p>
          <div className={styles.zodiacGrid}>
            {ZODIAC.map((z) => (
              <button
                key={z.key}
                type="button"
                className={`${styles.zodiacOption} ${me.zodiac === z.key ? styles.zodiacOptionSelected : ''}`}
                disabled={busy}
                title={z.label}
                aria-pressed={me.zodiac === z.key}
                onClick={() => handlePickZodiac(z.key)}
              >
                <span className={styles.zodiacOptionEmoji}>{z.emoji}</span>
                <span className={styles.zodiacOptionLabel}>{z.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {!isHost && me && (
        <button type="button" className={styles.actionButton} disabled={busy} onClick={handleToggleReady}>
          {me.isReady ? 'Huỷ sẵn sàng' : 'Sẵn sàng'}
        </button>
      )}

      {isHost && (
        <button
          type="button"
          className={styles.actionButton}
          disabled={busy || !canStart}
          onClick={handleStart}
          title={!canStart ? `Cần tối thiểu ${MIN_PLAYERS} người chơi, tất cả khách đã sẵn sàng` : undefined}
        >
          Bắt đầu ván
        </button>
      )}

      <button type="button" className={styles.leaveButton} disabled={busy} onClick={handleLeave}>
        Rời phòng
      </button>
    </section>
  )
}
