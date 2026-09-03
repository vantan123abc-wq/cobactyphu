// Socket.IO server — WEBSOCKET_API.md's Conventions + C2S_JOIN_ROOM/
// S2C_ROOM_JOINED/C2S_GAME_ACTION/S2C_STATE_UPDATE/S2C_ACTION_REJECTED.
// `socket.io` is a new dependency (previously "Express is the only
// dependency"), added because this is the phase that actually needs it,
// not an unplanned departure from that principle.
//
// Split into small exported pieces, not one monolithic function, so each
// is unit-testable against plain mock socket/io objects — the same
// "extract the testable logic, keep the I/O wiring thin" split this
// backend already uses everywhere else (P05/P06 engine functions vs.
// turnMachine.js; createAuthMiddleware() itself, reused directly below).
//
// handleGameAction is what stateMachine/idempotency.js's applyWithIdempotency
// was built for (P07-T03's own docs: "a higher-order wrapper a future
// Socket.IO handler composes around transitionTurn") — this is that
// caller, finally wired in.
//
// P10-T01 closes the board-tile gap noted above, when a real Supabase
// project is configured: initSocketServer()/handleGameAction() now accept
// boardTilesByBoard, `{ small: Tile[], large: Tile[] }` — keyed by board
// size, not a single flat array, since a running server serves games on
// both boards concurrently (ADAPTIVE_BOARD_DESIGN.md's fully-approved
// small/large split; initializeGameState() already selects per-game by
// player count). server.js populates this at startup via
// infrastructure/repositories/boardRepository.js's fetchBoardTiles(); it
// stays `{}` (falls back to []) when Supabase isn't configured — see
// server.js's own comment for why that's a graceful degradation, not a
// startup failure. Actions that never touch tile lookups (END_TURN;
// FLASH_AUCTION_ACTIVE's PLACE_BID/FOLD_AUCTION/AUCTION_TIMEOUT;
// AWAITING_EVENT_CHOICE's MAKE_EVENT_CHOICE; TURN_START/JAIL_DECISION's
// non-movement paths) were already correct either way; ROLL_DICE's
// movement/landing resolution and AWAITING_PURCHASE's BUY_PROPERTY are
// what this closes the gap for.
//
// P10-T02: `record.gameState`/`record.idempotencyCache` no longer exist —
// roomRepository.js's record is lobby-only now (rooms/room_players via
// Supabase). GameState lives in gameRepository.js's in-memory hot store,
// keyed by roomId, durably snapshotted to Supabase only at the three
// approved trigger points (see gameRepository.js's header) — not fetched
// from/saved to Supabase on every single action, which the schema's own
// `game_state_snapshots.reason` CHECK constraint doesn't allow anyway
// (most actions aren't a turn end/bankruptcy/game over). The idempotency
// cache stays exactly where it always was, in-process only — §6 of
// GAME_STATE_MACHINE.md describes it as a short-lived (~60s) cache, never
// a durable log, and no Supabase column exists for it — `idempotencyCaches`
// below replaces `record.idempotencyCache` as its home, keyed by roomId.
//
// P10-T03: disconnect/reconnect handling, per GAME_DESIGN_SPEC.md §23/§24.
// §23 splits reconnect by phase — lobby rejoin is the existing REST
// `join_room` call (unaffected, no socket component), an in-game reconnect
// is a *separate* socket mechanism ("`game:sync`... not `join_room`" in
// the superseded contract's terms) — so `C2S_RECONNECT` below is new, not
// a C2S_JOIN_ROOM extension; this also closes WEBSOCKET_API.md's own
// flagged "Open items" #1/#2. Connection status (online/offline) is
// tracked in `offlinePlayersByRoom`, purely in-process like
// `idempotencyCaches` — DATABASE_DESIGN.md's ephemeral-state note
// explicitly excludes "connection status (connected/AFK flags)" from
// `game_state_snapshots.state`, and `room_players` has no column for it
// either, so this has no durable counterpart by design.
//
// P10-T04: turn timeouts. `stateMachine/timers.js` already built and
// tested `TimerManager`/`buildDefaultAction`/`TIMER_DURATIONS_SECONDS`
// (P07) against exactly this need — GAME_STATE_MACHINE.md §4's own
// per-phase "Default after timeout" column — but nothing ever called it
// from a live socket. This file is that wiring, not a second timer system:
// `turnTimers` (below) is scheduled/cancelled after every broadcast based
// on the resulting `gameState.phase`, and a fired timeout synthesizes the
// documented default action and runs it through the *same*
// applyWithIdempotency->persist->broadcast pipeline a real
// `C2S_GAME_ACTION` uses (§7: "no separate timeout code path") — see
// `persistAndBroadcast`/`handleTurnTimeout` below, shared with
// `handleGameAction`.
//
// This one phase timer already covers *both* halves of "AFK handling" the
// task brief described as separate concerns: GAME_STATE_MACHINE.md §5 is
// explicit that "the current state's own timeout always fires on schedule
// regardless of connection status" — an idling online player and a
// disconnected one hit the exact same deadline and the exact same default
// action. Two things this deliberately does NOT build, both still
// `[PROPOSED]` in the approved docs and matching P10-T03's own scope note:
// `RECONNECT_GRACE_SECONDS`'s separate 90s disconnect timer (its practical
// effect for forcing an action is already subsumed by the — always
// shorter — phase timer above) and `AFK_THRESHOLD_MISSED_TURNS`' streak
// tracking / soft-AFK auto-skip state (GAME_DESIGN_SPEC.md §25). Also not
// built: the brief's own sketched "PAY_RENT" / "DECLARE_BANKRUPTCY" timeout
// fallback — GAME_STATE_MACHINE.md §4 documents `PAYING_RENT`/
// `BANKRUPTCY_CHECK` as instant, system-only phases with no player action
// and no timeout at all (rent/tax/bankruptcy resolve synchronously as part
// of landing, never as a separate waiting state), so there is nothing for
// a timeout to default on there — inventing one would mean adding a new
// waiting phase/action type to turnMachine.js, which both the approved
// design and this task's own "do not modify the pure rules in
// turnMachine.js" constraint rule out.

import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { verifyJwt, verifyJwtAsymmetric } from '../../auth/verifyJwt.js';
import { transitionTurn, getCurrentPlayer } from '../../stateMachine/turnMachine.js';
import { applyTradeAction, TRADE_ACTION_TYPES } from '../../stateMachine/tradeMachine.js';
import { applyWithIdempotency, createIdempotencyCache } from '../../stateMachine/idempotency.js';
import { TimerManager, buildDefaultAction, TIMER_DURATIONS_SECONDS, FLASH_AUCTION_BID_EXTENSION_SECONDS } from '../../stateMachine/timers.js';
import * as gameRepository from '../../infrastructure/repositories/gameRepository.js';
import { rollDice } from '../../engine/dice.js';
import { EVENT_CARDS } from '../../domain/eventDictionary.js';

