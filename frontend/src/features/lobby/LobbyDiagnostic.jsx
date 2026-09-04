import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { supabase } from '../../supabaseClient'
import { useGameStore } from '../../store/gameStore'
import { createRoom, joinRoomByCode } from '../../network/api'
import { connectSocket, joinRoom } from '../../network/socketClient'

// Minimal, deliberately unstyled diagnostic view (P11-T01) — proves the
// pipeline (REST room create/join -> socket attach -> S2C_STATE_UPDATE ->
// store -> re-render) works end to end. Not the lobby/board UI itself.

const STATUS_LABEL = {
  connected: '🟢 Online',
  connecting: '🟡 Connecting…',
  reconnecting: '🟡 Reconnecting…',
  disconnected: '🔴 Offline',
}

export default function LobbyDiagnostic() {
  const { session } = useAuth()
  const connectionStatus = useGameStore((s) => s.connectionStatus)
  const lastError = useGameStore((s) => s.lastError)
  const roomExitNotice = useGameStore((s) => s.roomExitNotice)
  const setRoomExitNotice = useGameStore((s) => s.setRoomExitNotice)
  // roomState/currentGameState/offlinePlayerIds subscriptions dropped
  // 2026-08-23: leftovers from this file's original raw-diagnostic version,
  // which dumped them on screen. Nothing renders them any more, and each one
  // was still subscribing this component to a store slice that changes on
  // every single broadcast — re-rendering the lobby for game state it does
  // not display.

  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState(null)

  function attachSocketAndJoin(roomId) {
    const socket = connectSocket(session.access_token)
    if (socket.connected) {
      joinRoom(roomId)
    } else {
      socket.once('connect', () => joinRoom(roomId))
    }
  }

  // roomExitNotice ("you're no longer a member of that room") had no way to
  // be dismissed — it was set by Lobby.jsx and then displayed here forever,
  // so a player who'd been kicked once carried that message through every
  // later session on this screen. Cleared whenever they start a fresh
  // create/join, which is exactly the point it stops being true.
  const [ruleset, setRuleset] = useState('CLASSIC')

  async function handleCreateRoom() {
    setBusy(true)
    setFormError(null)
    setRoomExitNotice(null)
    try {
      const room = await createRoom(session.access_token, ruleset)
      attachSocketAndJoin(room.roomId)
    } catch (err) {
      setFormError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleJoinRoom() {
    if (!joinCode.trim()) return
    setBusy(true)
    setFormError(null)
    setRoomExitNotice(null)
    try {
      const room = await joinRoomByCode(session.access_token, joinCode.trim().toUpperCase())
      attachSocketAndJoin(room.roomId)
    } catch (err) {
      setFormError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const getStatusClass = () => {
    if (connectionStatus === 'connected') return 'lobby-dot online';
    if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') return 'lobby-dot connecting';
    return 'lobby-dot offline';
  }

  return (
    <div className="lobby-shell">
      <header className="lobby-topbar">
        <span className="lobby-greeting">Xin chào, <strong>{session.user.user_metadata?.display_name || session.user.email}</strong></span>
        <button type="button" className="lobby-logout" onClick={() => supabase.auth.signOut()}>
          Đăng xuất
        </button>
      </header>

      <main className="lobby-content">
        <h1 className="lobby-brand">Cờ Tỷ Phú</h1>
        <p className="lobby-subtitle">Business Tour Edition</p>

        <div className="lobby-card">
          <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
            <label htmlFor="rulesetSelect" style={{ fontSize: '0.9rem', color: '#666', fontWeight: 600 }}>CHẾ ĐỘ CHƠI</label>
            <select
              id="rulesetSelect"
              value={ruleset}
              onChange={(e) => setRuleset(e.target.value)}
              className="lobby-input"
              style={{ width: '100%', textAlign: 'center' }}
            >
              <option value="CLASSIC">Cổ Điển (Nhân Đôi Gốc)</option>
              <option value="ASYMMETRIC">Đột Phá (Thế Lực Nhóm Màu)</option>
            </select>
          </div>

          <button type="button" className="lobby-btn-primary" onClick={handleCreateRoom} disabled={busy}>
            {busy ? 'ĐANG TẠO...' : 'TẠO PHÒNG MỚI'}
          </button>

          <div className="lobby-divider">hoặc</div>

          <div className="lobby-joinGroup">
            <input 
              className="lobby-input" 
              value={joinCode} 
              onChange={(e) => setJoinCode(e.target.value)} 
              placeholder="MÃ PHÒNG (6 KÝ TỰ)" 
              maxLength={6} 
            />
            <button type="button" className="lobby-btn-secondary" onClick={handleJoinRoom} disabled={busy || joinCode.trim().length < 6}>
              {busy ? 'ĐANG VÀO...' : 'VÀO PHÒNG'}
            </button>
          </div>

          <div className="lobby-status">
            <span className={getStatusClass()} />
            {STATUS_LABEL[connectionStatus] ?? connectionStatus}
          </div>

          {(formError || lastError || roomExitNotice) && (
            <div className="lobby-error">
              {formError || roomExitNotice || `Lỗi: ${lastError?.message}`}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
