import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  createSocketAuthMiddleware,
  handleJoinRoom,
  handleGameAction,
  handleDisconnect,
  handleReconnect,
  initSocketServer,
  isOffline,
  activeTurnTimerDeadline,
  serverGeneratedFields,
  _resetForTests as resetSocketServerState,
} from './socketServer.js';
import { createGameState, createPlayerGameState } from '../../domain/gameState.js';
import { createTile } from '../../domain/tile.js';
import { createProperty } from '../../domain/property.js';
import { startAuction } from '../../engine/auction.js';
import { setGameState, getGameState, _resetForTests as resetGameRepository } from '../../infrastructure/repositories/gameRepository.js';
import { TIMER_DURATIONS_SECONDS } from '../../stateMachine/timers.js';
import { TEST_JWK, signEs256 } from '../../testUtils/testEs256.js';
import { createFakeSupabase } from '../../testUtils/fakeSupabase.js';

// Test-only fixture — not a real Supabase secret. Same helpers/shapes as
// auth/authMiddleware.test.js, adapted for Socket.IO's (socket, next)
// middleware signature instead of Express's (req, res, next).
const TEST_SECRET = 'test-secret-fixture-not-a-real-supabase-jwt-secret';

// P10-T02: GameState now lives in gameRepository.js's in-memory hot store
// (keyed by roomId), not bolted onto the room record — every test that
// exercises handleGameAction seeds it directly via setGameState() instead
// of putting `gameState` on the fake room object. Reset between tests so
// this file's many 'room-1'/'room-2' fixtures don't leak into each other.
// resetSocketServerState (P10-T03) clears idempotencyCaches/
// offlinePlayersByRoom for the same reason.
//
// P10-T04: `mock.timers.enable()` runs for *every* test in this file, not
// just the ones that directly assert on timer behavior — production
// socketServer.js schedules a real `setTimeout` via `turnTimers`
// (stateMachine/timers.js's TimerManager) whenever a broadcast lands the
// game in a timed phase (AWAITING_PURCHASE, ROLLING, ...), which several
// pre-existing tests here do incidentally. Found by actually running the
// suite after wiring the timer in: without this, those tests each leaked
// a real 15-30s `setTimeout` that kept the test process alive until it
// fired, turning a <1s suite into a 65s one. Enabling mock timers before
// resetSocketServerState() (which reconstructs `turnTimers`) is what makes
// the reconstructed instance's default `schedule = setTimeout` param
// resolve to the mock, not whatever was live at import time.
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  resetGameRepository();
  resetSocketServerState();
});

afterEach(() => {
  mock.timers.reset();
});

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken(payload, { secret = TEST_SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const headerB64 = b64url(header);
  const payloadB64 = b64url(payload);
  const signatureB64 = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function futureExp(seconds = 3600) {
  return Math.floor(Date.now() / 1000) + seconds;
}

// Minimal Socket-shaped mock — a plain object recording what was called on
// it, not a real socket.io Socket or network connection.
function mockSocket({ token } = {}) {
  const listeners = {};
  return {
    handshake: { auth: { token } },
    user: undefined,
    roomId: undefined,
    _emitted: [],
    _joined: [],
    _toEmitted: [], // P10-T03: socket.to(room).emit(...) calls — broadcasts that exclude this socket itself
    emit(event, payload) {
      this._emitted.push({ event, payload });
    },
    join(room) {
      this._joined.push(room);
    },
    to(room) {
      return {
        emit: (event, payload) => this._toEmitted.push({ room, event, payload }),
      };
    },
    on(event, handler) {
      listeners[event] = handler;
    },
    // test-only helper: invoke a handler registered via on() above.
    // Returns the handler's own return value (a Promise, now that
    // handleJoinRoom/handleGameAction's listeners are async — real I/O via
    // roomRepository/gameRepository) so callers can `await` it.
    _trigger(event, payload) {
      return listeners[event](payload);
    },
  };
}

function mockNext() {
  const calls = [];
  const next = (...args) => calls.push(args);
  next.callCount = () => calls.length;
  next.lastError = () => calls[calls.length - 1]?.[0];
  return next;
}

// getRoomById now takes (supabase, id) — the fake ignores supabase
// entirely, same as every other fake repository in this file.
function fakeRoomRepository(roomsById) {
  return { getRoomById: async (_supabase, id) => roomsById[id] ?? null };
}

// ---- createSocketAuthMiddleware ----

test('createSocketAuthMiddleware throws without a secret', () => {
  assert.throws(() => createSocketAuthMiddleware(''));
  assert.throws(() => createSocketAuthMiddleware(undefined));
});

test('successful connection: a valid token sets socket.user and calls next with no error', () => {
  const middleware = createSocketAuthMiddleware(TEST_SECRET);
  const token = makeToken({ sub: 'user-42', exp: futureExp() });
  const socket = mockSocket({ token });
  const next = mockNext();

  middleware(socket, next);

  assert.equal(next.callCount(), 1);
  assert.equal(next.lastError(), undefined);
  assert.deepEqual(socket.user, { id: 'user-42' });
});

test('rejected connection: a missing token calls next with an Authentication error, socket.user unset', () => {
  const middleware = createSocketAuthMiddleware(TEST_SECRET);
  const socket = mockSocket({ token: undefined });
  const next = mockNext();

  middleware(socket, next);

  assert.equal(next.callCount(), 1);
  assert.ok(next.lastError() instanceof Error);
  assert.equal(next.lastError().message, 'Authentication error');
  assert.equal(socket.user, undefined);
});

test('rejected connection: an invalid (wrong-signature) token is rejected the same way', () => {
  const middleware = createSocketAuthMiddleware(TEST_SECRET);
  const token = makeToken({ sub: 'user-1', exp: futureExp() }, { secret: 'wrong-secret' });
  const socket = mockSocket({ token });
  const next = mockNext();

  middleware(socket, next);

  assert.equal(next.callCount(), 1);
  assert.ok(next.lastError() instanceof Error);
  assert.equal(socket.user, undefined);
});

test('rejected connection: an expired token is rejected the same way', () => {
  const middleware = createSocketAuthMiddleware(TEST_SECRET);
  const token = makeToken({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 3600 });
  const socket = mockSocket({ token });
  const next = mockNext();

  middleware(socket, next);

  assert.ok(next.lastError() instanceof Error);
});

// ---- createSocketAuthMiddleware: { getKey } config (ES256/JWKS) — P11-T03 ----
// A second, independent configuration of the same factory — every test
// above (bare TEST_SECRET, HS256) is untouched.

function fakeGetKey(jwk = TEST_JWK) {
  return async (kid) => (kid === jwk.kid ? jwk : null);
}

test('createSocketAuthMiddleware throws with an empty config object (neither secret nor getKey)', () => {
  assert.throws(() => createSocketAuthMiddleware({}));
});

test('{ getKey } config: a valid ES256 token sets socket.user and calls next with no error', async () => {
  const middleware = createSocketAuthMiddleware({ getKey: fakeGetKey() });
  const token = signEs256({ sub: 'user-42', exp: futureExp() });
  const socket = mockSocket({ token });
  const next = mockNext();

  await middleware(socket, next);

  assert.equal(next.callCount(), 1);
  assert.equal(next.lastError(), undefined);
  assert.deepEqual(socket.user, { id: 'user-42' });
});

test('{ getKey } config: an HS256 token is rejected — this middleware instance only trusts ES256', async () => {
  const middleware = createSocketAuthMiddleware({ getKey: fakeGetKey() });
  const token = makeToken({ sub: 'user-1', exp: futureExp() });
  const socket = mockSocket({ token });
  const next = mockNext();

  await middleware(socket, next);

  assert.ok(next.lastError() instanceof Error);
  assert.equal(socket.user, undefined);
});

test('{ getKey } config: an unrecognized kid is rejected the same way', async () => {
  const middleware = createSocketAuthMiddleware({ getKey: fakeGetKey() });
  const token = signEs256({ sub: 'user-1', exp: futureExp() }, { header: { kid: 'rotated-away' } });
  const socket = mockSocket({ token });
  const next = mockNext();

  await middleware(socket, next);

  assert.ok(next.lastError() instanceof Error);
  assert.equal(socket.user, undefined);
});

// ---- handleJoinRoom / C2S_JOIN_ROOM ----

test('C2S_JOIN_ROOM success: a participant joins the socket room and receives S2C_ROOM_JOINED', async () => {
  const roomRepository = fakeRoomRepository({
    'room-1': {
      id: 'room-1',
      status: 'waiting_for_players',
      players: [
        { playerId: 'user-42', isHost: true },
        { playerId: 'user-7', isHost: false },
      ],
    },
  });
  const socket = mockSocket();
  socket.user = { id: 'user-42' };

  handleJoinRoom({}, socket, roomRepository, undefined);
  await socket._trigger('C2S_JOIN_ROOM', { roomId: 'room-1' });

  assert.deepEqual(socket._joined, ['room-1']);
  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].event, 'S2C_ROOM_JOINED');
  assert.deepEqual(socket._emitted[0].payload, {
    roomId: 'room-1',
    playerId: 'user-42',
    members: ['user-42', 'user-7'],
    roomStatus: 'waiting_for_players',
  });
});

