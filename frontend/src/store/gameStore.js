import { create } from 'zustand'

// Global client state (P11-T01) — the one place `network/socketClient.js`
// writes to and any component reads from. Field names/shapes mirror
// backend/docs/WEBSOCKET_API.md exactly (the approved wire contract, built
// and already live in this same codebase — not re-derived or guessed):
// - roomState matches S2C_ROOM_JOINED's payload (`roomId`, `playerId`,
//   `members`, `roomStatus`) verbatim.
// - currentGameState/stateVersion/transactions/deadlineAt come from
//   S2C_STATE_UPDATE (§2) — `deadlineAt` is P10-T04's addition (the
//   client-side countdown anchor; the client never runs an authoritative
//   timer itself, GAME_STATE_MACHINE.md §7).
// - offlinePlayerIds is this store's own derived view of
//   S2C_PLAYER_DISCONNECTED/S2C_PLAYER_RECONNECTED (§5) — the backend
//   itself only ever sends one playerId at a time per event, never a full
//   list, so the list is accumulated here.
// - staticBoard (P11-T03/T04) is deliberately separate from
//   currentGameState, never merged into it: it's the *static* tile layout
//   (GET /api/v1/boards/:boardId — name/price/type/groupId, one row per
//   board position, never changes during a game) versus currentGameState's
//   *dynamic* per-game state (ownership, positions, balances). This store
//   holds no fetch logic itself — network/socketClient.js is the one place
//   that decides *when* to fetch (on seeing gameState.boardId) and calls
//   setStaticBoard with the result, same "store just holds state, the
//   client module orchestrates" split every other field here already uses.
export const useGameStore = create((set) => ({
  // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  connectionStatus: 'disconnected',
  roomState: null,
  roomUpdatedAt: null, // bumped whenever S2C_ROOM_UPDATED arrives (WEBSOCKET_API.md §6, wired 2026-08-21) — Lobby.jsx watches this to trigger an immediate roster re-fetch, on top of its own existing 3s poll, not instead of it
  roomExitNotice: null, // set by Lobby.jsx when its own GET /rooms/:id re-fetch 404s (NOT_FOUND) while roomState still points at that room — the honest "you're no longer a member" signal for a kicked player, who otherwise only ever finds out passively (leave/kick UI slice, 2026-08-21). LobbyDiagnostic.jsx shows and dismisses it, since Lobby.jsx itself unmounts the instant roomState clears
  currentGameState: null,
  stateVersion: null,
  transactions: [],
  deadlineAt: null,
  offlinePlayerIds: [],
  lastError: null, // most recent S2C_ACTION_REJECTED payload — diagnostic visibility only
  staticBoard: null, // { boardId, tiles[] } from GET /api/v1/boards/:boardId, or null until fetched
  // Event-card dictionary — { [cardId]: card }, from GET /api/v1/event-cards.
  // Match-static (a plain JS constant server-side), so it is fetched once per
  // session like staticBoard, in socketClient.js, not per-component. Was three
  // separate local fetches before 2026-09-03 (EventCardModal, CardInventory,
  // and GameControls would have been a fourth) — each an independent failure
  // point, and any one failing silently degraded that panel; consolidating
  // them also lets GameControls' jail decision see which inventory card can
  // free the player without a fetch of its own.
  eventCards: {},
  selectedPropertyId: null, // properties.id (game-scoped ownership row) of the board tile the local player last clicked — P11-T09, PropertyManager.jsx's data source
  tradeDraftTargetId: null, // PlayerGameState.id of the opponent a fresh trade proposal is being drafted against — P11-T10, TradeWindow.jsx. Only meaningful while no real Trade in gameState.pendingTrades involves the local player yet; TradeWindow.jsx clears this itself once PROPOSE_TRADE's real trade shows up server-side

  // Board camera (2026-08-22) — zoom/rotation the player controls via
  // BoardCamera.jsx (features/board/), read by GameBoard.jsx to compute the
  // real transform + its own margin reconciliation (see that file's own
  // comments for why margin has to track this).
  boardZoom: 1,
  boardSpin: 0, // Z-axis rotation
  // X-axis tilt (pitch), 55deg — the project's long-standing value, briefly
  // lowered to 40 on 2026-08-23 and then restored the same day.
  //
  // Worth recording why, because the two are linked: rotateX is a pure
  // VERTICAL SQUASH under this board's orthographic projection (cos(55deg)
  // = 0.574). While the board was being snapped SQUARE-ON, that squash was
  // the whole picture — a plain rectangle flattened to 57% height, which is
  // what got reported as "méo mó" and prompted the drop to 40deg. Once
  // rotation was snapped back to the DIAMOND family (cameraControls.js),
  // the same 55deg reads as depth rather than as flattening, because the
  // 45deg in-plane rotation is what turns a squash into an isometric view.
  //
  // 55deg is also what actually fits: measured in diamond mode on a
  // 1482x816 container, it fills 94% x 97% of the space with the largest
  // tile text of any angle tried (13.8px vs 10.4px at 40deg), and 58deg is
  // the first angle that overflows. Shallower angles here cost real size and
  // buy nothing, since the diamond already supplies the depth cue.
  boardTilt: 55,
  // Rotation lock (2026-08-22)
  boardSpinLocked: false,
  setBoardZoom: (boardZoom) => set({ boardZoom }),
  setBoardSpin: (boardSpin) => set((state) => (state.boardSpinLocked ? state : { boardSpin })),
  setBoardTilt: (boardTilt) => set((state) => (state.boardSpinLocked ? state : { boardTilt })),
  setBoardSpinLocked: (boardSpinLocked) => set({ boardSpinLocked }),

  // Ledger feed (GameView redesign, 2026-08-22) — S2C_STATE_UPDATE's own
  // `transactions` field is otherwise transient (setGameState below
  // overwrites it every broadcast, by design — it's meant as a one-shot
  // "what just changed, to animate" signal, GAME_STATE_MACHINE's own
  // documented shape). Nothing accumulated it anywhere before this; the
  // Ledger needs a running history, not just the latest batch. Built by
  // network/socketClient.js (which has the context — the just-arrived
  // gameState/staticBoard — needed to resolve names/tiles once, not
  // deferred to render time), appended here via appendTransactionLog.
  transactionLog: [],

  // Drawn event cards, newest first (2026-08-25, user request: "đôi khi vào
  // ô cơ hội và khí vận quên đọc đã ấn đóng mất rồi, thì làm sao để đọc
  // lại"). Until this existed there was genuinely no way back to a card once
  // EventCardModal closed — it shows a draw exactly once, and the Ledger
  // records only the money that moved ("Cơ Hội / Khí Vận, -$25"), never the
  // card's own text.
  //
  // Accumulated here rather than derived on demand because GameState carries
  // only the LAST draw (lastDrawnEventCardId, deliberately overwritten each
  // time — see its own JSDoc), so anything older exists nowhere else once
  // the next card is drawn. Capped for the same reason transactionLog is:
  // this project's own playtests run 200+ actions.
  eventCardLog: [],

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

  setRoomState: (roomState) => set({ roomState }),

  setRoomExitNotice: (roomExitNotice) => set({ roomExitNotice }),

  // S2C_ROOM_UPDATED (WEBSOCKET_API.md §6) — merges the pushed roomStatus
  // into whatever roomState already exists (never replaces playerId/members,
  // which that event doesn't carry) and bumps roomUpdatedAt so Lobby.jsx's
  // own effect fires. A no-op if roomState doesn't exist yet — the push
  // implies this client already joined the room at some point, but a race
  // (e.g. this socket reconnecting) could in principle deliver it first.
  applyRoomUpdated: ({ roomStatus }) =>
    set((state) => ({
      roomState: state.roomState ? { ...state.roomState, roomStatus } : state.roomState,
      roomUpdatedAt: Date.now(),
    })),

  // lastError is cleared here as of 2026-08-23 (finding #34). It used to be
  // set by S2C_ACTION_REJECTED and then never cleared for the rest of the
  // match — nothing but resetAfterGame() below ever touched it — while six
  // components render it unconditionally. One mistimed click (a single
  // NOT_YOUR_TURN, say) therefore pinned a red error line on screen for
  // hours, through every subsequent successful action, and because the field
  // is store-wide it also leaked across contexts: a stale rejected bid
  // resurfaced inside PropertyManager, TradeWindow or LiquidationPanel the
  // next time one of those opened.
  //
  // A successful state update is precisely the point at which any earlier
  // rejection stops describing reality, so clearing it here — rather than
  // adding a manual dismiss to each of the six call sites — is both the
  // smaller change and the more honest signal. Deliberately NOT also
  // cleared in sendGameAction(): every one of those components resets its
  // own click-guard with `useEffect(..., [gameState?.stateVersion,
  // lastError])`, so a synchronous clear at send time would fire that
  // effect and switch `busy` back off in the same tick it was switched on,
  // defeating the double-click guard entirely.
  setGameState: ({ gameState, stateVersion, transactions, deadlineAt }) =>
    set({
      currentGameState: gameState,
      stateVersion,
      transactions: transactions ?? [],
      deadlineAt: deadlineAt ?? null,
      lastError: null,
    }),

  markPlayerOffline: (playerId) =>
    set((state) => ({
      offlinePlayerIds: state.offlinePlayerIds.includes(playerId) ? state.offlinePlayerIds : [...state.offlinePlayerIds, playerId],
    })),

  markPlayerOnline: (playerId) =>
    set((state) => ({
      offlinePlayerIds: state.offlinePlayerIds.filter((id) => id !== playerId),
    })),

  setLastError: (lastError) => set({ lastError }),

  setStaticBoard: (staticBoard) => set({ staticBoard }),

  setEventCards: (eventCards) => set({ eventCards }),

  // Prepends (newest-first, matching the reference feed's own ordering) and
  // caps at 50 — a whole-match log with no cap would grow unbounded over a
  // long game (this project's own real playtests have run 200+ actions).
  // `entries` arrives in chronological order (oldest of this one batch
  // first) since that's the order socketClient.js's own transactions[]
  // array is in; reversed here so the *last* thing that happened this batch
  // ends up closest to "now" in the feed, not the first.
  appendTransactionLog: (entries) =>
    set((state) => ({ transactionLog: [...entries].reverse().concat(state.transactionLog).slice(0, 50) })),

  // Keyed on the draw's own seq so a duplicate broadcast (a reconnect resync
  // re-delivers the current gameState verbatim) can never log the same card
  // twice — lastDrawnEventCardId alone could not tell a genuine redraw of
  // the same card from a replay of the same one.
  appendEventCard: (entry) =>
    set((state) =>
      state.eventCardLog.some((e) => e.seq === entry.seq)
        ? state
        : { eventCardLog: [entry, ...state.eventCardLog].slice(0, 30) }
    ),

  // Toggles: clicking the already-selected tile again closes the panel,
  // same convention BoardTile.jsx's onClick uses to decide what to pass here.
  selectProperty: (propertyId) =>
    set((state) => ({ selectedPropertyId: state.selectedPropertyId === propertyId ? null : propertyId })),

  // Plain setter, not a toggle — GameControls.jsx's per-opponent "Trade"
  // buttons only ever appear while there's no real trade involving the
  // local player yet (TradeWindow.jsx's own gating), so there's no
  // "re-click to close" case to handle the way selectProperty's toggle
  // does; TradeWindow.jsx's own close/cancel button calls this with null.
  setTradeDraftTargetId: (tradeDraftTargetId) => set({ tradeDraftTargetId }),

  // Called by GameOverScreen's "Return to lobby" button after a finished match.
  // Clears all in-game state so App.jsx's conditional render drops back to
  // LobbyDiagnostic (roomState === null → no room → lobby screen). The socket
  // is disconnected separately by the caller (disconnectSocket()) so a stale
  // S2C_STATE_UPDATE from a lingering connection can't re-populate these.
  // staticBoard is intentionally NOT cleared — if the player creates another
  // game of the same board size immediately, the already-loaded tiles are
  // still valid and re-fetching them would just waste a round trip.
  resetAfterGame: () =>
    set({
      roomState: null,
      currentGameState: null,
      stateVersion: null,
      transactions: [],
      deadlineAt: null,
      offlinePlayerIds: [],
      lastError: null,
      selectedPropertyId: null,
      tradeDraftTargetId: null,
      transactionLog: [],
      eventCardLog: [],
      boardZoom: 1,
      boardSpin: 0,
    }),
}))
