import { io } from 'socket.io-client'
import { useGameStore } from '../store/gameStore'
import { getBoardConfig } from './api.js'
import { BANK_ID } from '../features/game/ledgerFormat.js'

// Socket.IO client (P11-T01) — a plain singleton module, not a React hook,
// so network logic stays fully decoupled from any component: it reads/
// writes `useGameStore` directly via `.getState()`/store actions (Zustand's
// documented "use outside React" pattern), the same way a plain service
// class would touch a shared store. Components only ever read the store
// and call the exported functions below — they never touch `socket`
// itself.
//
// Every event name/payload shape below is backend/docs/WEBSOCKET_API.md's
// real, already-implemented contract (built in this same codebase,
// P09/P10-T02/T03/T04) — not re-derived from the task brief's own looser
// sketch.
//
// P11-T03/T04: static board data. The task's own suggested integration
// point (S2C_ROOM_JOINED) doesn't work — `rooms` has no board_id column at
// all (DATABASE_DESIGN.md §2; board size is chosen automatically at
// start_game, by player count, ADAPTIVE_BOARD_DESIGN.md), and
// S2C_ROOM_JOINED's real payload (WEBSOCKET_API.md §4) is exactly
// `{ roomId, playerId, members, roomStatus }` — no board field to read.
// `boardId` only ever exists on GameState, which only ever reaches the
// client via S2C_STATE_UPDATE (a fresh game action, a fired turn timer, or
// a reconnect resync — all the same event). ensureStaticBoardLoaded() below
// is hooked there instead, and only actually fetches when the boardId
// genuinely changes, so it doesn't re-fetch on every single action
// broadcast during a match.

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL

let socket = null
let authToken = null // captured in connectSocket(), reused for the boards REST fetch below — same JWT, no separate credential

// Ledger feed (GameView redesign, 2026-08-22) — turns one broadcast's raw
// Transaction[] (applyTransaction.js's own shape: fromGamePlayerId/
// toGamePlayerId/amount/transactionType only, no property/tile reference)
// into gameStore's stored log-entry shape, resolved *now* rather than at
// render time. Two things specifically need resolving against this exact
// broadcast's own gameState, not a later one: which side is the Bank
// (isBank isn't on the transaction record itself, only on the player list),
// and — for rent/purchase only — which tile the payer/buyer is standing on.
// A later broadcast could move that same player again before the log entry
// is ever rendered; resolving late would silently attribute an old rent
// payment to wherever that player happens to be *now*, not where they
// actually were when it happened.
function buildLedgerEntries(gameState, transactions, staticBoard) {
  if (!transactions?.length) return []

  return transactions
    .filter((t) => t.transactionType !== 'initial_balance') // one-time, start-of-game noise — not interesting mid-match
    .map((t) => {
      const fromPlayer = gameState.players.find((p) => p.id === t.fromGamePlayerId)
      const toPlayer = gameState.players.find((p) => p.id === t.toGamePlayerId)

      let tileName = null
      if ((t.transactionType === 'rent' || t.transactionType === 'purchase') && fromPlayer && staticBoard?.boardId === gameState.boardId) {
        // The payer/buyer is standing on the relevant tile *right now*, in
        // this same post-action gameState — true for both cases (a rent
        // payment or a purchase always follows landing on that exact tile
        // this same action, BUY_PROPERTY's own payload is genuinely empty
        // for the same reason, see PropertyActionDrawer.jsx's header).
        tileName = staticBoard.tiles.find((tile) => tile.position === fromPlayer.currentPosition)?.name ?? null
      }

      return {
        id: crypto.randomUUID(),
        transactionType: t.transactionType,
        amount: t.amount,
        fromPlayerId: fromPlayer?.isBank ? BANK_ID : (fromPlayer?.playerId ?? BANK_ID),
        toPlayerId: toPlayer?.isBank ? BANK_ID : (toPlayer?.playerId ?? BANK_ID),
        tileName,
        atStateVersion: gameState.stateVersion,
      }
    })
}

// Event-card history (2026-08-25) — see gameStore's own eventCardLog comment
// for why a log is needed at all rather than reading GameState.
//
// Detected by lastDrawnEventCardSeq strictly increasing, NOT by
// lastDrawnEventCardId changing: that id is sticky and can legitimately
// repeat (the deck cycles, so the same card really is drawn again later),
// while the seq counter increments only inside resolveDrawingCard. A
// reconnect resync re-delivers the current gameState verbatim, so `>` is
// what keeps a replay from logging a phantom second draw — and the store's
// own append is keyed on seq as a second guard.
//
// The drawer is resolved here, at arrival, rather than at render time: for a
// card that ends the turn (MOVE_TO_JAIL, or a move that lands somewhere
// turn-ending) currentTurnIndex has already advanced by the time a later
// render would look, which would silently credit the draw to the wrong
// player. Best-effort by the same rule EventCardModal uses — the drawer is
// always the current-turn player at the moment of the draw.
let lastLoggedDrawSeq = 0