test('C2S_JOIN_ROOM failure: a non-participant is rejected and never joins the socket room', async () => {
  const roomRepository = fakeRoomRepository({
    'room-1': { id: 'room-1', status: 'waiting_for_players', players: [{ playerId: 'user-42', isHost: true }] },
  });
  const socket = mockSocket();
  socket.user = { id: 'user-stranger' };

  handleJoinRoom({}, socket, roomRepository, undefined);
  await socket._trigger('C2S_JOIN_ROOM', { roomId: 'room-1' });

  assert.deepEqual(socket._joined, []);
  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].event, 'S2C_ACTION_REJECTED');
  assert.equal(socket._emitted[0].payload.errorCode, 'NOT_A_PARTICIPANT');
});

test('C2S_JOIN_ROOM failure: a non-existent roomId is rejected with the same code (no existence leak)', async () => {
  const roomRepository = fakeRoomRepository({});
  const socket = mockSocket();
  socket.user = { id: 'user-42' };

  handleJoinRoom({}, socket, roomRepository, undefined);
  await socket._trigger('C2S_JOIN_ROOM', { roomId: 'no-such-room' });

  assert.deepEqual(socket._joined, []);
  assert.equal(socket._emitted[0].payload.errorCode, 'NOT_A_PARTICIPANT');
});

test('C2S_JOIN_ROOM ignores any client-supplied playerId — only socket.user.id is ever used', async () => {
  const roomRepository = fakeRoomRepository({
    'room-1': { id: 'room-1', status: 'waiting_for_players', players: [{ playerId: 'user-42', isHost: true }] },
  });
  const socket = mockSocket();
  socket.user = { id: 'user-42' };

  handleJoinRoom({}, socket, roomRepository, undefined);
  // A spoofed playerId in the payload is simply not read anywhere.
  await socket._trigger('C2S_JOIN_ROOM', { roomId: 'room-1', playerId: 'user-someone-else' });

  assert.equal(socket._emitted[0].event, 'S2C_ROOM_JOINED');
  assert.equal(socket._emitted[0].payload.playerId, 'user-42');
});

// ---- initSocketServer ----

test('initSocketServer: wires auth middleware and the connection handler without binding a real port', () => {
  // A real (but never-.listen()-ing) http.Server — deliberately not
  // starting a listener, per the task's "do not bind to a real network
  // port" constraint. Passing this rather than undefined avoids
  // socket.io's own internal default-server bootstrapping path, which
  // does async setup/teardown unrelated to what this test verifies.
  const httpServer = http.createServer();
  const roomRepository = fakeRoomRepository({});
  const io = initSocketServer(httpServer, roomRepository, TEST_SECRET, undefined);

  assert.ok(io);
  io.close();
});

test('initSocketServer: without a jwtSecret, returns a real io instance instead of throwing (server must still boot)', () => {
  // Regression coverage: this used to throw (createSocketAuthMiddleware's
  // own guard, called unconditionally), which meant `node src/server.js`
  // crashed outright whenever SUPABASE_JWT_SECRET wasn't set — this
  // project's actual current environment. Found via a real boot smoke
  // test, not a unit test, since every other test here always supplies a
  // secret.
  const httpServer = http.createServer();
  const roomRepository = fakeRoomRepository({});

  const io = initSocketServer(httpServer, roomRepository, '', undefined);

  assert.ok(io);
  io.close();
});

// ---- handleGameAction / C2S_GAME_ACTION ----

// Read-only — handleGameAction no longer calls roomRepository.updateRoom()
// at all (P10-T02: GameState moved to gameRepository.js's own store, see
// this file's top comment). getRoomById(supabase, id) is still the
// participant/status gate.
function fakeGameRoomRepository(roomsById) {
  return { getRoomById: async (_supabase, id) => (roomsById[id] ? structuredClone(roomsById[id]) : null) };
}

// A room mid-game, sitting in FLASH_AUCTION_ACTIVE with two eligible
// bidders — real domain/gameState.js + engine/auction.js objects, not ad
// hoc fixtures, so this exercises the real transitionTurn()/
// applyWithIdempotency() pipeline. Player identity deliberately uses two
// different id spaces, matching production: room.players[].playerId /
// gameState.players[].playerId are the auth (profiles) id
// ('user-alice'/'user-bob'); gameState.players[].id is the separate
// PlayerGameState id ('gp-alice'/'gp-bob') that auction.js's
// activeBidders and turnMachine.js's lookups actually key on.
function buildAuctionGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'user-bob', turnOrder: 1, currentBalance: 1500 }),
  ];
  // `bankId` is required as of Auction V2 ("Nhà Môi Giới", 2026-09-01) — the
  // Bank funds the initiator's broker commission on SETTLED, so resolveAuction
  // needs to name it in the settlement intents. This shared fixture had not
  // been updated, which was the single root cause of every failure in this
  // file (`TypeError: startAuction: bankId is required for V2 commission
  // settlement`) — none of them were about the behaviour each test asserts.
  const pendingAuction = startAuction('property-1', 200, 'gp-alice', ['gp-alice', 'gp-bob'], 'gp-bank');
  return createGameState({
    id: 'g1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'FLASH_AUCTION_ACTIVE',
    currentTurnIndex: 0,
    stateVersion: 0,
    players,
    properties: [],
    pendingAuction,
    startedAt: '2026-08-18T00:00:00.000Z',
  });
}

function buildAuctionRoom() {
  return {
    id: 'room-1',
    status: 'in_progress',
    hostId: 'user-alice',
    players: [
      { playerId: 'user-alice', isHost: true },
      { playerId: 'user-bob', isHost: false },
    ],
  };
}

function fakeIo() {
  const broadcasts = [];
  return {
    to(room) {
      return {
        emit(event, payload) {
          broadcasts.push({ room, event, payload });
        },
      };
    },
    _broadcasts: broadcasts,
  };
}

