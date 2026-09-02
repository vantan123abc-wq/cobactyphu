// REST client for the Rooms API — backend/docs/API_CONTRACT.md's real,
// already-implemented contract: base path `/api/v1`, `Authorization:
// Bearer <supabase_jwt>` on every route (the same JWT AuthContext already
// holds as `session.access_token` — this project's auth is Supabase's own,
// P03; there is no separate "get a join code to authenticate" step, the
// task brief's own phrasing for this was imprecise), camelCase JSON, and
// the standard `{ error: { code, message } }` envelope on failure.
//
// create/join are two distinct endpoints (POST /rooms vs. POST
// /rooms/:code/join) — not the one generic "Join/Create Room" action the
// task brief sketched, since the real API has no such single action.

const API_BASE = import.meta.env.VITE_BACKEND_URL

async function request(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`)
    // Leave/kick UI (2026-08-21) needs to tell "I'm no longer a member"
    // (404 NOT_FOUND) apart from every other failure reason, which the
    // message string alone doesn't reliably support — attaching the real
    // errorCode is additive, doesn't change what any existing err.message
    // consumer already does.
    err.code = data?.error?.code ?? null
    throw err
  }
  return data
}

/**
 * GET /api/v1/auth/me (P03-T03, wired 2026-08-21) — `{ id, displayName,
 * avatarUrl, activeRoomId, activeGameId }`. The latter two are what
 * App.jsx's own session-resume effect uses on boot to decide whether to
 * reconnect the socket into a room/match the user was already in, rather
 * than always landing back on the empty create/join screen after a reload.
 */
export function getMe(token) {
  return request('/auth/me', { token })
}

/** POST /api/v1/rooms — creates a room, sender becomes host. */
export async function createRoom(token, ruleset) {
  return request('/rooms', { method: 'POST', token, body: { ruleset } })
}

/** POST /api/v1/rooms/:code/join — joins by the shareable join code, not the internal room id. */
export function joinRoomByCode(token, joinCode) {
  return request(`/rooms/${joinCode}/join`, { method: 'POST', token })
}

/** GET /api/v1/rooms/:id */
export function getRoom(token, roomId) {
  return request(`/rooms/${roomId}`, { token })
}

/** PATCH /api/v1/rooms/:id/ready — { ready: boolean }, an explicit target value, not a toggle. */
export function setReady(token, roomId, ready) {
  return request(`/rooms/${roomId}/ready`, { method: 'PATCH', token, body: { ready } })
}

/**
 * PATCH /api/v1/rooms/:id/zodiac — 12 con giáp lobby picker (2026-08-22).
 * `zodiac` is one of `features/board/zodiac.js`'s ZODIAC keys, or `null` to
 * explicitly clear a pick (falls back to a random one at game start,
 * backend's own `initializeGameState`).
 */
export function setZodiac(token, roomId, zodiac) {
  return request(`/rooms/${roomId}/zodiac`, { method: 'PATCH', token, body: { zodiac } })
}

/** POST /api/v1/rooms/:id/start — host-only. */
export function startGame(token, roomId) {
  return request(`/rooms/${roomId}/start`, { method: 'POST', token })
}

/**
 * GET /api/v1/boards/:boardId — static tile layout (P11-T03/T04). Requires
 * auth like every other endpoint (API_CONTRACT.md's "every endpoint except
 * /api/v1/health" rule — board data isn't a documented exception). Can
 * reject with 503 BOARD_DATA_UNAVAILABLE if the backend's own Supabase
 * connection isn't configured or board_tiles isn't seeded yet — a real,
 * current possibility in this project (see PROJECT_STATUS.md), not a
 * theoretical error path.
 */
export function getBoardConfig(token, boardId) {
  return request(`/boards/${boardId}`, { token })
}

/**
 * GET /api/v1/event-cards — the real domain/eventDictionary.js content
 * (2026-08-21), replacing EventCardModal.jsx's own former hand-maintained
 * mirror (features/game/eventCardDictionary.js, deleted alongside this —
 * see that component's own header for the drift risk this closes). Static
 * reference content, same auth requirement as boards.
 */
export function getEventCards(token) {
  return request('/event-cards', { token })
}

/**
 * POST /api/v1/rooms/:id/leave — GAME_DESIGN_SPEC.md §4, wired backend-side
 * 2026-08-21 ("Backlog batch" item 6). Pre-game only (JOINABLE_STATUSES on
 * the server) — leaving mid-match is a disconnect, a different mechanism
 * entirely, not this endpoint. Host leaving transfers the role server-side;
 * no client input needed for that.
 */
export function leaveRoom(token, roomId) {
  return request(`/rooms/${roomId}/leave`, { method: 'POST', token })
}

/**
 * POST /api/v1/rooms/:id/kick — host-only, same backend slice as leaveRoom.
 * `targetPlayerId` is `profiles.id` (the same id space every other
 * player-identifying field in this app uses), never a display name.
 */
export function kickPlayer(token, roomId, targetPlayerId) {
  return request(`/rooms/${roomId}/kick`, { method: 'POST', token, body: { targetPlayerId } })
}