function recordEventCardDraw(gameState) {
  const seq = gameState?.lastDrawnEventCardSeq
  if (typeof seq !== 'number' || seq <= lastLoggedDrawSeq) return
  lastLoggedDrawSeq = seq

  const cardId = gameState.lastDrawnEventCardId
  if (!cardId) return

  const drawer = gameState.players?.find((p) => !p.isBank && p.turnOrder === gameState.currentTurnIndex)
  useGameStore.getState().appendEventCard({
    seq,
    cardId,
    drawerPlayerId: drawer?.playerId ?? null,
    at: Date.now(),
  })
}

async function ensureStaticBoardLoaded(boardId) {
  if (!boardId) return
  if (useGameStore.getState().staticBoard?.boardId === boardId) return // already have this board's layout
  try {
    const board = await getBoardConfig(authToken, boardId)
    useGameStore.getState().setStaticBoard(board)
  } catch (err) {
    console.error(`Failed to load static board data for '${boardId}':`, err.message)
  }
}

function attachListeners(sock) {
  sock.on('connect', () => {
    useGameStore.getState().setConnectionStatus('connected')

    // A transport reconnect after a real drop, not the first-ever connect
    // (we only have a roomState once C2S_JOIN_ROOM/C2S_RECONNECT has
    // already succeeded once). C2S_JOIN_ROOM is the lobby-phase attach —
    // WEBSOCKET_API.md §5 is explicit that it is *not* the reconnect path
    // for an in-progress game; C2S_RECONNECT is what actually resyncs
    // GameState and flips this player's presence back online. Not
    // something the task brief called out explicitly, but required for a
    // returning socket to behave correctly against the real backend
    // contract rather than silently going stale.
    const roomId = useGameStore.getState().roomState?.roomId
    if (roomId) {
      sock.emit('C2S_RECONNECT', { roomId })
    }
  })

  sock.on('disconnect', () => {
    useGameStore.getState().setConnectionStatus('disconnected')
  })

  // Handshake rejection (bad/expired token, server down at the moment of a
  // retry, ...) — found live, 2026-08-22: this had no listener at all, so a
  // rejected handshake vanished silently and Socket.IO's own automatic
  // retry loop (reconnection: true by default) just kept retrying forever
  // with no visible trace anywhere, while GameBoard.jsx sat on its generic
  // "loading" message indefinitely. Not fixing the retry loop itself here
  // (see updateAuthToken below for why a *stale* token specifically no
  // longer causes this) — just making a genuine failure observable instead
  // of silent, the same "surface it, don't swallow it" standard every other
  // handler in this file already follows for a real rejection.
  sock.on('connect_error', (err) => {
    console.error('Socket connection failed:', err.message)
    useGameStore.getState().setConnectionStatus('reconnecting')
  })

  // socket.io-client's own transport-level auto-reconnect attempts live on
  // the Manager (`sock.io`), not the Socket itself.
  sock.io.on('reconnect_attempt', () => {
    useGameStore.getState().setConnectionStatus('reconnecting')
  })

  sock.on('S2C_ROOM_JOINED', (payload) => {
    useGameStore.getState().setRoomState(payload)
  })

  // Lobby real-time push (WEBSOCKET_API.md §6, wired 2026-08-21) — closes
  // Lobby.jsx's own long-flagged gap ("another player's ready-toggle or the
  // host's Start click isn't pushed to anyone else's client in real time").
  sock.on('S2C_ROOM_UPDATED', (payload) => {
    useGameStore.getState().applyRoomUpdated(payload)

    // Real gap found while live-verifying this same push (2026-08-21, not
    // originally part of it, fixed alongside since it made the push's own
    // headline benefit pointless in practice): App.jsx's gameHasStarted now
    // correctly flips to GameView the instant roomStatus reaches
    // 'in_progress' — but GameView's own children (GameControls.jsx/
    // GameBoard.jsx) both render nothing until currentGameState exists, and
    // nothing was ever emitting C2S_RECONNECT for an already-connected
    // socket that never actually dropped. The 'connect' handler above only
    // fires C2S_RECONNECT on a genuine transport (re)connect — a socket
    // that's been sitting in the lobby the whole time, connected
    // throughout, never re-fires 'connect' just because roomStatus changed,
    // so it would never resync at all otherwise (this affects every
    // player, including the one who clicked Start themselves — S2C_ROOM_UPDATED
    // is broadcast sender-included, WEBSOCKET_API.md §6, so this same
    // handler covers the host's own socket too, no special-casing needed).
    // Guarded on currentGameState still being null so this fires exactly
    // once per match, not on every subsequent lobby-adjacent push.
    if (payload.roomStatus === 'in_progress' && useGameStore.getState().currentGameState === null) {
      sock.emit('C2S_RECONNECT', { roomId: payload.roomId })
    }
  })

  sock.on('S2C_STATE_UPDATE', (payload) => {
    useGameStore.getState().setGameState(payload)
    ensureStaticBoardLoaded(payload.gameState?.boardId)
    recordEventCardDraw(payload.gameState)
    // Reads staticBoard *before* the ensureStaticBoardLoaded() call above
    // resolves (that fetch is fire-and-forget, not awaited) — on the very
    // first state update of a session, before any board fetch has landed
    // yet, this means a rent/purchase entry logged right then just won't
    // get a tileName (falls back to the shorter, still-correct phrasing,
    // see ledgerFormat.js). Not worth a retry/backfill mechanism for a gap
    // that only affects the first broadcast of a match.
    if (payload.gameState && payload.transactions?.length) {
      const entries = buildLedgerEntries(payload.gameState, payload.transactions, useGameStore.getState().staticBoard)
      if (entries.length) useGameStore.getState().appendTransactionLog(entries)
    }
  })

  sock.on('S2C_PLAYER_DISCONNECTED', ({ playerId }) => {
    useGameStore.getState().markPlayerOffline(playerId)
  })

  sock.on('S2C_PLAYER_RECONNECTED', ({ playerId }) => {
    useGameStore.getState().markPlayerOnline(playerId)
  })

  sock.on('S2C_ACTION_REJECTED', (payload) => {
    useGameStore.getState().setLastError(payload)
  })
}