test('C2S_GAME_ACTION success: a valid bid updates state and broadcasts S2C_STATE_UPDATE to the room', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'action-1',
  });

  assert.equal(socket._emitted.length, 0); // no rejection sent to the sender directly
  assert.equal(io._broadcasts.length, 1);
  const broadcast = io._broadcasts[0];
  assert.equal(broadcast.room, 'room-1');
  assert.equal(broadcast.event, 'S2C_STATE_UPDATE');
  assert.equal(broadcast.payload.gameState.pendingAuction.currentBid, 250);
  assert.equal(broadcast.payload.gameState.pendingAuction.highestBidderId, 'gp-bob'); // resolved from user-bob
  assert.equal(broadcast.payload.stateVersion, 1); // applyWithIdempotency's own increment
  assert.deepEqual(broadcast.payload.transactions, []); // bidding moves no money

  // Persisted to the in-memory hot store, not just broadcast. Not a
  // durable Supabase snapshot — PLACE_BID isn't one of the three approved
  // snapshot triggers (gameRepository.js's deriveSnapshotReason).
  const stored = getGameState('room-1');
  assert.equal(stored.pendingAuction.currentBid, 250);
});

test('C2S_GAME_ACTION domain error: bidding too low is rejected to the sender, state unchanged', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 200 }, // does not exceed currentBid (200)
    clientActionId: 'action-2',
  });

  assert.equal(io._broadcasts.length, 0); // nothing broadcast to the room
  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].event, 'S2C_ACTION_REJECTED');
  assert.equal(socket._emitted[0].payload.clientActionId, 'action-2');
  assert.equal(socket._emitted[0].payload.errorCode, 'BID_TOO_LOW');

  const stored = getGameState('room-1');
  assert.equal(stored.pendingAuction.currentBid, 200); // untouched
  assert.equal(stored.stateVersion, 0); // untouched — rejected actions never advance it
});

test('C2S_GAME_ACTION auth error: a player not in the room is rejected with NOT_A_PARTICIPANT', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-stranger' };

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'action-3',
  });

  assert.equal(io._broadcasts.length, 0);
  assert.equal(socket._emitted[0].event, 'S2C_ACTION_REJECTED');
  assert.equal(socket._emitted[0].payload.errorCode, 'NOT_A_PARTICIPANT');
});

test('C2S_GAME_ACTION: a room that is not in_progress is rejected with ROOM_NOT_IN_PROGRESS', async () => {
  // PERF change 2026-09-03: the handler no longer re-fetches the room record
  // on every action — it trusts the hot in-memory GameState, and only falls
  // back to getRoomById on a cold miss. So this scenario (room still in
  // ready_check) can only be reached with NO hot state, which is also the
  // only way it can actually occur: startGame writes the room status and the
  // game state together, so hot state + a pre-start room status is not a
  // real combination. No setGameState() here.
  const room = { ...buildAuctionRoom(), status: 'ready_check' };
  const roomRepository = fakeGameRoomRepository({ 'room-1': room });
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  handleGameAction(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', { roomId: 'room-1', actionType: 'PLACE_BID', payload: { amount: 250 } });

  assert.equal(socket._emitted[0].payload.errorCode, 'ROOM_NOT_IN_PROGRESS');
});

test('C2S_GAME_ACTION: with hot game state, the room record is NOT re-fetched (perf, 2026-09-03)', async () => {
  // The per-action getRoomById was the biggest latency source in the
  // deployed game (two sequential cross-region Supabase queries before the
  // engine ran). This pins that it is gone on the hot path.
  let getRoomByIdCalls = 0;
  const roomRepository = {
    getRoomById: async (_s, id) => {
      getRoomByIdCalls += 1;
      return structuredClone(buildAuctionRoom());
    },
  };
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'perf-1',
  });

  assert.equal(getRoomByIdCalls, 0, 'getRoomById must not run when hot game state is present');
  assert.equal(io._broadcasts.length, 1);
  assert.equal(io._broadcasts[0].payload.gameState.pendingAuction.currentBid, 250);
});

test('C2S_GAME_ACTION: a room in_progress with no hot-loaded or durable game state is rejected with GAME_NOT_FOUND', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  // Deliberately no setGameState() call — simulates a cold process with no
  // durable snapshot either; loadGameStateFromSupabase would be the next
  // fallback, but there's no supabase client here (undefined), so this
  // also exercises that codepath's own null-client guard.
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  handleGameAction(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', { roomId: 'room-1', actionType: 'PLACE_BID', payload: { amount: 250 } });

  assert.equal(socket._emitted[0].payload.errorCode, 'GAME_NOT_FOUND');
});

test('C2S_GAME_ACTION: a game whose status has already left in_progress is rejected with GAME_ALREADY_FINISHED, even though its room still reads in_progress (Win Condition design, 2026-08-19)', async () => {
  // The real gap this guards: ROOM_STATUSES has no 'finished' value at
  // all, so a room can legitimately still say 'in_progress' after the
  // game inside it has already ended (gameState.status transitions
  // independently, in turnMachine.js's settleGameEnd()) — the
  // ROOM_NOT_IN_PROGRESS check above this one in the handler cannot catch
  // this case by itself.
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() }); // room.status still 'in_progress'
  setGameState('room-1', { ...buildAuctionGameState(), status: 'finished', phase: null, endReason: 'elimination' });
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  handleGameAction(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', { roomId: 'room-1', actionType: 'END_TURN', clientActionId: 'action-1' });

  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].payload.errorCode, 'GAME_ALREADY_FINISHED');
  assert.equal(socket._emitted[0].payload.clientActionId, 'action-1');
  // Confirm this is genuinely rejected before any transitionFn/broadcast —
  // not silently accepted and then a no-op.
  assert.equal(getGameState('room-1').status, 'finished');
});

// ---- SECURITY_DESIGN.md "Known gaps" #5, found 2026-08-18, fixed 2026-08-21:
// turn-ownership enforcement. Every turnMachine.js handler resolves the
// acting player via its own internal getCurrentPlayer(gameState), never
// cross-checked against who actually sent the socket message — these tests
// prove the new pre-dispatch guard actually closes that, without breaking
// the two deliberate exemptions (FLASH_AUCTION_ACTIVE's any-eligible-bidder
// rule, and trade's own separate NOT_TARGET/NOT_PROPOSER model).

function buildTwoPlayerPostActionsGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'user-bob', turnOrder: 1, currentBalance: 1500 }),
  ];
  return createGameState({
    id: 'g1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    currentTurnIndex: 0, // Alice's turn
    stateVersion: 0,
    players,
    properties: [],
    startedAt: '2026-08-18T00:00:00.000Z',
  });
}

test('C2S_GAME_ACTION: a stale lastSeenStateVersion is rejected with STALE_ACTION, before any dispatch (GAME_STATE_MACHINE.md §6 point 2, wired 2026-08-21)', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', { ...buildAuctionGameState(), stateVersion: 5 });
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'action-1',
    lastSeenStateVersion: 3, // stale — the room is actually at 5
  });

  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].payload.errorCode, 'STALE_ACTION');
  assert.equal(io._broadcasts.length, 0); // never dispatched
});

test('C2S_GAME_ACTION: a matching lastSeenStateVersion is accepted normally', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', { ...buildAuctionGameState(), stateVersion: 5 });
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'action-1',
    lastSeenStateVersion: 5, // matches exactly
  });

  assert.equal(socket._emitted.length, 0);
  assert.equal(io._broadcasts.length, 1);
});

test('C2S_GAME_ACTION: omitting lastSeenStateVersion entirely is unaffected — backward compatible with every client that never sends it', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', { ...buildAuctionGameState(), stateVersion: 5 });
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', { roomId: 'room-1', actionType: 'PLACE_BID', payload: { amount: 250 }, clientActionId: 'action-1' });

  assert.equal(socket._emitted.length, 0);
  assert.equal(io._broadcasts.length, 1);
});