// SECURITY_DESIGN.md "Known gaps" #5 — the one exemption to "every
// C2S_GAME_ACTION must come from the current-turn player", checked in
// handleGameAction below. FLASH_AUCTION_ACTIVE is explicitly "all players
// simultaneously... not turn-ordered" (BOARD_SPECIFICATION.md; turnMachine.js's
// own file header repeats this same point in three separate places) — any
// eligible bidder may PLACE_BID/FOLD_AUCTION regardless of whose turn it
// nominally is. AUCTION_TIMEOUT is grouped here too since it belongs to the
// same non-turn-scoped phase (a real client should never send it at all —
// WEBSOCKET_API.md's own note — but that's a separate, already-flagged,
// deliberately out-of-scope gap, not something this list is meant to police).
// Deliberately an exempt-list, not an allow-list: every other action type —
// including any future one — defaults to protected without needing to be
// remembered here, the same "don't require every new mechanic to update a
// checklist" reasoning Phase 14's HOSTILE_BUYOUT already benefited from
// (needed zero changes in this file to be correctly turn-gated).
// GAMBLE_RENT (Rent Risk Choice, REVISED 2026-08-25 — RENT_RISK_CHOICE
// above it in this list's own history) joins for the same reason PLACE_BID/
// FOLD_AUCTION do: the acting player is the property OWNER, not necessarily
// getCurrentPlayer(gameState) — handleGambleRent (turnMachine.js) does its
// own NOT_OWNER check against the pending offer's real ownerId, same
// division of labor turn-ownership already has elsewhere (this guard only
// ever asks "is this action type turn-scoped at all", never "is this
// specific sender allowed" — that's each handler's own job once dispatched).
// Doubly relevant here now: turnMachine.js dispatches GAMBLE_RENT BEFORE
// its own VALID_ACTIONS_BY_PHASE gate too (same precedent FORFEIT_MATCH
// established), so this is legal in literally any phase, not just whichever
// one happens to be current — turn-independence and phase-independence are
// two separate, both-true facts about this action.
// FORFEIT_MATCH (2026-08-23) joins this list for the most literal reason
// yet: a player quitting can never be gated on whose turn it currently is —
// that would make forfeiting impossible on 2/3 of all turns. turnMachine.js's
// resolveForfeit does its own real-player/not-already-eliminated checks —
// this guard, same as always, only ever asks "is this action type turn-
// scoped at all."
// USE_INVENTORY_CARD added 2026-09-01: it was already dispatched ahead of
// the VALID_ACTIONS_BY_PHASE gate in transitionTurn (i.e. phase-independent)
// and its own handler's docstring promised out-of-turn play, but it was
// never listed here — so the socket layer's NOT_YOUR_TURN guard refused it
// for anyone who wasn't the current player, and the feature only ever worked
// on your own turn. Phase-independence and turn-independence are two
// separate mechanisms in this codebase; only one of them had been wired.
// Safe to open now that handleUseInventoryCard rejects a bankrupt actor
// itself (turnMachine.js) — the turn gate had been the only thing
// incidentally keeping eliminated players out.
const TURN_INDEPENDENT_ACTION_TYPES = ['PLACE_BID', 'FOLD_AUCTION', 'AUCTION_TIMEOUT', 'GAMBLE_RENT', 'FORFEIT_MATCH', 'USE_INVENTORY_CARD'];

// roomId -> IdempotencyCache. Ephemeral, in-process only — see file header.
const idempotencyCaches = new Map();

// One TimerManager per process, real setTimeout/clearTimeout/Date.now by
// default (TimerManager's own constructor defaults). `let`, not `const` —
// _resetForTests() below reconstructs it so tests using `node:test`'s
// `mock.timers` (enabled *before* the reset) get a fresh instance that
// captures the mocked globals, rather than one bound to whatever timer
// functions were live at module-import time.
let turnTimers = new TimerManager();

/** Test-only observability into the current turn timer, mirroring isOffline's role for presence. @returns {string|null} */
export function activeTurnTimerDeadline(roomId) {
  return turnTimers.deadlineFor(roomId);
}

// roomId -> Set<playerId> currently marked offline (P10-T03). Absence from
// this map means online — only offline players are tracked, so a socket
// that never disconnects costs nothing here. See file header for why this
// is in-process only, no Supabase counterpart.
const offlinePlayersByRoom = new Map();

function markOffline(roomId, playerId) {
  if (!offlinePlayersByRoom.has(roomId)) {
    offlinePlayersByRoom.set(roomId, new Set());
  }
  offlinePlayersByRoom.get(roomId).add(playerId);
}

function markOnline(roomId, playerId) {
  offlinePlayersByRoom.get(roomId)?.delete(playerId);
}

/** @returns {boolean} */
export function isOffline(roomId, playerId) {
  return offlinePlayersByRoom.get(roomId)?.has(playerId) ?? false;
}

/**
 * Test-only reset — same reasoning as roomRepository.js's/gameRepository.js's
 * own _resetForTests. Reconstructing `turnTimers` (rather than just
 * clearing its internal state) is deliberate: a test that calls
 * `mock.timers.enable()` before this reset gets a TimerManager whose
 * default `schedule = setTimeout`/`cancel = clearTimeout` params resolve
 * to the *currently* mocked globals, not whatever was live at module
 * import time.
 */
export function _resetForTests() {
  idempotencyCaches.clear();
  offlinePlayersByRoom.clear();
  turnTimers = new TimerManager();
}

// Same bare-string-or-config-object polymorphism as
// auth/authMiddleware.js's normalizeAuthConfig (P11-T03) — duplicated
// rather than imported cross-module for a two-line pure function, not
// worth a shared-utils module for this alone.
function normalizeAuthConfig(secretOrConfig) {
  return typeof secretOrConfig === 'string' ? { secret: secretOrConfig } : (secretOrConfig ?? {});
}

/**
 * Socket.IO connection middleware — WEBSOCKET_API.md: "JWT in the
 * handshake auth payload, verified once at connect." Mirrors
 * auth/authMiddleware.js's createAuthMiddleware() as closely as Socket.IO's
 * (socket, next) middleware signature allows: same verifyJwt()/
 * verifyJwtAsymmetric() calls, same "config is an explicit parameter,
 * never read from process.env internally" boundary, same { id } shape
 * attached on success (socket.user, not req.user) — one JWT verification
 * mechanism, reused, not reimplemented for sockets.
 *
 * On any failure, calls next(new Error('Authentication error')) exactly as
 * specified — Socket.IO's own convention for rejecting a handshake, no
 * further detail leaked into the error message (matching authMiddleware.js
 * not echoing the raw verify failure reason to the caller).
 * @param {string | { secret?: string, getKey?: (kid: string) => Promise<object|null> }} secretOrConfig — a bare HS256 secret string, or a config object naming exactly one mode (P11-T03: ES256/JWKS via `{ getKey }`)
 * @returns {(socket: import('socket.io').Socket, next: (err?: Error) => void) => void}
 */
