// Room lobby controllers — API_CONTRACT.md's Rooms section. Deliberately
// grounded in that document rather than invented ad hoc: base path
// `/api/v1`, error envelope `{ error: { code, message } }` (same shape
// auth/authMiddleware.js already established), join-by-`joinCode` (not
// `roomId` — see roomRepository.js's getRoomByJoinCode), and the
// found-but-not-a-member -> 404 privacy rule (never 403).
//
// req.user.id is assumed already set by auth/authMiddleware.js, mounted
// ahead of these routes in app.js — these functions don't verify the JWT
// themselves, same separation authMiddleware.js's own header describes.
//
// Uses domain/room.js's createRoom() for the Room shape itself, so a room
// created here is byte-for-byte what a real DB-backed implementation would
// also produce. create/join/get don't call stateMachine/roomMachine.js's
// transitionRoom() — joining never changes Room.status. setReady/startGame
// (this pass) do call it: transitionRoom() is Room.status's own state
// machine, and per its own file header ("'All players ready'... arrive
// here as already-decided events — computing *whether* everyone is ready
// is the caller's job") this controller is exactly the caller responsible
// for that computation.
//
// P10-T02: every handler is now async — roomRepository/gameRepository are
// real Supabase I/O, not an in-memory Map. `supabase` is read from
// `req.app.get('supabase')` (set by app.js's createApp({ supabase })),
// not imported as a module-level singleton — same DI reasoning
// infrastructure/websocket/socketServer.js's own handlers already use
// (constructor-injected roomRepository), applied here via Express's own
// app-level storage instead, since these are plain route handlers, not a
// factory — this keeps room.routes.js completely unchanged and lets tests
// substitute a fake Supabase client per request without module mocking.

import crypto from 'node:crypto';
import { createRoom as createRoomDomain, ROOM_STATUSES } from '../../domain/room.js';
import { transitionRoom } from '../../stateMachine/roomMachine.js';
import { createGameState, createPlayerGameState } from '../../domain/gameState.js';
import { createProperty } from '../../domain/property.js';
import { EVENT_CARDS } from '../../domain/eventDictionary.js';
import { BUYABLE_TILE_TYPES } from '../../engine/resolveTile.js';
import { initialDraftState } from '../../engine/draftPhase.js';
import { isValidZodiac, randomZodiac } from '../../domain/zodiac.js';
import * as roomRepository from '../../infrastructure/repositories/roomRepository.js';
import * as gameRepository from '../../infrastructure/repositories/gameRepository.js';

const MIN_PLAYERS = 2; // GAME_DESIGN_SPEC.md §0, CONFIRMED
const MAX_PLAYERS = 6; // GAME_DESIGN_SPEC.md §0, CONFIRMED
const STARTING_BALANCE = 1500; // GAME_DESIGN_SPEC.md §0 / ECONOMY_SPECIFICATION.md §8, PROPOSED classic value ("BALANCE TBD")
const BANK_RESERVE_INITIAL = 20000; // ECONOMY_SPECIFICATION.md §8, PROPOSED classic value ("BALANCE TBD")
const JOIN_CODE_LENGTH = 6; // GAME_DESIGN_SPEC.md's ROOM_JOIN_CODE_LENGTH, CONFIRMED
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // excludes 0/O, 1/I/L — ambiguous when read aloud or handwritten
const MAX_JOIN_CODE_ATTEMPTS = 5; // API_CONTRACT.md: "retries generation a few times... before giving up"
const JOINABLE_STATUSES = ['waiting_for_players', 'ready_check'];

// Fallback-only cache of each room's ruleset, for databases where migration
// 0006_room_ruleset.sql has not been applied and `rooms.ruleset` therefore
// does not exist. It used to be the ONLY store, which meant a backend restart
// between creating a room and starting it silently turned an "Đột Phá" room
// into a Classic one — invisible, because nothing errors and the lobby label
// comes from the same lost Map. The real value is persisted now
// (roomRepository.createRoom); this only answers when the column is absent.
const roomRulesets = new Map();