test('C2S_GAME_ACTION: a turn-scoped action from a participant who is NOT the current-turn player is rejected with NOT_YOUR_TURN, before any dispatch', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildTwoPlayerPostActionsGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' }; // gp-bob, turnOrder 1 — it's Alice's turn (currentTurnIndex 0)

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', { roomId: 'room-1', actionType: 'END_TURN', clientActionId: 'action-1' });

  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].payload.errorCode, 'NOT_YOUR_TURN');
  assert.equal(socket._emitted[0].payload.clientActionId, 'action-1');
  assert.equal(io._broadcasts.length, 0); // rejected before transitionFn/persistAndBroadcast ever ran
  // Not a theft/silent-success surface either — the stored state is
  // genuinely untouched, not just "no broadcast happened to fire".
  assert.equal(getGameState('room-1').stateVersion, 0);
  assert.equal(getGameState('room-1').phase, 'POST_ACTIONS');
});

test('C2S_GAME_ACTION: PLACE_BID/FOLD_AUCTION during FLASH_AUCTION_ACTIVE are exempt from the turn-ownership guard — any eligible bidder may act regardless of currentTurnIndex', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState()); // currentTurnIndex 0 = Alice; both Alice and Bob are active bidders
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' }; // gp-bob, turnOrder 1 — NOT the current-turn player

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', { roomId: 'room-1', actionType: 'FOLD_AUCTION', payload: {}, clientActionId: 'fold-1' });

  assert.equal(socket._emitted.length, 0); // not rejected — specifically not NOT_YOUR_TURN
  assert.equal(io._broadcasts.length, 1);
  // Folding down to the last remaining bidder (Alice) resolves the auction
  // immediately — confirms this reached the real transitionTurn dispatch,
  // not just "didn't throw".
  assert.equal(io._broadcasts[0].payload.gameState.pendingAuction, null);
});

test('C2S_GAME_ACTION: trade actions are exempt from the turn-ownership guard — a non-current-turn player can still PROPOSE_TRADE', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildTradeGameState()); // currentTurnIndex 0 = Alice
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' }; // gp-bob, turnOrder 1 — NOT the current-turn player

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PROPOSE_TRADE',
    payload: {
      targetId: 'gp-alice',
      proposerOffer: { properties: [], money: 100 },
      targetOffer: { properties: ['p1'], money: 0 },
    },
    clientActionId: 'propose-action-2',
  });

  assert.equal(socket._emitted.length, 0); // not rejected — specifically not NOT_YOUR_TURN
  assert.equal(io._broadcasts.length, 1);
  assert.equal(io._broadcasts[0].payload.gameState.pendingTrades[0].proposerId, 'gp-bob'); // resolved from user-bob
});

test('C2S_GAME_ACTION: a room in LIQUIDATION_REQUIRED still gates SELL_HOUSE/MORTGAGE to the current-turn player (the debtor)', async () => {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 5 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'user-bob', turnOrder: 1, currentBalance: 1500 }),
  ];
  const properties = [createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-alice' })];
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'LIQUIDATION_REQUIRED',
    currentTurnIndex: 0, // Alice is the debtor and the current-turn player
    stateVersion: 0,
    players,
    properties,
    pendingLiquidation: { debtorId: 'gp-alice', creditorId: 'gp-bank', amount: 50, transactionType: 'tax' },
    startedAt: '2026-08-18T00:00:00.000Z',
  });
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', gameState);
  const socket = mockSocket();
  socket.user = { id: 'user-bob' }; // not the debtor — trying to mortgage Alice's own property away from her

  handleGameAction(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'MORTGAGE',
    payload: { propertyId: 'p1' },
    clientActionId: 'action-1',
  });

  assert.equal(socket._emitted[0].payload.errorCode, 'NOT_YOUR_TURN');
  assert.equal(getGameState('room-1').properties[0].mortgaged, false);
});

test('C2S_GAME_ACTION: a real bankruptcy-to-elimination win persists match_results through the real socket pipeline (Win Condition design, wired 2026-08-21)', async () => {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500 }),
    // $0 cash, owns nothing — checkSolvency finds zero liquidatable value,
    // so this is genuine bankruptcy, not LIQUIDATION_REQUIRED, same fixture
    // shape turnMachine.test.js's own "genuinely bankrupt" PAY_JAIL_FINE
    // tests already use.
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'user-bob', turnOrder: 1, currentBalance: 0, inJail: true, jailTurns: 1 }),
  ];
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'JAIL_DECISION',
    currentTurnIndex: 1, // Bob's turn
    players,
    properties: [],
    startedAt: '2026-08-21T00:00:00.000Z',
  });
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() }); // has both user-alice/user-bob as members
  setGameState('room-1', gameState);
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };
  const supabase = createFakeSupabase();

  handleGameAction(io, socket, roomRepository, supabase);
  await socket._trigger('C2S_GAME_ACTION', { roomId: 'room-1', actionType: 'PAY_JAIL_FINE', payload: {}, clientActionId: 'action-1' });

  const finalState = io._broadcasts[0].payload.gameState;
  assert.equal(finalState.status, 'finished');
  assert.equal(finalState.endReason, 'elimination');
  assert.equal(finalState.players.find((p) => p.id === 'gp-alice').finalRank, 1);

  // The actual point of this test: match_results was genuinely written via
  // the real persistAndBroadcast pipeline, not just computed in memory —
  // gameRepository.saveMatchResult's own unit tests already cover its
  // logic in isolation; this confirms handleGameAction really calls it.
  const rows = supabase._tables.get('match_results');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].game_id, 'g1');
  assert.equal(rows[0].result_type, 'elimination_win');
  assert.equal(rows[0].winner_game_player_id, 'gp-alice');
});

test('C2S_GAME_ACTION: a repeated clientActionId is deduped, not reapplied — still broadcasts, state unchanged', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };
  handleGameAction(io, socket, roomRepository, undefined);

  const message = { roomId: 'room-1', actionType: 'PLACE_BID', payload: { amount: 250 }, clientActionId: 'dup-1' };
  await socket._trigger('C2S_GAME_ACTION', message);
  await socket._trigger('C2S_GAME_ACTION', message); // same clientActionId again

  assert.equal(io._broadcasts.length, 2); // re-acknowledged both times, per WEBSOCKET_API.md
  assert.equal(io._broadcasts[0].payload.stateVersion, 1);
  assert.equal(io._broadcasts[1].payload.stateVersion, 1); // not incremented a second time
});

// ---- Rent Risk Choice (BOARD_SPECIFICATION.md), REVISED 2026-08-25 ----
// Constructed with rent already settled and a pendingRentGamble sitting
// there unclaimed, same "directly build the mid-flow state" convention
// buildAuctionGameState()/buildTradeGameState() already use above, rather
// than driving a real ROLL_DICE landing through the socket layer just to
// reach it. Phase is deliberately POST_ACTIONS, not some special decision
// phase — GAMBLE_RENT is non-blocking now, so there is no phase of its own
// to be "in".
function buildRentGambleGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1490 }), // already paid the $10 rent
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'user-bob', turnOrder: 1, currentBalance: 1510 }), // already received it
  ];
  const properties = [createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-bob' })];
  return createGameState({
    id: 'g1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    currentTurnIndex: 0, // Alice's turn — she was the payer, landed on Bob's property, already settled
    stateVersion: 0,
    players,
    properties,
    pendingRentGamble: { propertyId: 'p1', ownerId: 'gp-bob', payerId: 'gp-alice', amount: 10 },
    startedAt: '2026-08-21T00:00:00.000Z',
  });
}