export function createSocketAuthMiddleware(secretOrConfig) {
  const config = normalizeAuthConfig(secretOrConfig);
  if (!config.secret && !config.getKey) {
    throw new Error('createSocketAuthMiddleware requires a non-empty JWT secret, or a config object with { secret } or { getKey }');
  }

  return async function socketAuthMiddleware(socket, next) {
    const token = socket.handshake?.auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      return next(new Error('Authentication error'));
    }

    const result = config.secret ? verifyJwt(token, config.secret) : await verifyJwtAsymmetric(token, config.getKey);
    if (!result.valid) {
      return next(new Error('Authentication error'));
    }

    socket.user = { id: result.payload.sub };
    next();
  };
}

/**
 * Shared "attach this authenticated socket to its room's Socket.IO
 * broadcast group" step — both `C2S_JOIN_ROOM` (lobby-phase attach/rejoin)
 * and `C2S_RECONNECT` (P10-T03, in-game reconnect) start here, per
 * GAME_DESIGN_SPEC.md §23's phase split. Room-not-found and
 * sender-not-a-member both reject with the same NOT_A_PARTICIPANT code —
 * the same "don't let a failure response reveal whether a room exists"
 * privacy posture API_CONTRACT.md's REST layer already applies (merged
 * 404), carried over to the socket layer.
 *
 * Records `socket.roomId` on success — the `disconnect` handler's only way
 * to know which room's presence to update and which room to broadcast to,
 * since a raw Socket.IO `disconnect` event carries no payload of its own.
 * Does not itself emit a success event — callers decide that (a fresh
 * join emits `S2C_ROOM_JOINED` immediately; a reconnect defers it until
 * its own extra checks pass, see handleReconnect).
 * @param {import('socket.io').Socket} socket
 * @param {{ getRoomById: (supabase: object, roomId: string) => Promise<object|null> }} roomRepository
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roomId
 * @returns {Promise<object|null>} the room record on success; null on failure (S2C_ACTION_REJECTED already emitted)
 */
async function joinSocketToRoom(socket, roomRepository, supabase, roomId) {
  const record = roomId ? await roomRepository.getRoomById(supabase, roomId) : null;
  const isParticipant = record?.players?.some((p) => p.playerId === socket.user.id) ?? false;

  if (!record || !isParticipant) {
    socket.emit('S2C_ACTION_REJECTED', {
      clientActionId: null, // neither C2S_JOIN_ROOM nor C2S_RECONNECT carries one — WEBSOCKET_API.md
      errorCode: 'NOT_A_PARTICIPANT',
      message: `Room '${roomId}' not found, or you are not a member of it`,
    });
    return null;
  }

  socket.join(record.id);
  socket.roomId = record.id;
  return record;
}

function emitRoomJoined(socket, record) {
  socket.emit('S2C_ROOM_JOINED', {
    roomId: record.id,
    playerId: socket.user.id,
    members: record.players.map((p) => p.playerId),
    roomStatus: record.status,
  });
}