/**
 * The room's real ruleset. Prefers what the database actually stored; falls
 * back to the in-process cache only when `ruleset` came back null, which
 * roomRepository's own mapper reserves for "the column does not exist".
 */
function resolveRuleset(record) {
  return record.ruleset ?? roomRulesets.get(record.id) ?? 'CLASSIC';
}

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

/**
 * Lobby real-time push (2026-08-21) — API_CONTRACT.md's own long-flagged
 * note ("a REST ready/start mutation still pushes a lightweight
 * notification over Socket.IO... payload TBD in the Socket.IO contract
 * phase") was never actually built (Lobby.jsx's own header, PROJECT_STATUS.md
 * "Recommended next" #6: "worth doing... the actual room:updated-style
 * Socket.IO push"). Wired into all 5 room-mutating endpoints below
 * (join/ready/start/leave/kick), not just ready/start — every one of them
 * changes what an already-connected lobby member is looking at (roster or
 * status), same underlying gap, no reason to fix it for two and leave the
 * other three stale.
 *
 * `io` is read via req.app.get('io') (server.js's own app.set('io', io),
 * same DI as req.app.get('boardTilesByBoard')) — optional-chained so a test
 * harness that never registers one (every existing room.controller.test.js
 * fixture) degrades gracefully rather than throwing, the same posture
 * boardTilesByBoard's own absence already gets.
 *
 * Payload carries `roomStatus`, not just `roomId` — deliberately not the
 * minimal shape S2C_PLAYER_DISCONNECTED/RECONNECTED use. App.jsx's own
 * view-routing (`LobbyDiagnostic`/`Lobby`/`GameView`) reads
 * `roomState.roomStatus` straight from the Zustand store, which only
 * socketClient.js ever writes to — a roomId-only push would tell Lobby.jsx
 * to refetch its own local roster (closing half the gap) but would never
 * flip a *non-acting* player's own view to GameView the instant the host
 * starts the game (the other, bigger half) since nothing would update the
 * store's roomStatus for them. Full player roster (displayName/isHost/
 * isReady) is deliberately NOT included here — that shape only exists on
 * the REST side (API_CONTRACT.md), Lobby.jsx already fetches it correctly;
 * duplicating it into the socket payload would just be a second copy that
 * could drift, for no real benefit over "the push tells you to refetch".
 */
function notifyRoomUpdated(req, record) {
  req.app.get('io')?.to(record.id).emit('S2C_ROOM_UPDATED', {
    roomId: record.id,
    roomStatus: record.status,
    // The roster RIDES ALONG as of 2026-09-04. It used to be deliberately
    // excluded (see the paragraph above), on the reasoning that "the push
    // tells you to refetch" was free and a second copy could drift.
    // Measurement retired the first half of that: the refetch is
    // GET /rooms/:id = three sequential Supabase round trips, and the
    // deployed backend sits in Render's gcp-us-west1 (Oregon — confirmed
    // from DNS) while Supabase answers from Asia and the players are in
    // Vietnam. So every other player waited roughly a full second after a
    // teammate's ready-toggle, all of it spent re-fetching data the server
    // already had in hand at the moment it sent this push.
    //
    // The drift concern is answered rather than accepted: this is
    // toRoomResponse(record) — the exact function, on the exact record, that
    // the REST endpoints return. One producer, one shape, delivered over two
    // transports, not two copies. roomId/roomStatus stay at the top level, so
    // a client written against the old payload keeps working unchanged.
    room: toRoomResponse(record),
  });
}

function toRoomResponse(record) {
  return {
    roomId: record.id,
    joinCode: record.joinCode,
    hostId: record.hostId,
    status: record.status,
    ruleset: resolveRuleset(record),
    players: record.players,
    createdAt: record.createdAt,
  };
}

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