test('C2S_GAME_ACTION GAMBLE_RENT: the server generates gambleRoll itself — a client-claimed value is fully discarded', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildRentGambleGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' }; // the owner — NOT the current-turn player (Alice)

  // Client claims a guaranteed-win roll (0); real randomSource forces a loss (0.9).
  handleGameAction(io, socket, roomRepository, undefined, {}, () => 0.9);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'GAMBLE_RENT',
    payload: { gambleRoll: 0 },
    clientActionId: 'action-1',
  });

  assert.equal(socket._emitted.length, 0); // not rejected by the turn-ownership guard — Bob isn't the current player, but this action is exempt
  const { gameState } = io._broadcasts[0].payload;
  // The REAL (losing) roll won, not the client's claimed one — Bob loses
  // the $10 he already collected back to the Bank; Alice, already settled,
  // is untouched either way.
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1490);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500);
});

// USE_INVENTORY_CARD (Card Inventory system) — the same finding-#27 rule
// every other randomised action already follows, extended to the one action
// that reached resolveChoice without it.
//
// REWRITTEN 2026-09-01, and the reason is worth recording. The original
// version of this test drove the full socket path with C11 seeded into a
// hand, relying — explicitly, in its own comment — on handleUseInventoryCard
// gating on inventory membership rather than on the card's `keepable` flag.
// That gate was itself a real bug (any card that ever reached a hand stayed
// playable forever, out of turn and out of phase) and has been fixed, so the
// old test could no longer reach the code it was guarding: it was passing
// only because of a defect elsewhere.
//
// The security property is now enforced by two independent layers, and each
// gets its own test below:
//   1. handleUseInventoryCard refuses a non-keepable card outright, so a
//      dice-carrying card cannot be played from a hand at all today.
//   2. serverGeneratedFields still overwrites a client-claimed roll — the
//      layer that matters the day C05 or C11 IS marked keepable, which is
//      exactly the scenario this hardening was written for.
// Layer 2 is unreachable end-to-end while layer 1 holds, so it is pinned by
// calling serverGeneratedFields directly rather than by faking a game state
// that could not occur.
test('USE_INVENTORY_CARD: a card that is not keepable is refused, whatever the client claims', async () => {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({
      id: 'gp-alice',
      gameId: 'g1',
      playerId: 'user-alice',
      turnOrder: 0,
      currentBalance: 1000,
      inventory: ['C11_CU_DANH_LIEU'], // a dice card, never marked keepable
    }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'user-bob', turnOrder: 1, currentBalance: 1000 }),
  ];
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState(
    'room-1',
    createGameState({
      id: 'g1',
      roomId: 'room-1',
      boardId: 'small',
      status: 'in_progress',
      phase: 'POST_ACTIONS',
      currentTurnIndex: 0,
      stateVersion: 0,
      players,
      properties: [],
      startedAt: '2026-08-27T00:00:00.000Z',
    })
  );
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  handleGameAction(io, socket, roomRepository, undefined, {}, () => 0);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'USE_INVENTORY_CARD',
    payload: { cardId: 'C11_CU_DANH_LIEU', optionId: 'OPT_GAMBLE', dieFaceRoll: 6 },
    clientActionId: 'action-1',
  });

  assert.equal(io._broadcasts.length, 0, 'nothing resolved');
  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].event, 'S2C_ACTION_REJECTED');
  assert.equal(socket._emitted[0].payload.errorCode, 'CARD_NOT_KEEPABLE');
});

test('serverGeneratedFields: USE_INVENTORY_CARD gets a server-rolled dieFaceRoll, never the client-claimed one', () => {
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    startedAt: '2026-08-27T00:00:00.000Z',
  });

  // randomSource 0 -> floor(0*6)+1 = face 1, C11's worst tier. The client
  // claims face 6 (its +$300 top tier) on the same payload.
  const injected = serverGeneratedFields(
    'USE_INVENTORY_CARD',
    gameState,
    { cardId: 'C11_CU_DANH_LIEU', optionId: 'OPT_GAMBLE', dieFaceRoll: 6 },
    () => 0
  );
  assert.equal(injected.dieFaceRoll, 1, "the server's own roll is what gets spread over the client payload");

  // And a card with no randomness gets nothing injected at all — the gating
  // is per-intent, not blanket.
  assert.deepEqual(
    serverGeneratedFields('USE_INVENTORY_CARD', gameState, { cardId: 'C07_GIAM_GIA_XAY_DUNG' }, () => 0),
    {}
  );
});

test('C2S_GAME_ACTION GAMBLE_RENT: exempt from the turn-ownership guard, AND legal outside any special phase — the owner (not the current-turn player) can respond any time', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildRentGambleGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' }; // gp-bob, turnOrder 1 — currentTurnIndex is 0 (Alice's)

  handleGameAction(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'GAMBLE_RENT',
    payload: {},
    clientActionId: 'action-1',
  });

  assert.equal(socket._emitted.length, 0); // specifically not NOT_YOUR_TURN
  assert.equal(io._broadcasts.length, 1);
  // Still POST_ACTIONS — a non-blocking side action changes no phase at all,
  // unlike the old RENT_RISK_DECISION -> POST_ACTIONS transition this replaces.
  assert.equal(io._broadcasts[0].payload.gameState.phase, 'POST_ACTIONS');
  assert.equal(io._broadcasts[0].payload.gameState.pendingRentGamble, null);
});

// ---- C2S_GAME_ACTION: trade routing (stateMachine/tradeMachine.js) ----
// Deliberately phase: FLASH_AUCTION_ACTIVE, not a POST_ACTIONS-adjacent
// phase — proves PROPOSE_TRADE/ACCEPT_TRADE actually reach
// tradeMachine.js's applyTradeAction through the real handleGameAction
// dispatch, never gated by turnMachine.js's VALID_ACTIONS_BY_PHASE (which
// would reject anything but PLACE_BID/FOLD_AUCTION/AUCTION_TIMEOUT here).
function buildTradeGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'user-bob', turnOrder: 1, currentBalance: 1500 }),
  ];
  const properties = [createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-alice' })];
  return createGameState({
    id: 'g1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'FLASH_AUCTION_ACTIVE',
    currentTurnIndex: 0,
    stateVersion: 0,
    players,
    properties,
    startedAt: '2026-08-18T00:00:00.000Z',
  });
}

test('C2S_GAME_ACTION: PROPOSE_TRADE routes to applyTradeAction and succeeds during a phase transitionTurn would reject it on', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildTradeGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };
  handleGameAction(io, socket, roomRepository, undefined);

  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PROPOSE_TRADE',
    payload: {
      targetId: 'gp-bob',
      proposerOffer: { properties: ['p1'], money: 0 },
      targetOffer: { properties: [], money: 100 },
    },
    clientActionId: 'propose-action-1',
  });

  assert.equal(socket._emitted.length, 0); // not rejected
  assert.equal(io._broadcasts.length, 1);
  const { gameState } = io._broadcasts[0].payload;
  assert.equal(gameState.phase, 'FLASH_AUCTION_ACTIVE'); // untouched by the trade action
  assert.equal(gameState.pendingTrades.length, 1);
  assert.equal(gameState.pendingTrades[0].proposerId, 'gp-alice'); // resolved from user-alice, not client-claimed
  assert.equal(gameState.pendingTrades[0].targetId, 'gp-bob');
  assert.ok(gameState.pendingTrades[0].id); // server-generated — the payload above never supplied a tradeId
});