/**
 * Registers the C2S_JOIN_ROOM listener for one connected, authenticated
 * socket. Payload is `{ roomId }` only — no `playerId` field: the acting
 * player is always socket.user.id, resolved from the already-verified JWT,
 * never a client-supplied claim (WEBSOCKET_API.md's own stated
 * playerId-spoofing concern, applied here by simply never accepting the
 * field to begin with, which is stricter than accepting-then-cross-
 * checking it).
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ getRoomById: (supabase: object, roomId: string) => Promise<object|null> }} roomRepository
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export function handleJoinRoom(io, socket, roomRepository, supabase) {
  socket.on('C2S_JOIN_ROOM', async (payload) => {
    const record = await joinSocketToRoom(socket, roomRepository, supabase, payload?.roomId);
    if (record) {
      emitRoomJoined(socket, record);
    }
  });
}

/**
 * Registers the Socket.IO transport-level `disconnect` listener (P10-T03,
 * GAME_DESIGN_SPEC.md §24: "disconnected is a flag, not a removal"). Not a
 * C2S_/S2C_ application envelope — `disconnect` is Socket.IO's own
 * built-in lifecycle event, fired by the transport itself, never sent by a
 * client.
 *
 * A no-op if this socket never successfully joined a room (no
 * `socket.roomId` — e.g. it disconnected before/during auth, or
 * C2S_JOIN_ROOM/C2S_RECONNECT never succeeded). Deliberately does *not*
 * start any grace-period/AFK timer or touch turn state — §24's
 * `RECONNECT_GRACE_SECONDS` auto-end-turn behavior and §25's AFK rules are
 * both still `[PROPOSED]` and explicitly out of this task's scope (no
 * background timers yet); a disconnected player simply can't act until
 * they reconnect, same as GAME_STATE_MACHINE.md §5 already describes for a
 * disconnect mid-auction.
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function handleDisconnect(io, socket) {
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !socket.user) {
      return;
    }
    markOffline(roomId, socket.user.id);
    io.to(roomId).emit('S2C_PLAYER_DISCONNECTED', { roomId, playerId: socket.user.id });
  });
}

/**
 * Registers the C2S_RECONNECT listener (P10-T03) — the in-game reconnect
 * path GAME_DESIGN_SPEC.md §23 documents as distinct from C2S_JOIN_ROOM
 * ("reconnecting to an in-progress game is `game:sync`... not
 * `join_room`"). C2S_JOIN_ROOM stays the lobby-phase attach/rejoin
 * mechanism, unchanged; this is the mid-game equivalent.
 *
 * Reuses joinSocketToRoom for the room-membership half, then layers on:
 * the `record.status === 'in_progress'` check (a lobby rejoin should use
 * REST, not this), the GameState resync
 * (gameRepository.resolveLiveGameState — same hot/cold path
 * handleGameAction uses, extracted there for exactly this reuse), and the
 * presence flip + S2C_PLAYER_RECONNECTED broadcast to everyone else.
 * `S2C_ROOM_JOINED` is only emitted once every check passes, not
 * immediately on room membership — a reconnect attempt against a room
 * that isn't actually resyncable shouldn't look like a success followed by
 * an unrelated rejection.
 *
 * Emits the *existing* S2C_STATE_UPDATE shape to just this socket
 * (`socket.emit`, not a room broadcast) rather than inventing a new
 * "reconnect payload" — GAME_STATE_MACHINE.md §9's own words for this are
 * "a full `game:state_update` is sent to just that socket".
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ getRoomById: (supabase: object, roomId: string) => Promise<object|null> }} roomRepository
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export function handleReconnect(io, socket, roomRepository, supabase) {
  socket.on('C2S_RECONNECT', async (payload) => {
    const roomId = payload?.roomId;
    const record = await joinSocketToRoom(socket, roomRepository, supabase, roomId);
    if (!record) {
      return; // joinSocketToRoom already emitted S2C_ACTION_REJECTED
    }

    if (record.status !== 'in_progress') {
      socket.emit('S2C_ACTION_REJECTED', {
        clientActionId: null,
        errorCode: 'ROOM_NOT_IN_PROGRESS',
        message: `Room '${record.id}' is not in progress (status: ${record.status}) — use the REST join endpoint for a lobby rejoin`,
      });
      return;
    }

    const gameState = await gameRepository.resolveLiveGameState(roomId, supabase);
    if (!gameState) {
      socket.emit('S2C_ACTION_REJECTED', {
        clientActionId: null,
        errorCode: 'GAME_NOT_FOUND',
        message: `Room '${record.id}' is in progress but no game state could be loaded`,
      });
      return;
    }

    if (!findGamePlayer(gameState, socket.user.id)) {
      socket.emit('S2C_ACTION_REJECTED', {
        clientActionId: null,
        errorCode: 'NOT_A_PARTICIPANT',
        message: `'${socket.user.id}' has no corresponding player in this game`,
      });
      return;
    }

    markOnline(roomId, socket.user.id);

    emitRoomJoined(socket, record);
    socket.emit('S2C_STATE_UPDATE', {
      stateVersion: gameState.stateVersion,
      gameState,
      transactions: [], // a resync, not a state-changing action — nothing to animate
      // Read-only (P10-T04) — GAME_STATE_MACHINE.md §5/§7 are explicit that
      // reconnecting does NOT reset or extend an already-running state
      // timeout, so this reports whatever turnTimers already has scheduled
      // rather than calling scheduleTurnTimer/start() again.
      deadlineAt: turnTimers.deadlineFor(roomId),
    });
    socket.to(roomId).emit('S2C_PLAYER_RECONNECTED', { roomId, playerId: socket.user.id });
  });
}

// Maps a thrown engine/state-machine error to a WEBSOCKET_API.md errorCode.
// Typed errors already carry the right vocabulary — InvalidBidError/
// EventChoiceError/InvalidPropertyActionError's own `.reason` strings
// ('BID_TOO_LOW', 'INSUFFICIENT_BALANCE', 'UNKNOWN_OPTION',
// 'BIDDER_NOT_ACTIVE', 'NOT_OWNER', 'INCOMPLETE_GROUP', 'UNEVEN_SELL',
// 'ALREADY_MORTGAGED', 'NOT_MORTGAGED', ...) are exactly the codes
// WEBSOCKET_API.md documents, not translated here, just forwarded.
function errorCodeFor(err) {
  if (err.name === 'InvalidTurnActionError') return 'PHASE_MISMATCH';
  if (
    err.name === 'InvalidBidError' ||
    err.name === 'EventChoiceError' ||
    err.name === 'InvalidPropertyActionError' ||
    err.name === 'InvalidTradeError' ||
    err.name === 'InvalidJailActionError' ||
    err.name === 'InvalidInventoryActionError' ||
    err.name === 'InvalidForfeitError'
  ) {
    return err.reason;
  }
  if (err instanceof TypeError) return 'MALFORMED_PAYLOAD';
  return 'INTERNAL_ERROR';
}

// socket.user.id is the JWT subject — profiles.id — never a
// PlayerGameState.id (game_players.id, a separate value
// domain/gameState.js's PlayerGameState.playerId is the FK to). Every
// engine/state-machine check that compares an actor (auction.js's
// activeBidders, turnMachine.js's getCurrentPlayer) is keyed on
// PlayerGameState.id, not profiles.id — every caller that needs "does this
// authenticated user have a seat in this game" goes through this lookup
// rather than trusting a client-claimed id. Shared by handleGameAction and
// handleReconnect (P10-T03).
function findGamePlayer(gameState, userId) {
  return gameState.players.find((p) => p.playerId === userId);
}

/**
 * (Re)schedules or cancels roomId's turn timer to match gameState's
 * *current* phase — called after every successful transition, real or
 * timeout-driven, so the invariant "at most one timer, always for the
 * live phase" (TimerManager's own contract) never drifts. A phase outside
 * `TIMER_DURATIONS_SECONDS` (system-only phases, or `null` once the game
 * ends) has no default action to time out to, so any stale timer for this
 * room is cancelled instead of started.
 * @returns {string|null} the new deadlineAt, or null if this phase isn't timed
 */
function scheduleTurnTimer(io, supabase, roomId, gameState, boardTilesByBoard) {
  if (!(gameState.phase in TIMER_DURATIONS_SECONDS)) {
    turnTimers.cancel(roomId);
    return null;
  }

  return turnTimers.start(roomId, gameState.phase, (phase) => {
    handleTurnTimeout(io, supabase, roomId, phase, boardTilesByBoard).catch((err) => {
      console.error(`turnTimers: unhandled error processing a '${phase}' timeout for room '${roomId}':`, err.message);
    });
  });
}

/**
 * The shared tail every successful transition ends at, whether it came
 * from a real `C2S_GAME_ACTION` or a fired turn timer: persist to the
 * in-memory hot store, snapshot to Supabase if this transition hit one of
 * the three approved trigger points, (re)schedule the next turn timer, and
 * broadcast. Pulled out of handleGameAction (P10-T04) so handleTurnTimeout
 * doesn't reimplement it — the two differ only in how `result` gets
 * produced, never in what happens after.
 * @param {import('socket.io').Server} io
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roomId
 * @param {string} actionType
 * @param {object} previousGameState
 * @param {{ gameState: object, transactions: object[] }} result
 * @param {{ small?: object[], large?: object[] }} boardTilesByBoard
 */