/**
 * Connects (or returns the existing connection) authenticated as `token`
 * (the Supabase JWT, `session.access_token` — verified handshake-time by
 * `createSocketAuthMiddleware`, same as every other consumer of this
 * token). Idempotent: a second call while already connected/connecting is
 * a no-op, same socket returned.
 * @param {string} token
 * @returns {import('socket.io-client').Socket}
 */
export function connectSocket(token) {
  if (socket) {
    return socket
  }
  authToken = token
  useGameStore.getState().setConnectionStatus('connecting')
  // `auth` as a callback (re-invoked before *every* connection attempt,
  // including each automatic reconnect the Manager makes) rather than a
  // plain `{ token }` object — a plain object is captured once and replayed
  // unchanged on every future attempt, including ones long after this
  // specific `token` string has expired. Found live, 2026-08-22: a
  // many-hours-old tab's socket, forced to reconnect after a backend
  // restart, kept replaying its original now-expired token forever, and
  // since the callback form always reads the *current* `authToken` instead,
  // a real refresh (updateAuthToken below) now actually reaches the next
  // attempt.
  socket = io(SOCKET_URL, { auth: (cb) => cb({ token: authToken }) })
  attachListeners(socket)
  return socket
}

/**
 * Pushes a freshly-refreshed Supabase access token into the socket layer —
 * called from AuthContext.jsx's own onAuthStateChange, which already fires
 * on Supabase's own background token refresh (well before the old token
 * actually expires). Only updates the value connectSocket's own auth
 * callback reads on its next (re)connect attempt; does not itself force a
 * reconnect — an already-connected socket keeps its already-established
 * connection, same as before.
 * @param {string} token
 */
export function updateAuthToken(token) {
  authToken = token
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
  authToken = null
  // Reset alongside the store's own eventCardLog (resetAfterGame), so a
  // second match in the same tab starts its history from zero rather than
  // silently ignoring its first draws as "already seen".
  lastLoggedDrawSeq = 0
  useGameStore.getState().setConnectionStatus('disconnected')
}

/** Emits C2S_JOIN_ROOM — the lobby-phase attach, per WEBSOCKET_API.md §4. */
export function joinRoom(roomId) {
  socket?.emit('C2S_JOIN_ROOM', { roomId })
}

/**
 * Emits C2S_GAME_ACTION. Out of this task's UI scope (no board/dice yet)
 * but included here, not in a later file, since it belongs with the rest
 * of this socket contract's outbound events, not bolted on separately once
 * gameplay UI exists.
 */
export function sendGameAction(actionType, payload) {
  const roomId = useGameStore.getState().roomState?.roomId
  socket?.emit('C2S_GAME_ACTION', {
    roomId,
    actionType,
    payload,
    clientActionId: crypto.randomUUID(),
  })
}