test('C2S_GAME_ACTION: PROPOSE_TRADE then ACCEPT_TRADE atomically swaps money/property through the real socket pipeline', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildTradeGameState());
  const io = fakeIo();

  const aliceSocket = mockSocket();
  aliceSocket.user = { id: 'user-alice' };
  handleGameAction(io, aliceSocket, roomRepository, undefined);
  await aliceSocket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PROPOSE_TRADE',
    payload: {
      targetId: 'gp-bob',
      proposerOffer: { properties: ['p1'], money: 0 },
      targetOffer: { properties: [], money: 100 },
    },
    clientActionId: 'propose-action-2',
  });
  const tradeId = io._broadcasts[0].payload.gameState.pendingTrades[0].id;

  const bobSocket = mockSocket();
  bobSocket.user = { id: 'user-bob' };
  handleGameAction(io, bobSocket, roomRepository, undefined);
  await bobSocket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'ACCEPT_TRADE',
    payload: { tradeId },
    clientActionId: 'accept-action-1',
  });

  assert.equal(io._broadcasts.length, 2);
  const finalState = io._broadcasts[1].payload.gameState;
  assert.equal(finalState.pendingTrades.length, 0);
  assert.equal(finalState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 100);
  assert.equal(finalState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 - 100);
  assert.equal(finalState.properties.find((p) => p.id === 'p1').ownerId, 'gp-bob');
  assert.equal(io._broadcasts[1].payload.transactions.length, 1);
  assert.equal(io._broadcasts[1].payload.transactions[0].transactionType, 'trade');
});

// movement.js only accepts the two locked board sizes (36/44) — a real
// 36-tile 'small' board, same minimal-fixture pattern
// stateMachine/turnMachine.test.js's buildSmallBoard() uses, needed here
// specifically to prove boardTilesByBoard actually reaches transitionTurn()
// (a ROLL_DICE landing resolution can't work at all against []).
// Math.floor(x * 6) + 1 === value  <=>  x in [(value-1)/6, value/6) — same
// fixture convention engine/dice.test.js already established for rollDice()
// itself; duplicated here rather than imported since it's a two-line pure
// helper, same "not worth a shared-utils module" call socketServer.js's own
// normalizeAuthConfig() comment already made for an equally small function.
function forDie(value) {
  return (value - 1) / 6;
}

function fixedRandom(sequence) {
  let i = 0;
  return () => sequence[i++ % sequence.length];
}

function buildSmallBoard() {
  const fixed = [
    { position: 0, tileType: 'go', name: 'GO' },
    {
      position: 2,
      tileType: 'property',
      name: 'Boardwalk',
      price: 200,
      baseRent: 20,
      rentTable: [50, 150, 450, 625, 750],
      houseCost: 100,
      mortgageValue: 100,
    },
  ];
  const tiles = fixed.map((f) => createTile({ id: `t${f.position}`, boardId: 'small', ...f }));
  for (let position = 0; position < 36; position++) {
    if (tiles.some((t) => t.position === position)) continue;
    tiles.push(
      createTile({ id: `t${position}`, boardId: 'small', position, tileType: 'property', name: `Filler ${position}`, price: 80, baseRent: 4, rentTable: [20, 60, 180, 320, 450], houseCost: 50, mortgageValue: 40 })
    );
  }
  return tiles.sort((a, b) => a.position - b.position);
}

test('C2S_GAME_ACTION: boardTilesByBoard is actually threaded through to transitionTurn (ROLL_DICE lands on a real tile)', async () => {
  const board = buildSmallBoard();
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500, currentPosition: 0 }),
  ];
  const properties = [createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't2' })]; // unowned Boardwalk
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-2',
    boardId: 'small',
    status: 'in_progress',
    phase: 'ROLLING',
    currentTurnIndex: 0,
    players,
    properties,
    startedAt: '2026-08-18T00:00:00.000Z',
  });
  const room = {
    id: 'room-2',
    status: 'in_progress',
    players: [{ playerId: 'user-alice', isHost: true }],
  };

  const roomRepository = fakeGameRoomRepository({ 'room-2': room });
  setGameState('room-2', gameState);
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  // No die values in the payload at all — finding #27's fix means the
  // server generates them itself (see the dedicated authority tests right
  // below); a real ROLL_DICE click never sends one either
  // (GameControls.jsx's rollDiceAction). randomSource is fixed to 1+1=2 so
  // this test's own real concern (boardTilesByBoard reaching
  // transitionTurn) stays deterministic.
  handleGameAction(io, socket, roomRepository, undefined, { small: board }, fixedRandom([forDie(1), forDie(1)]));
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-2',
    actionType: 'ROLL_DICE',
    payload: {},
    clientActionId: 'roll-1',
  });

  assert.equal(io._broadcasts.length, 1);
  const { gameState: nextState } = io._broadcasts[0].payload;
  assert.equal(nextState.phase, 'AWAITING_PURCHASE'); // only resolvable with the real board tile at position 2
  assert.equal(nextState.players.find((p) => p.id === 'gp-alice').currentPosition, 2);
});

// ---- Finding #27 (docs/PROJECT_STATUS.md), resolved 2026-08-19: server-authoritative dice/probabilityRoll ----

test('C2S_GAME_ACTION ROLL_DICE: the server generates the roll itself — a client-claimed value is fully discarded, not merely validated', async () => {
  const board = buildSmallBoard();
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500, currentPosition: 0 }),
  ];
  // resolveTile.js's resolveBuyableTile() requires a Property row for any
  // buyable tile even when unowned (throws otherwise) — every position in
  // buildSmallBoard() other than 0 is tileType 'property', so landing
  // anywhere needs one. Position 7 is where the fixed roll below (3+4)
  // actually lands.
  const properties = [createProperty({ id: 'p7', gameId: 'g1', boardTileId: 't7' })];
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-2',
    boardId: 'small',
    status: 'in_progress',
    phase: 'ROLLING',
    currentTurnIndex: 0,
    players,
    properties,
    startedAt: '2026-08-18T00:00:00.000Z',
  });
  const room = { id: 'room-2', status: 'in_progress', players: [{ playerId: 'user-alice', isHost: true }] };

  const roomRepository = fakeGameRoomRepository({ 'room-2': room });
  setGameState('room-2', gameState);
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  // A cheating client claims a double 6 (total 12) — the biggest possible
  // favorable roll. The server's own real roll (fixed here to 3+4=7, no
  // double) must win regardless.
  handleGameAction(io, socket, roomRepository, undefined, { small: board }, fixedRandom([forDie(3), forDie(4)]));
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-2',
    actionType: 'ROLL_DICE',
    payload: { die1: 6, die2: 6, total: 12, isDouble: true, doublesStreak: 1, sentToJail: false },
    clientActionId: 'roll-1',
  });

  const { gameState: nextState } = io._broadcasts[0].payload;
  // Moved 7, landing on position 7 (a Filler tile), not 12 — proves the
  // claimed total was never used for movement.
  assert.equal(nextState.players.find((p) => p.id === 'gp-alice').currentPosition, 7);
  assert.equal(nextState.lastRollWasDouble, false); // the claimed isDouble:true was discarded too
  assert.equal(nextState.currentDoublesStreak, 0);
});

test('C2S_GAME_ACTION ATTEMPT_JAIL_ROLL: the server generates the roll itself and always starts its own doublesStreak at 0', async () => {
  const board = buildSmallBoard();
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({
      id: 'gp-alice',
      gameId: 'g1',
      playerId: 'user-alice',
      turnOrder: 0,
      currentBalance: 1500,
      currentPosition: 4, // Jail
      inJail: true,
      jailTurns: 1,
    }),
  ];
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-2',
    boardId: 'small',
    status: 'in_progress',
    phase: 'JAIL_DECISION',
    currentTurnIndex: 0,
    currentDoublesStreak: 2, // deliberately nonzero — a jail-escape roll must ignore this and always start its own streak at 0
    players,
    properties: [],
    startedAt: '2026-08-18T00:00:00.000Z',
  });
  const room = { id: 'room-2', status: 'in_progress', players: [{ playerId: 'user-alice', isHost: true }] };

  const roomRepository = fakeGameRoomRepository({ 'room-2': room });
  setGameState('room-2', gameState);
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  // Client claims a double 5 (an instant, guaranteed jail-escape) — the
  // server's real roll (fixed here to 2+3=5, not a double) must win: stays
  // in jail, no escape.
  handleGameAction(io, socket, roomRepository, undefined, { small: board }, fixedRandom([forDie(2), forDie(3)]));
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-2',
    actionType: 'ATTEMPT_JAIL_ROLL',
    payload: { die1: 5, die2: 5, total: 10, isDouble: true, doublesStreak: 3, sentToJail: false },
    clientActionId: 'roll-1',
  });

  const { gameState: nextState } = io._broadcasts[0].payload;
  const alice = nextState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, true); // the claimed double never happened for real, so no escape
  assert.equal(alice.jailTurns, 2);
});