async function persistAndBroadcast(io, supabase, roomId, actionType, previousGameState, result, boardTilesByBoard) {
  // In-memory hot store first — this is the authoritative current state and
  // is all the broadcast below needs.
  gameRepository.setGameState(roomId, result.gameState);

  // FLASH_AUCTION per-bid timer extension (2026-09-03): when a PLACE_BID
  // lands and the phase is still FLASH_AUCTION_ACTIVE, extend the deadline
  // by FLASH_AUCTION_BID_EXTENSION_SECONDS (5s) from NOW rather than
  // restarting from the full FLASH_AUCTION_ACTIVE base duration. This
  // gives latecomers a fair window to respond without ballooning the
  // total auction time when bids keep coming.
  let deadlineAt;
  if (actionType === 'PLACE_BID' && result.gameState.phase === 'FLASH_AUCTION_ACTIVE') {
    // Cancel any existing timer and start a fresh 5-second one.
    turnTimers.cancel(roomId);
    const nowMs = Date.now();
    const extendedDeadline = new Date(nowMs + FLASH_AUCTION_BID_EXTENSION_SECONDS * 1000).toISOString();
    deadlineAt = turnTimers.start(roomId, 'FLASH_AUCTION_ACTIVE', (phase) => {
      handleTurnTimeout(io, supabase, roomId, phase, boardTilesByBoard).catch((err) => {
        console.error(`turnTimers: unhandled error processing a '${phase}' timeout for room '${roomId}':`, err.message);
      });
    });
    // Override the returned deadline with our custom extended one.
    // TimerManager.start() already scheduled FLASH_AUCTION_ACTIVE's 5s base,
    // which equals our extension — so the scheduled callback fires at the right
    // time. We just need the broadcast value to match.
    deadlineAt = extendedDeadline;
  } else {
    deadlineAt = scheduleTurnTimer(io, supabase, roomId, result.gameState, boardTilesByBoard);
  }

  // PERF (2026-09-03): broadcast BEFORE the durable Supabase writes, not
  // after. saveSnapshot runs two sequential Supabase upserts (`games`, then
  // `game_state_snapshots`), and this used to sit on the critical path of
  // every END_TURN — so on a Render(US)⇄Supabase(US)⇄player(SEA) deployment
  // the next player waited a full DB round trip (often 300–800ms) just to
  // see that it had become their turn. Durability has never gated gameplay
  // in this design (saveSnapshot's own callers already swallow its errors,
  // and the hot store is the real source of truth — the snapshot is only a
  // cold-restart fallback), so moving it after the emit costs nothing in
  // correctness and removes that stall entirely.
  io.to(roomId).emit('S2C_STATE_UPDATE', {
    stateVersion: result.gameState.stateVersion,
    gameState: result.gameState,
    transactions: result.transactions,
    deadlineAt, // GAME_STATE_MACHINE.md §7: "broadcasts an absolute deadlineAt timestamp" — null when the current phase isn't timed
  });

  const reason = gameRepository.deriveSnapshotReason(actionType, previousGameState, result.gameState);
  if (!reason) return;

  // The two durable writes are independent tables; run them concurrently
  // rather than sequentially. Each failure is logged, not thrown — a
  // persistence failure must never surface to players as a rejected action
  // when the move already applied and broadcast.
  const writes = [
    gameRepository
      .saveSnapshot(supabase, result.gameState, reason)
      .catch((err) => console.error(`persistAndBroadcast: snapshot save failed (reason=${reason}) for room '${roomId}':`, err.message)),
  ];
  if (reason === 'game_over' && result.gameState.status === 'finished') {
    writes.push(
      gameRepository
        .saveMatchResult(supabase, result.gameState)
        .catch((err) => console.error(`persistAndBroadcast: match_results save failed for room '${roomId}':`, err.message))
    );
  }
  await Promise.all(writes);
}

/**
 * TimerManager's onTimeout callback (P10-T04) — synthesizes the phase's
 * documented default action (`buildDefaultAction`, `stateMachine/timers.js`)
 * and runs it through the exact same `applyWithIdempotency` pipeline a real
 * player action uses, per GAME_STATE_MACHINE.md §7's "no separate timeout
 * code path". A synthesized `clientActionId` (this action has no real
 * client to have generated one) is what lets it flow through that same
 * pipeline unmodified — `applyWithIdempotency` requires one, and it's also
 * what makes `stateVersion` increment consistently regardless of whether
 * the action came from a player or a timer.
 *
 * Re-reads the live gameState rather than trusting a closed-over copy —
 * defensive only: TimerManager's own "start cancels any existing timer"
 * invariant should make a stale fire unreachable, but if the room's phase
 * has somehow already moved on by the time this callback runs, applying a
 * default action for the *wrong* phase would either throw
 * (InvalidTurnActionError, harmless) or, worse, silently succeed against
 * stale assumptions — checked explicitly instead of relying on the former.
 * @param {import('socket.io').Server} io
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roomId
 * @param {string} phase - the phase this timer was scheduled for
 * @param {{ small?: object[], large?: object[] }} boardTilesByBoard
 */
async function handleTurnTimeout(io, supabase, roomId, phase, boardTilesByBoard) {
  const gameState = gameRepository.getGameState(roomId);
  if (!gameState || gameState.phase !== phase) {
    return;
  }

  const boardTiles = boardTilesByBoard[gameState.boardId] ?? [];
  // boardTiles must be computed before buildDefaultAction now —
  // LIQUIDATION_REQUIRED's own default (Win Condition design §E2, wired
  // 2026-08-21) needs real tile data to pick which property to liquidate.
  // isSystemDefault (AFK tracking, wired 2026-08-21) marks this action as
  // synthesized rather than sent by a real client — turnMachine.js's
  // END_TURN case reads it to distinguish a genuine end-turn from a
  // POST_ACTIONS timeout for GAME_DESIGN_SPEC.md §25's missedTurnStreak.
  const action = { ...buildDefaultAction(phase, gameState, boardTiles), clientActionId: crypto.randomUUID(), isSystemDefault: true };
  const cache = idempotencyCaches.get(roomId) ?? createIdempotencyCache();
  const now = new Date().toISOString();
  const transitionFn = (gs, act) => transitionTurn(gs, boardTiles, act, now);

  let result;
  try {
    result = applyWithIdempotency(gameState, action, cache, transitionFn, now);
  } catch (err) {
    // A real bug (a documented default rejected by the very phase it was
    // built for) — nobody to emit S2C_ACTION_REJECTED to, so this is the
    // end of the line: log loudly, leave the room's state untouched. The
    // timer is already gone (TimerManager clears on fire), so the room
    // would otherwise stall with no timer covering it — surfaced here
    // rather than silently swallowed for exactly that reason.
    console.error(`handleTurnTimeout: default action for phase '${phase}' in room '${roomId}' was rejected:`, err.message);
    return;
  }

  idempotencyCaches.set(roomId, cache);
  await persistAndBroadcast(io, supabase, roomId, action.type, gameState, result, boardTilesByBoard);
}