async function generateUniqueJoinCode(supabase) {
  for (let attempt = 0; attempt < MAX_JOIN_CODE_ATTEMPTS; attempt++) {
    const code = generateJoinCode();
    if (!(await roomRepository.getRoomByJoinCode(supabase, code))) {
      return code;
    }
  }
  return null;
}

// API_CONTRACT.md: "every non-host player is_ready" — the host expresses
// readiness by starting the match, not by toggling this flag.
function allNonHostPlayersReady(players) {
  return players.filter((p) => !p.isHost).every((p) => p.isReady);
}

function shuffled(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Constructs the initial GameState for a room that just started —
 * GAME_DESIGN_SPEC.md's "Status -> InProgress; in-memory GameState
 * created: shuffle turn order, position = 0 and balance = STARTING_BALANCE
 * for every player, shuffle event decks."
 *
 * `properties`: one unowned Property row per buyable tile
 * (BUYABLE_TILE_TYPES — property/transport/utility, resolveTile.js's own
 * list, reused rather than redeclared) on the chosen board. **Real bug,
 * found 2026-08-19 via this project's first actual full live playtest**:
 * this hardcoded `properties: []` unconditionally, with a comment claiming
 * real board tile data was still unreachable — true when this function was
 * first written (Phase 08), but stale ever since Phase 11 actually seeded
 * `board_tiles` and wired `boardTilesByBoard` through the app (server.js/
 * board.controller.js already established the exact `req.app.get(
 * 'boardTilesByBoard')` access pattern this reuses). The result: every
 * real game started via this endpoint had an empty properties array,
 * meaning `resolveTile.js`'s `resolveBuyableTile()` would throw
 * (`TypeError: property is required for a buyable tile type`) the instant
 * any player landed on any property/transport/utility tile — a crash on
 * essentially the first or second roll of any real game. Invisible until
 * now: every unit test constructs its own correct `properties` fixture
 * directly (never exercises this function), and every prior live-
 * verification pass this project's history used either an injected fake
 * frontend GameState or carefully never drove a real ROLL_DICE deep enough
 * into a genuinely `in_progress` room to land on an unowned tile.
 * @param {{ small?: object[], large?: object[] }} [boardTilesByBoard] - keyed by board size, same shape/DI source every other consumer (board.controller.js, socketServer.js) already reads from `req.app.get('boardTilesByBoard')`
 */
function initializeGameState({ gameId, roomId, ruleset, players, boardTilesByBoard }) {
  const boardId = players.length <= 4 ? 'small' : 'large'; // ADAPTIVE_BOARD_DESIGN.md, fully approved sizing
  const now = new Date().toISOString();

  const bank = createPlayerGameState({
    id: crypto.randomUUID(),
    gameId,
    isBank: true,
    currentBalance: BANK_RESERVE_INITIAL,
  });

  // Zodiac (2026-08-22): a player's lobby pick (room_players.zodiac,
  // roomRepository.js's fetchPlayers) carries straight through; a player who
  // never chose (null) gets a random one of the 12 assigned now, at the one
  // moment a piece actually needs to render. Deliberately not de-duplicated
  // against other players' picks/random draws — two players sharing an
  // animal is explicitly allowed, playerColor() (frontend) is what tells
  // them apart, same as it already does for the plain-initial tokens this
  // supersedes.
  const turnOrderedPlayers = shuffled(players).map((p, index) =>
    createPlayerGameState({
      id: crypto.randomUUID(),
      gameId,
      playerId: p.playerId,
      turnOrder: index,
      currentBalance: STARTING_BALANCE,
      currentPosition: 0,
      zodiac: isValidZodiac(p.zodiac) ? p.zodiac : randomZodiac(),
    })
  );

  const boardTiles = boardTilesByBoard?.[boardId] ?? [];
  const properties = boardTiles
    .filter((tile) => BUYABLE_TILE_TYPES.includes(tile.tileType))
    .map((tile) => createProperty({ id: crypto.randomUUID(), gameId, boardTileId: tile.id }));

  // Draft Phase (ASYMMETRIC_MODE_SPEC.md §1.3): the match starts in
  // DRAFTING_ACTIVE, seeded from the SAME turnOrderedPlayers array
  // (ascending turnOrder) draftPhase.js's own snake-order logic expects,
  // rather than in TURN_START — turnMachine.js's handleDraftAction() hands
  // off to a real TURN_START itself once round 2 finishes. CLASSIC matches
  // are unaffected: draftState stays null and phase starts at TURN_START
  // exactly as before this mode existed.
  const isAsymmetric = (ruleset ?? 'CLASSIC') === 'ASYMMETRIC';
  const draftState = isAsymmetric
    ? initialDraftState(turnOrderedPlayers.map((p) => p.id), boardTiles)
    : null;

  return createGameState({
    id: gameId,
    roomId,
    boardId,
    status: 'in_progress',
    ruleset: ruleset ?? 'CLASSIC',
    phase: isAsymmetric ? 'DRAFTING_ACTIVE' : 'TURN_START',
    currentTurnIndex: 0,
    players: [bank, ...turnOrderedPlayers],
    properties,
    eventDeck: shuffled(Object.keys(EVENT_CARDS)),
    startedAt: now,
    draftState,
  });
}

export async function createRoom(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const joinCode = await generateUniqueJoinCode(supabase)
    if (!joinCode) {
      return errorResponse(res, 500, 'INTERNAL_ERROR', 'Could not generate a unique join code')
    }

    const now = new Date().toISOString()
    const room = createRoomDomain({
      id: crypto.randomUUID(),
      joinCode,
      hostId: req.user.id,
      ruleset: req.body.ruleset === 'ASYMMETRIC' ? 'ASYMMETRIC' : 'CLASSIC',
      createdAt: now,
    })

    const record = await roomRepository.createRoom(supabase, {
      ...room,
      players: [{ playerId: req.user.id, displayName: req.user.id, avatarUrl: null, isReady: false, isHost: true, zodiac: null }],
    })

    roomRulesets.set(record.id, room.ruleset)

    return res.status(201).json(toRoomResponse(record))
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/v1/rooms/:code/join — API_CONTRACT.md. Path param is the
 * shareable join code, not the internal room id. Empty body — the joining
 * player is req.user.id, never a client-asserted identity.
 */
export async function joinRoom(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const { code } = req.params
    const record = await roomRepository.getRoomByJoinCode(supabase, code)

    if (!record) {
      return errorResponse(res, 404, 'INVALID_JOIN_CODE', `No room found for join code '${code}'`)
    }

    const alreadyMember = record.players.some((p) => p.playerId === req.user.id)
    if (alreadyMember) {
      return res.status(200).json(toRoomResponse(record))
    }

    if (!JOINABLE_STATUSES.includes(record.status)) {
      return errorResponse(res, 409, 'ALREADY_STARTED', `Room '${record.id}' is not open for joining (status: ${record.status})`)
    }

    if (record.players.length >= MAX_PLAYERS) {
      return errorResponse(res, 409, 'ROOM_FULL', `Room '${record.id}' already has the maximum of ${MAX_PLAYERS} players`)
    }

    const updated = await roomRepository.updateRoom(supabase, record.id, {
      ...record,
      players: [
        ...record.players,
        {
          playerId: req.user.id,
          displayName: req.body?.displayName ?? req.user.id,
          avatarUrl: null,
          isReady: false,
          isHost: false,
          zodiac: null,
        },
      ],
    }, record)

    notifyRoomUpdated(req, updated)
    return res.status(200).json(toRoomResponse(updated))
  } catch (err) {
    next(err)
  }
}

/**
 * GET /api/v1/rooms/:id — API_CONTRACT.md. 404 for both "doesn't exist"
 * and "exists but sender isn't a member" — the confirmed privacy rule.
 */
export async function getRoom(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const { id } = req.params
    const record = await roomRepository.getRoomById(supabase, id)

    if (!record || !record.players.some((p) => p.playerId === req.user.id)) {
      return errorResponse(res, 404, 'NOT_FOUND', `No room found for id '${id}'`)
    }

    return res.status(200).json(toRoomResponse(record))
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /api/v1/rooms/:id/ready — API_CONTRACT.md.
 */
export async function setReady(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const { id } = req.params
    const { ready } = req.body ?? {}

    const record = await roomRepository.getRoomById(supabase, id)
    if (!record || !record.players.some((p) => p.playerId === req.user.id)) {
      return errorResponse(res, 404, 'NOT_FOUND', `No room found for id '${id}'`)
    }

    if (typeof ready !== 'boolean') {
      return errorResponse(res, 400, 'VALIDATION_ERROR', "'ready' must be a boolean")
    }

    if (!JOINABLE_STATUSES.includes(record.status)) {
      return errorResponse(res, 409, 'ALREADY_STARTED', `Room '${record.id}' is not in a state that accepts ready changes (status: ${record.status})`)
    }

    const players = record.players.map((p) => (p.playerId === req.user.id ? { ...p, isReady: ready } : p))
    const allReady = allNonHostPlayersReady(players)

    let nextRecord = { ...record, players }
    if (allReady && record.status === 'waiting_for_players') {
      nextRecord = transitionRoom(nextRecord, { type: 'ALL_PLAYERS_READY' })
    } else if (!allReady && record.status === 'ready_check') {
      nextRecord = transitionRoom(nextRecord, { type: 'PLAYER_UNREADY' })
    }

    const updated = await roomRepository.updateRoom(supabase, record.id, nextRecord, record)
    notifyRoomUpdated(req, updated)
    return res.status(200).json(toRoomResponse(updated))
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /api/v1/rooms/:id/zodiac — 12 con giáp lobby picker (2026-08-22),
 * new to this document (never in the original API_CONTRACT.md, same
 * standing as `kick_player`'s own later addition) — modeled directly on
 * `setReady`'s shape: same membership 404, same `JOINABLE_STATUSES` 409
 * (a pick made after the match has already started would never reach
 * `initializeGameState`, so it's meaningless, not merely late), same
 * `S2C_ROOM_UPDATED` push so another lobby member's screen reflects a pick
 * without polling. `{ zodiac: string|null }` — null explicitly clears a
 * pick (falls back to random at game start, `initializeGameState`'s own
 * handling), not merely "field omitted".
 */
export async function setZodiac(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const { id } = req.params
    const { zodiac } = req.body ?? {}

    const record = await roomRepository.getRoomById(supabase, id)
    if (!record || !record.players.some((p) => p.playerId === req.user.id)) {
      return errorResponse(res, 404, 'NOT_FOUND', `No room found for id '${id}'`)
    }

    if (zodiac !== null && !isValidZodiac(zodiac)) {
      return errorResponse(res, 400, 'VALIDATION_ERROR', "'zodiac' must be one of the 12 real zodiac keys, or null")
    }

    if (!JOINABLE_STATUSES.includes(record.status)) {
      return errorResponse(res, 409, 'ALREADY_STARTED', `Room '${record.id}' is not in a state that accepts zodiac changes (status: ${record.status})`)
    }

    // Duplicates across players deliberately allowed — no uniqueness check
    // here. playerColor() (frontend, cycles by turnOrder) is what makes two
    // players who picked the same animal visually distinct, by design.
    const players = record.players.map((p) => (p.playerId === req.user.id ? { ...p, zodiac } : p))
    const updated = await roomRepository.updateRoom(supabase, record.id, { ...record, players }, record)
    notifyRoomUpdated(req, updated)
    return res.status(200).json(toRoomResponse(updated))
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/v1/rooms/:id/start — API_CONTRACT.md. Host only.
 */
export async function startGame(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const { id } = req.params
    const record = await roomRepository.getRoomById(supabase, id)

    if (!record || !record.players.some((p) => p.playerId === req.user.id)) {
      return errorResponse(res, 404, 'NOT_FOUND', `No room found for id '${id}'`)
    }

    if (record.hostId !== req.user.id) {
      return errorResponse(res, 403, 'NOT_HOST', 'Only the room host can start the game')
    }

    if (record.players.length < MIN_PLAYERS || record.players.length > MAX_PLAYERS) {
      return errorResponse(
        res,
        409,
        'INVALID_PLAYER_COUNT',
        `Player count must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}, got ${record.players.length}`
      )
    }

    if (!allNonHostPlayersReady(record.players)) {
      return errorResponse(res, 409, 'NOT_ALL_READY', 'Not every non-host player is ready')
    }

    if (record.status !== 'ready_check') {
      return errorResponse(res, 409, 'ALREADY_STARTED', `Room '${record.id}' is not startable (status: ${record.status})`)
    }

    const gameId = crypto.randomUUID()
    const boardTilesByBoard = req.app.get('boardTilesByBoard')
    const roomRuleset = resolveRuleset(record)
    const gameState = initializeGameState({ gameId, roomId: record.id, ruleset: roomRuleset, players: record.players, boardTilesByBoard })

    let nextRecord = transitionRoom(record, { type: 'HOST_START' })
    nextRecord = transitionRoom(nextRecord, { type: 'ENGINE_INITIALIZED' })

    try {
      await gameRepository.saveSnapshot(supabase, gameState, 'turn_end')
    } catch (err) {
      // Tolerated, not fatal — the in-memory game below is fully playable
      // without a snapshot; only surviving a server restart depends on it.
      // Logged loudly because that IS the failure mode behind rooms found
      // stuck `in_progress` with no recoverable game (docs/PROJECT_STATUS.md
      // records a real one): snapshot lost, server later restarts, the hot
      // store is empty and there is nothing to resume from.
      console.error(
        `startGame: failed to persist initial snapshot for game '${gameId}' — the match will run but CANNOT survive a server restart:`,
        err.message
      )
    }

    // Room status is persisted BEFORE the game enters the in-memory hot
    // store (2026-08-23 — this ordering was the other way round). Every
    // later C2S_GAME_ACTION checks the DURABLE room row first
    // (socketServer.js's own ROOM_NOT_IN_PROGRESS guard), so publishing a
    // live game while that row still said the room hadn't started produced
    // a permanently unplayable match: the game exists and broadcasts, but
    // every action anyone takes is rejected, with no way back. Persisting
    // first means a failure here simply aborts the start — nothing is left
    // half-created, and the host can just press Start again.
    await roomRepository.updateRoom(supabase, record.id, nextRecord, record)
    gameRepository.setGameState(record.id, gameState)
    notifyRoomUpdated(req, nextRecord)

    return res.status(201).json({
      gameId: gameState.id,
      boardId: gameState.boardId,
      status: gameState.status,
      startedAt: gameState.startedAt,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/v1/rooms/:id/leave — GAME_DESIGN_SPEC.md §4's `leave_room`,
 * API_CONTRACT.md's own `POST /:id/leave` entry (wired 2026-08-21, closing
 * `SECURITY_DESIGN.md`-adjacent "Known gaps" #2's REST-half). Pre-game only
 * — "leaving mid-match is not this endpoint, it's a disconnect
 * (GAME_STATE_MACHINE.md §5), a different mechanism entirely, on purpose"
 * (API_CONTRACT.md's own words) — a disconnect is already handled by
 * `infrastructure/websocket/socketServer.js`'s `handleDisconnect`, untouched
 * here.
 */
export async function leaveRoom(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const { id } = req.params
    const record = await roomRepository.getRoomById(supabase, id)

    if (!record || !record.players.some((p) => p.playerId === req.user.id)) {
      return errorResponse(res, 404, 'NOT_FOUND', `No room found for id '${id}'`)
    }

    if (!JOINABLE_STATUSES.includes(record.status)) {
      return errorResponse(res, 409, 'ALREADY_STARTED', `Room '${record.id}' is not in a state that allows leaving (status: ${record.status})`)
    }

    const remainingPlayers = record.players.filter((p) => p.playerId !== req.user.id)
    // GAME_DESIGN_SPEC.md §4: "If sender was host, host role transfers to
    // the next-joined player" — array order is join order (createRoom
    // pushes the creator first, joinRoom appends every later joiner), so
    // the new first element is exactly that "next-joined" player. An empty
    // room (the last player leaving) is left as-is, players: [] — no
    // delete-room operation exists in roomRepository.js, and this project's
    // own §18 "Abandoned" match-ending condition is still its own separate,
    // unbuilt, [OPEN DESIGN DECISION] — not something this endpoint should
    // silently start deciding.
    const wasHost = record.hostId === req.user.id
    const players = wasHost && remainingPlayers.length > 0
      ? remainingPlayers.map((p, index) => (index === 0 ? { ...p, isHost: true } : p))
      : remainingPlayers
    const hostId = wasHost && remainingPlayers.length > 0 ? players[0].playerId : record.hostId

    const afterLeave = await roomRepository.updateRoom(supabase, record.id, { ...record, players, hostId }, record)
    notifyRoomUpdated(req, afterLeave ?? { ...record, players, hostId })
    return res.status(200).json({ success: true })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/v1/rooms/:id/kick — GAME_DESIGN_SPEC.md §4's `kick_player`
 * (host only), wired 2026-08-21, closing `SECURITY_DESIGN.md`-adjacent
 * "Known gaps" #2's REST-half — the rule existed since Phase 04 but had no
 * endpoint. Not itself in `API_CONTRACT.md` (that document's own Rooms
 * section never enumerated it), so this route/response shape is new,
 * modeled directly on `leaveRoom`'s own already-approved `{ success: true }`
 * response and `startGame`'s already-approved host-check pattern, rather
 * than inventing an unrelated third shape.
 * @param {object} req - req.body.targetPlayerId names who to remove (profiles.id, same id space every other player-identifying field in this file already uses — never a client-asserted display name)
 */
export async function kickPlayer(req, res, next) {
  try {
    const supabase = req.app.get('supabase')
    const { id } = req.params
    const { targetPlayerId } = req.body ?? {}

    const record = await roomRepository.getRoomById(supabase, id)
    if (!record || !record.players.some((p) => p.playerId === req.user.id)) {
      return errorResponse(res, 404, 'NOT_FOUND', `No room found for id '${id}'`)
    }

    if (record.hostId !== req.user.id) {
      return errorResponse(res, 403, 'NOT_HOST', 'Only the room host can kick a player')
    }

    if (typeof targetPlayerId !== 'string' || targetPlayerId.length === 0) {
      return errorResponse(res, 400, 'VALIDATION_ERROR', "'targetPlayerId' is required")
    }

    if (targetPlayerId === record.hostId) {
      return errorResponse(res, 400, 'CANNOT_KICK_HOST', 'The host cannot kick themselves')
    }

    if (!record.players.some((p) => p.playerId === targetPlayerId)) {
      return errorResponse(res, 404, 'NOT_FOUND', `'${targetPlayerId}' is not a member of room '${record.id}'`)
    }

    if (!JOINABLE_STATUSES.includes(record.status)) {
      return errorResponse(res, 409, 'ALREADY_STARTED', `Room '${record.id}' is not in a state that allows kicking (status: ${record.status})`)
    }

    const players = record.players.filter((p) => p.playerId !== targetPlayerId)
    const afterKick = await roomRepository.updateRoom(supabase, record.id, { ...record, players }, record)
    notifyRoomUpdated(req, afterKick ?? { ...record, players })
    return res.status(200).json({ success: true })
  } catch (err) {
    next(err)
  }
}

export { MAX_PLAYERS, MIN_PLAYERS, ROOM_STATUSES };