test('C2S_GAME_ACTION MAKE_EVENT_CHOICE: server generates probabilityRoll for a PROBABILITY option — a client-claimed value is discarded', async () => {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500 }),
  ];
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-2',
    boardId: 'small',
    status: 'in_progress',
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'INVESTMENT_OPPORTUNITY', // real domain/eventDictionary.js entry: OPT_RISK has a 0.5-chance PROBABILITY intent
    currentTurnIndex: 0,
    players,
    properties: [],
    startedAt: '2026-08-18T00:00:00.000Z',
  });
  const room = { id: 'room-2', status: 'in_progress', players: [{ playerId: 'user-alice', isHost: true }] };

  const roomRepository = fakeGameRoomRepository({ 'room-2': room });
  setGameState('room-2', gameState);
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  // Client claims a guaranteed-success roll (0.01, well under the 0.5
  // chance threshold). The server's real roll (fixed here to 0.9) must
  // fail instead.
  handleGameAction(io, socket, roomRepository, undefined, {}, fixedRandom([0.9]));
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-2',
    actionType: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_RISK', probabilityRoll: 0.01 },
    clientActionId: 'choice-1',
  });

  const { gameState: nextState, transactions } = io._broadcasts[0].payload;
  // Only the $300 stake was deducted (the real, server-rolled failure
  // outcome) — the claimed win (which would net +$600) never happened.
  assert.equal(nextState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 300);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount, 300);
});

test('C2S_GAME_ACTION MAKE_EVENT_CHOICE: does not inject a probabilityRoll for an option with no PROBABILITY intent', async () => {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'user-alice', turnOrder: 0, currentBalance: 1500 }),
  ];
  const gameState = createGameState({
    id: 'g1',
    roomId: 'room-2',
    boardId: 'small',
    status: 'in_progress',
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'INVESTMENT_OPPORTUNITY',
    currentTurnIndex: 0,
    players,
    properties: [],
    startedAt: '2026-08-18T00:00:00.000Z',
  });
  const room = { id: 'room-2', status: 'in_progress', players: [{ playerId: 'user-alice', isHost: true }] };

  const roomRepository = fakeGameRoomRepository({ 'room-2': room });
  setGameState('room-2', gameState);
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  // randomSource throws if called at all — OPT_SAFE has no PROBABILITY
  // intent, so serverGeneratedFields() must not call it for this option.
  const randomSource = () => {
    throw new Error('randomSource should not be called for an option with no PROBABILITY intent');
  };
  handleGameAction(io, socket, roomRepository, undefined, {}, randomSource);
  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-2',
    actionType: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_SAFE' },
    clientActionId: 'choice-1',
  });

  assert.equal(io._broadcasts.length, 1); // did not throw/reject
  const { gameState: nextState } = io._broadcasts[0].payload;
  assert.equal(nextState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 200);
});

// ---- handleDisconnect / P10-T03 ----

test('disconnect: marks the player offline and broadcasts S2C_PLAYER_DISCONNECTED to the room', () => {
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };
  socket.roomId = 'room-1'; // set by joinSocketToRoom on a real C2S_JOIN_ROOM/C2S_RECONNECT — set directly here since this test only exercises handleDisconnect

  handleDisconnect(io, socket);
  socket._trigger('disconnect');

  assert.equal(isOffline('room-1', 'user-alice'), true);
  assert.equal(io._broadcasts.length, 1);
  assert.equal(io._broadcasts[0].room, 'room-1');
  assert.equal(io._broadcasts[0].event, 'S2C_PLAYER_DISCONNECTED');
  assert.deepEqual(io._broadcasts[0].payload, { roomId: 'room-1', playerId: 'user-alice' });
});

test('disconnect: a socket that never successfully joined a room (no socket.roomId) is a harmless no-op', () => {
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };
  // socket.roomId left unset

  handleDisconnect(io, socket);
  socket._trigger('disconnect');

  assert.equal(io._broadcasts.length, 0);
});

// ---- handleReconnect / C2S_RECONNECT — P10-T03 ----

test('C2S_RECONNECT success: resyncs S2C_ROOM_JOINED + S2C_STATE_UPDATE to the sender, marks online, broadcasts S2C_PLAYER_RECONNECTED to others', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  const gameState = buildAuctionGameState();
  setGameState('room-1', gameState);
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };

  // Simulate a prior disconnect, so this test also proves reconnect clears it.
  handleDisconnect(io, socket);
  socket.roomId = 'room-1';
  socket._trigger('disconnect');
  assert.equal(isOffline('room-1', 'user-bob'), true);

  handleReconnect(io, socket, roomRepository, undefined);
  await socket._trigger('C2S_RECONNECT', { roomId: 'room-1' });

  assert.equal(isOffline('room-1', 'user-bob'), false);
  assert.deepEqual(socket._joined, ['room-1']);

  assert.equal(socket._emitted.length, 2);
  assert.equal(socket._emitted[0].event, 'S2C_ROOM_JOINED');
  assert.equal(socket._emitted[0].payload.roomId, 'room-1');
  assert.equal(socket._emitted[1].event, 'S2C_STATE_UPDATE');
  assert.equal(socket._emitted[1].payload.stateVersion, gameState.stateVersion);
  assert.deepEqual(socket._emitted[1].payload.gameState, gameState);
  assert.deepEqual(socket._emitted[1].payload.transactions, []); // a resync, no money moved

  assert.equal(socket._toEmitted.length, 1);
  assert.equal(socket._toEmitted[0].room, 'room-1');
  assert.equal(socket._toEmitted[0].event, 'S2C_PLAYER_RECONNECTED');
  assert.deepEqual(socket._toEmitted[0].payload, { roomId: 'room-1', playerId: 'user-bob' });

  assert.equal(io._broadcasts.length, 1); // only the earlier disconnect broadcast (via io.to) — reconnect uses socket.to, not io.to
});

test('C2S_RECONNECT: a non-member of the room is rejected with NOT_A_PARTICIPANT, same as C2S_JOIN_ROOM', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const socket = mockSocket();
  socket.user = { id: 'user-stranger' };

  handleReconnect(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_RECONNECT', { roomId: 'room-1' });

  assert.equal(socket._emitted.length, 1);
  assert.equal(socket._emitted[0].event, 'S2C_ACTION_REJECTED');
  assert.equal(socket._emitted[0].payload.errorCode, 'NOT_A_PARTICIPANT');
});