/**
 * Closes finding #27 (docs/PROJECT_STATUS.md): WEBSOCKET_API.md and
 * engine/dice.js's own header both document ROLL_DICE/ATTEMPT_JAIL_ROLL's
 * dice and MAKE_EVENT_CHOICE's probabilityRoll as server-generated, never
 * client-supplied — but until now nothing here ever actually generated
 * them, so a client-sent value was used as-is (proven exploitable: a
 * player could simply claim any roll they wanted). Fixed the same way
 * playerId/tradeId already are, just below this function: computed here,
 * at the impure Socket.IO layer (the one place in this codebase pure
 * engine/state-machine functions are deliberately never allowed to source
 * their own randomness from — see dice.js's/eventResolver.js's own file
 * headers), then spread into action.payload *after* the client's own
 * payload, so any client-supplied die/probabilityRoll is always
 * overwritten, never merely supplemented. `stateMachine/timers.js`'s
 * `buildDefaultAction` already did this correctly for the *timeout*
 * default-action path — this is the same treatment for a live player's own
 * click, which was the actual gap.
 * @param {string} actionType
 * @param {import('../../domain/gameState.js').GameState} gameState
 * @param {object} [payload] - the client's own payload, inspected only to find MAKE_EVENT_CHOICE's optionId (never trusted for the roll itself)
 * @param {() => number} randomSource - injectable RNG, real Math.random in production; tests inject a fixed sequence, same convention dice.js's own rollDice() already established
 * @returns {object} fields to overwrite onto action.payload; {} for any actionType that doesn't need server-generated randomness
 */
// Exported for tests only (2026-09-01) — zero behaviour change, same
// one-word-export precedent as turnMachine.js's getCurrentPlayer. Needed
// because the USE_INVENTORY_CARD branch below is deliberately hardening a
// LATENT hole: no card that is currently `keepable` carries randomness, and
// handleUseInventoryCard now (correctly) refuses to play a non-keepable card
// from a hand — so this branch cannot be reached end-to-end through the
// socket at all today, and can only be pinned by calling it directly.
export function serverGeneratedFields(actionType, gameState, payload, randomSource) {
  if (actionType === 'ROLL_DICE') {
    return rollDice(gameState.currentDoublesStreak, randomSource);
  }

  if (actionType === 'ATTEMPT_JAIL_ROLL') {
    // A jail-escape roll always starts its own doublesStreak at 0 —
    // engine/jail.js's own docstring — independent of gameState's normal
    // ROLLING-phase currentDoublesStreak.
    return rollDice(0, randomSource);
  }

  if (actionType === 'PLAY_MOVEMENT_CARD') {
    // ASYMMETRIC's movement deck has one card whose step count is rolled
    // rather than fixed (movementDictionary.js's `random: [lo, hi]` marker).
    // Detected off the marker, not the card id, so adding a second random
    // card needs no change here. Reuses rollDice's real 2d6 distribution
    // rather than a flat lo..hi pick — the card's own description says
    // "đổ 2 viên xúc xắc", and 7 should be commoner than 2 or 12.
    const card = MOVEMENT_CARDS[payload?.cardId];
    return card?.random ? { cardRoll: rollDice(0, randomSource).total } : {};
  }

  if (actionType === 'GAMBLE_RENT') {
    // REVISED 2026-08-25 (was RENT_RISK_CHOICE, whose Standard branch didn't
    // need a roll at all) — GAMBLE_RENT unconditionally IS the gamble now,
    // there is no non-gambling branch of it, so this always injects one.
    return { gambleRoll: randomSource() };
  }

  if (actionType === 'MAKE_EVENT_CHOICE') {
    // Mirrors engine/eventResolver.js's own resolveChoice() detection
    // exactly (`intent.action !== 'PROBABILITY'`) — only generate a roll
    // when the chosen option actually has one to resolve. An unknown
    // card/optionId here just means no roll gets injected; resolveChoice()
    // still throws its own UNKNOWN_OPTION for that case downstream,
    // unaffected by this.
    const card = EVENT_CARDS[gameState.pendingEventCardId];
    const option = card?.options?.find((o) => o.id === payload?.optionId);
    const needsProbabilityRoll = option?.intents?.some((intent) => intent.action === 'PROBABILITY') ?? false;
    // dieFaceRoll (2026-08-22, C05/C11's own DIE_FACE_REWARD intent) — same
    // "only inject when the chosen option actually needs one" gating,
    // independent of needsProbabilityRoll (a single option never needs
    // both in this deck, but nothing stops both fields from coexisting on
    // the same payload if one someday did). randomSource() is [0, 1) by
    // this same file's own established contract — floor(*6)+1 maps it onto
    // a real 1-6 die face uniformly, same technique dice.js's own rollDice
    // already uses for each individual die.
    const needsDieFaceRoll = option?.intents?.some((intent) => intent.action === 'DIE_FACE_REWARD') ?? false;
    return {
      ...(needsProbabilityRoll ? { probabilityRoll: randomSource() } : {}),
      ...(needsDieFaceRoll ? { dieFaceRoll: Math.floor(randomSource() * 6) + 1 } : {}),
    };
  }

  // USE_INVENTORY_CARD (Card Inventory system) — closes the same hole
  // finding #27 closed for every other randomised action, before it can be
  // reached. turnMachine.js's handleUseInventoryCard passes the payload's
  // probabilityRoll/dieFaceRoll straight into resolveChoice() for a kept
  // CHOICE card, and this function did not cover the action, so those values
  // arrived unfiltered from the client — a player could name their own die
  // face and take the best tier of any die-face table.
  //
  // Not exploitable at the moment this was added (the four keepable cards
  // carry no randomness), but latent rather than theoretical: the deck's two
  // dice cards, C05 and C11, are exactly the kind of card that would be
  // marked keepable next, and this would then be a live cheat with nothing
  // in the way. Hardened now rather than after that happens.
  //
  // Differs from MAKE_EVENT_CHOICE above in one way only: the card comes
  // from the payload's own `cardId` (the card being played out of hand),
  // not gameState.pendingEventCardId (nothing is pending — that is the
  // whole point of a kept card). Same "an unknown card/option injects
  // nothing and the handler still throws its own error downstream" tolerance.
  if (actionType === 'USE_INVENTORY_CARD') {
    const card = EVENT_CARDS[payload?.cardId];
    const option = card?.options?.find((o) => o.id === payload?.optionId);
    const intents = card?.type === 'INSTANT' ? (card.intents ?? []) : (option?.intents ?? []);
    return {
      ...(intents.some((intent) => intent.action === 'PROBABILITY') ? { probabilityRoll: randomSource() } : {}),
      ...(intents.some((intent) => intent.action === 'DIE_FACE_REWARD') ? { dieFaceRoll: Math.floor(randomSource() * 6) + 1 } : {}),
    };
  }

  return {};
}

/**
 * Registers the C2S_GAME_ACTION listener — the single entry point for
 * every in-game move (WEBSOCKET_API.md §1).
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ getRoomById: (supabase: object, roomId: string) => Promise<object|null> }} roomRepository
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ small?: object[], large?: object[] }} [boardTilesByBoard] - keyed by GameState.boardId; missing/unset boards fall back to []
 * @param {() => number} [randomSource] - see serverGeneratedFields; defaults to Math.random, tests inject a fixed sequence
 */
export function handleGameAction(io, socket, roomRepository, supabase, boardTilesByBoard = {}, randomSource = Math.random) {
  socket.on('C2S_GAME_ACTION', async (message) => {
    const { roomId, actionType, payload, clientActionId, lastSeenStateVersion } = message ?? {};

    // PERF (2026-09-03) — the room record is NOT re-fetched from Supabase on
    // every action any more. It used to be: `getRoomById` runs two sequential
    // Supabase queries (`rooms` row, then `fetchPlayers`), and this handler
    // ran it on *every* ROLL_DICE / BUY_PROPERTY / PLACE_BID / …, so each move
    // in a live game paid a full cross-region DB round trip before the engine
    // was even touched. On a Render (US) ⇄ Supabase (US) ⇄ player (SEA) path
    // that was the single largest source of the "everything lags" the user
    // reported after deploying.
    //
    // It is redundant during gameplay: the hot in-memory GameState already
    // answers every question the record was consulted for —
    //   • "does this game exist"      → gameState is non-null
    //   • "is the caller a player"    → findGamePlayer(gameState, …) below
    //   • "is it still in progress"   → gameState.status check below
    // — and the participant roster is frozen once a match starts (join/leave
    // are pre-game only). So: resolve the hot state first (an in-memory Map
    // hit, no I/O), and only fall back to getRoomById on a genuine cold miss
    // (server restart mid-match), where correctness matters and the one-time
    // cost does not.
    const gameState = await gameRepository.resolveLiveGameState(roomId, supabase);

    if (!gameState) {
      // Cold miss: no hot state and no durable snapshot to load. This is the
      // ONLY branch that still consults the room record — to tell apart
      // "room never existed / you're not in it", "game genuinely not started
      // yet", and "in_progress but state could not be loaded".
      const record = roomId ? await roomRepository.getRoomById(supabase, roomId) : null;
      const isParticipant = record?.players?.some((p) => p.playerId === socket.user.id) ?? false;
      let errorCode = 'GAME_NOT_FOUND';
      let errMessage = `Room '${roomId}' is in progress but no game state could be loaded`;
      if (!record || !isParticipant) {
        errorCode = 'NOT_A_PARTICIPANT';
        errMessage = `Room '${roomId}' not found, or you are not a member of it`;
      } else if (record.status !== 'in_progress') {
        errorCode = 'ROOM_NOT_IN_PROGRESS';
        errMessage = `Room '${record.id}' is not in progress (status: ${record.status})`;
      }
      socket.emit('S2C_ACTION_REJECTED', { clientActionId: clientActionId ?? null, errorCode, message: errMessage });
      return;
    }

    // Win Condition design (2026-08-19): a real gap, not covered by the
    // record.status check above — ROOM_STATUSES has no 'finished' value
    // (rooms.status's own CHECK constraint: waiting_for_players/
    // ready_check/starting/in_progress/abandoned only), so a room can
    // legitimately still read 'in_progress' after the *game* inside it has
    // already ended (gameState.status transitions to 'finished'/'aborted',
    // turnMachine.js's settleGameEnd()). Without this, a client could keep
    // sending real actions (trade, mortgage, ...) against a game whose
    // final standings were already computed and broadcast.
    if (gameState.status !== 'in_progress') {
      socket.emit('S2C_ACTION_REJECTED', {
        clientActionId: clientActionId ?? null,
        errorCode: 'GAME_ALREADY_FINISHED',
        message: `Game '${gameState.id}' has already ended (status: ${gameState.status})`,
      });
      return;
    }

    // GAME_STATE_MACHINE.md §6 point 2 / GAME_DESIGN_SPEC.md §26's own
    // proposed error code, wired 2026-08-21: "a client sends an old/stale
    // action... rejected — the action's lastSeenStateVersion no longer
    // matches current stateVersion where that matters (target-specific
    // actions)". WEBSOCKET_API.md's C2S_GAME_ACTION envelope never actually
    // defined this field, so nothing could ever trigger it — added here as
    // a genuinely optional field (backward compatible with every existing
    // client/test that never sends it) rather than guessing which specific
    // actions count as "target-specific" and gating only those: a client
    // that cares about staleness opts in by including the field at all: any
    // action carrying it is checked uniformly, one simple rule instead of a
    // per-actionType allow-list that would need remembering on every future
    // mechanic (the same "don't require a checklist" reasoning
    // TURN_INDEPENDENT_ACTION_TYPES above already uses, applied the other
    // direction — opt-in here instead of opt-out there, because unlike turn-
    // ownership this has no safe uniform default: most actions never need
    // it, so defaulting everyone into staleness-checking would reject
    // ordinary lag-free traffic that simply never bothered to track a
    // version number).
    if (lastSeenStateVersion != null && lastSeenStateVersion !== gameState.stateVersion) {
      socket.emit('S2C_ACTION_REJECTED', {
        clientActionId: clientActionId ?? null,
        errorCode: 'STALE_ACTION',
        message: `Action was based on stateVersion ${lastSeenStateVersion}, but the game is now at ${gameState.stateVersion}`,
      });
      return;
    }

    const gamePlayer = findGamePlayer(gameState, socket.user.id);
    if (!gamePlayer) {
      socket.emit('S2C_ACTION_REJECTED', {
        clientActionId: clientActionId ?? null,
        errorCode: 'NOT_A_PARTICIPANT',
        message: `'${socket.user.id}' has no corresponding player in this game`,
      });
      return;
    }

    // Trade actions (PROPOSE/COUNTER/ACCEPT/REJECT/CANCEL_TRADE) are
    // deliberately independent of gameState.phase — routed to
    // tradeMachine.js's applyTradeAction instead of transitionTurn, not
    // gated by VALID_ACTIONS_BY_PHASE at all (see tradeMachine.js's own file
    // header for why). Everything else about this handler — room/
    // participant checks above, idempotency, persistAndBroadcast below — is
    // identical for both kinds of action, this is the one branch point.
    // PROPOSE_TRADE/COUNTER_TRADE each need a fresh server-generated id
    // (tradeId / newTradeId) — generated here, not inside tradeMachine.js,
    // same "randomness lives at the impure Socket.IO layer, never inside a
    // pure orchestrator" boundary dice rolls and timer clientActionIds
    // already follow (see timers.js/handleTurnTimeout above).
    const isTradeAction = TRADE_ACTION_TYPES.includes(actionType);
    const tradeIdField = actionType === 'PROPOSE_TRADE' ? 'tradeId' : actionType === 'COUNTER_TRADE' ? 'newTradeId' : null;

    // SECURITY_DESIGN.md "Known gaps" #5, found 2026-08-18, fixed here
    // 2026-08-21: GAME_DESIGN_SPEC.md §27's turn-ownership rule ("roll, buy,
    // build, mortgage, end-turn... only accepted from the socket matching
    // players[currentTurnIndex].userId") was never actually enforced —
    // every turnMachine.js handler resolves the acting player via its own
    // internal getCurrentPlayer(gameState), never cross-checked against who
    // really sent this message, so any room participant could trigger
    // ROLL_DICE/BUY_PROPERTY/BUILD_HOUSE/etc. on someone else's turn (not a
    // theft vector — gamePlayer.id below is always the real sender's own
    // resolved identity, injected the same way playerId always has been —
    // but a real out-of-turn griefing/desync surface). Fixed at exactly the
    // level that gap's own writeup called for: once, here, before dispatch,
    // rather than duplicated inside every individual handler. Trade actions
    // keep their own separate NOT_TARGET/NOT_PROPOSER authorization model
    // (tradeMachine.js/engine/trade.js) and are excluded here, not doubly
    // gated — see TRADE_ACTION_TYPES above, not TURN_INDEPENDENT_ACTION_TYPES.
    if (!isTradeAction && !TURN_INDEPENDENT_ACTION_TYPES.includes(actionType)) {
      const currentPlayer = getCurrentPlayer(gameState);
      if (currentPlayer?.id !== gamePlayer.id) {
        socket.emit('S2C_ACTION_REJECTED', {
          clientActionId: clientActionId ?? null,
          errorCode: 'NOT_YOUR_TURN',
          message: `It is not your turn — '${currentPlayer?.id ?? 'nobody'}' is the current player`,
        });
        return;
      }
    }

    const action = {
      type: actionType,
      payload: {
        ...payload,
        playerId: gamePlayer.id,
        ...(tradeIdField ? { [tradeIdField]: crypto.randomUUID() } : {}),
        ...serverGeneratedFields(actionType, gameState, payload, randomSource),
      },
      clientActionId,
    };

    const cache = idempotencyCaches.get(roomId) ?? createIdempotencyCache();
    const now = new Date().toISOString();
    const boardTiles = boardTilesByBoard[gameState.boardId] ?? []; // see file header
    const transitionFn = isTradeAction
      ? (gs, act) => applyTradeAction(gs, act, now)
      : (gs, act) => transitionTurn(gs, boardTiles, act, now);

    let result;
    try {
      result = applyWithIdempotency(gameState, action, cache, transitionFn, now);
    } catch (err) {
      socket.emit('S2C_ACTION_REJECTED', {
        clientActionId,
        errorCode: errorCodeFor(err),
        message: err.message,
      });
      return;
    }

    idempotencyCaches.set(roomId, cache);
    await persistAndBroadcast(io, supabase, roomId, actionType, gameState, result, boardTilesByBoard);
  });
}