test('C2S_RECONNECT: a room still in the lobby (not in_progress) is rejected with ROOM_NOT_IN_PROGRESS', async () => {
  const room = { ...buildAuctionRoom(), status: 'ready_check' };
  const roomRepository = fakeGameRoomRepository({ 'room-1': room });
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  handleReconnect(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_RECONNECT', { roomId: 'room-1' });

  assert.equal(socket._emitted[0].event, 'S2C_ACTION_REJECTED');
  assert.equal(socket._emitted[0].payload.errorCode, 'ROOM_NOT_IN_PROGRESS');
  // S2C_ROOM_JOINED is deliberately not emitted first — see joinSocketToRoom/handleReconnect's own comments.
  assert.equal(socket._emitted.some((e) => e.event === 'S2C_ROOM_JOINED'), false);
});

test('C2S_RECONNECT: in_progress but no game state anywhere (hot or durable) is rejected with GAME_NOT_FOUND', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  // Deliberately no setGameState() call, and supabase is undefined (no cold-load fallback either).
  const socket = mockSocket();
  socket.user = { id: 'user-alice' };

  handleReconnect(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_RECONNECT', { roomId: 'room-1' });

  assert.equal(socket._emitted[0].event, 'S2C_ACTION_REJECTED');
  assert.equal(socket._emitted[0].payload.errorCode, 'GAME_NOT_FOUND');
});

test('C2S_RECONNECT: a room member with no seat in this particular game is rejected with NOT_A_PARTICIPANT', async () => {
  // A real room member (so joinSocketToRoom succeeds) who was never seated
  // as a PlayerGameState — same defensive check handleGameAction applies.
  const room = { ...buildAuctionRoom(), players: [...buildAuctionRoom().players, { playerId: 'user-carol', isHost: false }] };
  const roomRepository = fakeGameRoomRepository({ 'room-1': room });
  setGameState('room-1', buildAuctionGameState());
  const socket = mockSocket();
  socket.user = { id: 'user-carol' };

  handleReconnect(fakeIo(), socket, roomRepository, undefined);
  await socket._trigger('C2S_RECONNECT', { roomId: 'room-1' });

  const rejections = socket._emitted.filter((e) => e.event === 'S2C_ACTION_REJECTED');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].payload.errorCode, 'NOT_A_PARTICIPANT');
});

// ---- Turn timers — P10-T04 ----
// Reuses buildAuctionRoom/buildAuctionGameState (FLASH_AUCTION_ACTIVE,
// TIMER_DURATIONS_SECONDS.FLASH_AUCTION_ACTIVE = 15s) rather than new
// fixtures — every reachable "resting" phase in this engine is one of the
// five timed ones (ROLLING/JAIL_DECISION/AWAITING_PURCHASE/
// FLASH_AUCTION_ACTIVE/POST_ACTIONS; TURN_START always cascades straight
// through to ROLLING/JAIL_DECISION within one transition — turnMachine.js's
// own file header), so the auction fixture already exercises this fully
// without needing a dedicated "lands in an untimed phase" fixture.

// Lets any pending microtask chain inside a fire-and-forget onTimeout
// callback (handleTurnTimeout's own awaits) settle before assertions run.
// Not always strictly necessary (a timeout whose default action needs no
// Supabase write resolves synchronously within mock.timers.tick() itself),
// but cheap and robust regardless of which internal path a given test hits.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a broadcast landing in a timed phase carries a non-null deadlineAt; firing the timer applies the documented default action and broadcasts again', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const socket = mockSocket();
  socket.user = { id: 'user-bob' };
  handleGameAction(io, socket, roomRepository, undefined);

  await socket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'action-1',
  });

  assert.equal(io._broadcasts.length, 1);
  assert.equal(io._broadcasts[0].payload.gameState.phase, 'FLASH_AUCTION_ACTIVE');
  assert.equal(typeof io._broadcasts[0].payload.deadlineAt, 'string'); // TIMER_DURATIONS_SECONDS.FLASH_AUCTION_ACTIVE
  assert.equal(activeTurnTimerDeadline('room-1'), io._broadcasts[0].payload.deadlineAt);

  mock.timers.tick(TIMER_DURATIONS_SECONDS.FLASH_AUCTION_ACTIVE * 1000);
  await flushMicrotasks();

  // buildDefaultAction('FLASH_AUCTION_ACTIVE', ...) === { type: 'AUCTION_TIMEOUT' }
  // (stateMachine/timers.js) — forces the auction to settle regardless of
  // active bidders, same as turnMachine.test.js's own AUCTION_TIMEOUT
  // coverage, just reached here through the timer wiring instead of a
  // direct transitionTurn() call.
  assert.equal(io._broadcasts.length, 2);
  const timedOut = io._broadcasts[1].payload;
  assert.notEqual(timedOut.gameState.phase, 'FLASH_AUCTION_ACTIVE'); // the auction actually resolved
  assert.equal(timedOut.stateVersion, io._broadcasts[0].payload.stateVersion + 1);
});

test('a real action before the deadline replaces the pending timeout — the original never fires (no stale double-broadcast)', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const bobSocket = mockSocket();
  bobSocket.user = { id: 'user-bob' };
  handleGameAction(io, bobSocket, roomRepository, undefined);

  await bobSocket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'bid-1',
  });
  // A second, higher bid immediately after — replaces the first bid's
  // 15s timer with a fresh one (TimerManager.start()'s own "at most one
  // per room" contract), still FLASH_AUCTION_ACTIVE.
  await bobSocket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 300 },
    clientActionId: 'bid-2',
  });
  assert.equal(io._broadcasts.length, 2);
  assert.equal(io._broadcasts[1].payload.gameState.phase, 'FLASH_AUCTION_ACTIVE');

  mock.timers.tick(TIMER_DURATIONS_SECONDS.FLASH_AUCTION_ACTIVE * 1000);
  await flushMicrotasks();

  // Exactly one more broadcast (the second bid's own timer firing), not
  // two — proves the first bid's timer was genuinely cancelled, not just
  // superseded in the client-visible deadline while still ticking away in
  // the background.
  assert.equal(io._broadcasts.length, 3);
});

test('C2S_RECONNECT reports the currently-scheduled deadlineAt without resetting it', async () => {
  const roomRepository = fakeGameRoomRepository({ 'room-1': buildAuctionRoom() });
  setGameState('room-1', buildAuctionGameState());
  const io = fakeIo();
  const bobSocket = mockSocket();
  bobSocket.user = { id: 'user-bob' };
  handleGameAction(io, bobSocket, roomRepository, undefined);

  await bobSocket._trigger('C2S_GAME_ACTION', {
    roomId: 'room-1',
    actionType: 'PLACE_BID',
    payload: { amount: 250 },
    clientActionId: 'bid-1',
  });
  const originalDeadline = io._broadcasts[0].payload.deadlineAt;

  // Time passes (but short of the deadline) before Alice reconnects. Half the
  // window, not a hardcoded 5000ms — the auction rework (503a83f) shrank
  // FLASH_AUCTION_ACTIVE from 15s to 5s and left this at a fixed 5000ms,
  // which no longer left any margin before the deadline and made the timer
  // fire (or race) before Alice ever reconnected.
  const halfWindowMs = (TIMER_DURATIONS_SECONDS.FLASH_AUCTION_ACTIVE * 1000) / 2;
  mock.timers.tick(halfWindowMs);

  const aliceSocket = mockSocket();
  aliceSocket.user = { id: 'user-alice' };
  handleReconnect(io, aliceSocket, roomRepository, undefined);
  await aliceSocket._trigger('C2S_RECONNECT', { roomId: 'room-1' });

  const resync = aliceSocket._emitted.find((e) => e.event === 'S2C_STATE_UPDATE');
  assert.equal(resync.payload.deadlineAt, originalDeadline); // unchanged — GAME_STATE_MACHINE.md §5/§7

  // The remaining half still elapses on the *original* schedule — if
  // reconnect had called start() again, this tick alone wouldn't reach a
  // freshly-computed (now + FLASH_AUCTION_ACTIVE) deadline yet, and nothing
  // would fire.
  mock.timers.tick(TIMER_DURATIONS_SECONDS.FLASH_AUCTION_ACTIVE * 1000 - halfWindowMs);
  await flushMicrotasks();

  assert.equal(io._broadcasts.length, 2); // the original timer's own AUCTION_TIMEOUT firing
});