/**
 * Wires the pieces above onto a real Socket.IO server attached to
 * httpServer. jwtSecret is a required third parameter, not in the
 * originating task's original two-argument sketch — createSocketAuthMiddleware()
 * (and createAuthMiddleware() before it) both require an explicit,
 * non-empty secret; there is no way to construct working auth middleware
 * without one, so this had to be added rather than silently reading
 * process.env internally (which would break the same testability
 * boundary those factories exist to preserve).
 * Without jwtSecret, returns a real (but otherwise unconfigured) `io`
 * instance rather than throwing — found via an actual boot smoke test,
 * not a unit test: every prior test here supplied a valid secret, so
 * initSocketServer() unconditionally calling createSocketAuthMiddleware()
 * (which throws on a falsy secret) had silently made `node src/server.js`
 * crash on startup whenever SUPABASE_JWT_SECRET wasn't set — true in this
 * environment right now. Same "missing infra makes the dependent feature
 * inert, not the whole process unable to start" posture createApp()'s
 * jwtSecret already established; a socket namespace with no working auth
 * would be worse than one that simply never accepts connections.
 * @param {import('http').Server} httpServer
 * @param {{ getRoomById: (supabase: object, roomId: string) => Promise<object|null> }} roomRepository
 * @param {string} jwtSecret
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ small?: object[], large?: object[] }} [boardTilesByBoard] - see handleGameAction; defaults to {} (every board falls back to [])
 * @param {() => number} [randomSource] - see handleGameAction/serverGeneratedFields; defaults to Math.random, tests inject a fixed sequence
 * @returns {import('socket.io').Server}
 */
export function initSocketServer(httpServer, roomRepository, jwtSecret, supabase, boardTilesByBoard = {}, randomSource = Math.random) {
  // CORS — Socket.IO's own Engine.IO transport handles `/socket.io/*`
  // requests itself, separately from Express's middleware stack (app.js's
  // CORS fix, added the same session, does not cover this) — Socket.IO v4
  // defaults to *rejecting* cross-origin handshakes unless `cors` is
  // explicitly configured. Same reflect-the-request-Origin reasoning as
  // app.js: found missing only by actually connecting from a real browser
  // (frontend :5173, backend :5000), invisible to socketServer.test.js's
  // in-process mock sockets and to `node --test` generally.
  const io = new Server(httpServer, {
    cors: { origin: true, methods: ['GET', 'POST'] },
    // PERF / stability tuning (2026-09-03), after the deployed game felt laggy:
    //
    // - `transports: ['websocket', 'polling']` — offer WebSocket first. The
    //   default order is polling-then-upgrade, which spends the first few
    //   round trips on HTTP long-polling (each in-game message a separate
    //   request) before switching. The client also asks for websocket-first;
    //   polling stays listed purely as a fallback for networks that block WS.
    // - `pingInterval` / `pingTimeout` — the defaults (25s / 20s) drop a
    //   client whose pong is merely late, and a drop here is expensive: full
    //   re-handshake, re-auth, C2S_RECONNECT, whole-state resync. On a
    //   high-latency mobile link over the Pacific those false drops were a
    //   real source of mid-game stalls. 20s ping + 30s grace tolerates a
    //   transient spike without giving up on a genuinely-gone client for too
    //   long (RECONNECT_GRACE_SECONDS still bounds the in-game side).
    transports: ['websocket', 'polling'],
    pingInterval: 20000,
    pingTimeout: 30000,
  });

  if (!jwtSecret) {
    return io;
  }

  io.use(createSocketAuthMiddleware(jwtSecret));

  io.on('connection', (socket) => {
    handleJoinRoom(io, socket, roomRepository, supabase);
    handleReconnect(io, socket, roomRepository, supabase);
    handleGameAction(io, socket, roomRepository, supabase, boardTilesByBoard, randomSource);
    handleDisconnect(io, socket);
  });

  return io;
}
