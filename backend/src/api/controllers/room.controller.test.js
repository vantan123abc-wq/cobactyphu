import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, joinRoom, getRoom, setReady, setZodiac, startGame, leaveRoom, kickPlayer, MAX_PLAYERS, MIN_PLAYERS } from './room.controller.js';
import { createTile } from '../../domain/tile.js';
import { ZODIAC_KEYS } from '../../domain/zodiac.js';
import { getGameState, _resetForTests as resetGameRepository } from '../../infrastructure/repositories/gameRepository.js';
import { createFakeSupabase } from '../../testUtils/fakeSupabase.js';

// Minimal Express-shaped mocks — no supertest/express test-client
// dependency, same pattern as auth/authMiddleware.test.js. `app.get()`
// stands in for app.js's `app.set('supabase', supabase)` (P10-T02) —
// req.app.get('supabase') is how room.controller.js now reaches its
// Supabase client, so every mockReq shares one fake per test (fresh each
// time, see beforeEach) rather than a real network call.
let supabase;

function mockReq({ user, params = {}, body = {}, boardTilesByBoard, io } = {}) {
  return {
    user,
    params,
    body,
    app: {
      get: (key) =>
        key === 'supabase' ? supabase : key === 'boardTilesByBoard' ? boardTilesByBoard : key === 'io' ? io : undefined,
    },
  };
}

// Lobby real-time push (2026-08-21) — a fake `io` recording every
// `.to(roomId).emit(event, payload)` call, same minimal-fake-over-mock
// style fakeSupabase.js already uses elsewhere in this test suite. `io` is
// undefined in every mockReq() call above that doesn't pass one — already
// covered by every pre-existing test in this file, proving
// notifyRoomUpdated's optional chaining degrades gracefully with no
// dedicated test needed for that half.
function fakeIo() {
  const emitted = [];
  return {
    emitted,
    to(roomId) {
      return { emit: (event, payload) => emitted.push({ roomId, event, payload }) };
    },
  };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(() => {
  supabase = createFakeSupabase();
  resetGameRepository();
});

async function createRoomAs(userId, body = {}) {
  const req = mockReq({ user: { id: userId }, body });
  const res = mockRes();
  await createRoom(req, res);
  return res.body;
}

async function joinAs(userId, joinCode) {
  const req = mockReq({ user: { id: userId }, params: { code: joinCode } });
  const res = mockRes();
  await joinRoom(req, res);
  return res.body;
}

async function setReadyAs(userId, roomId, ready) {
  const req = mockReq({ user: { id: userId }, params: { id: roomId }, body: { ready } });
  const res = mockRes();
  await setReady(req, res);
  return res;
}

async function startGameAs(userId, roomId, boardTilesByBoard) {
  const req = mockReq({ user: { id: userId }, params: { id: roomId }, boardTilesByBoard });
  const res = mockRes();
  await startGame(req, res);
  return res;
}

async function setZodiacAs(userId, roomId, zodiac) {
  const req = mockReq({ user: { id: userId }, params: { id: roomId }, body: { zodiac } });
  const res = mockRes();
  await setZodiac(req, res);
  return res;
}

test('createRoom: creates a room with the sender as host and first player', async () => {
  const req = mockReq({ user: { id: 'user-host' } });
  const res = mockRes();

  await createRoom(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(typeof res.body.roomId, 'string');
  assert.equal(res.body.joinCode.length, 6);
  assert.equal(res.body.status, 'waiting_for_players');
  assert.equal(res.body.hostId, 'user-host');
  assert.equal(typeof res.body.createdAt, 'string');
});

test('joinRoom: a different player successfully joins an open room', async () => {
  const created = await createRoomAs('user-host');

  const req = mockReq({ user: { id: 'user-guest' }, params: { code: created.joinCode } });
  const res = mockRes();
  await joinRoom(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.roomId, created.roomId);
  assert.equal(res.body.players.length, 2);
  const guest = res.body.players.find((p) => p.playerId === 'user-guest');
  assert.ok(guest);
  assert.equal(guest.isHost, false);
  assert.equal(guest.isReady, false);
});

test('joinRoom: rejoining as an existing member is a no-op, not a duplicate or an error', async () => {
  const created = await createRoomAs('user-host');

  const req = mockReq({ user: { id: 'user-host' }, params: { code: created.joinCode } });
  const res = mockRes();
  await joinRoom(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.players.length, 1); // still just the host, not duplicated
});

test('joinRoom: joining a full room is rejected with 409 ROOM_FULL', async () => {
  const created = await createRoomAs('user-host');

  // Host is already player 1; fill the remaining MAX_PLAYERS - 1 seats.
  for (let i = 2; i <= MAX_PLAYERS; i++) {
    const req = mockReq({ user: { id: `user-${i}` }, params: { code: created.joinCode } });
    await joinRoom(req, mockRes());
  }

  const overflowReq = mockReq({ user: { id: 'user-overflow' }, params: { code: created.joinCode } });
  const overflowRes = mockRes();
  await joinRoom(overflowReq, overflowRes);

  assert.equal(overflowRes.statusCode, 409);
  assert.equal(overflowRes.body.error.code, 'ROOM_FULL');
});

test('joinRoom: a non-existent join code is rejected with 404 INVALID_JOIN_CODE', async () => {
  const req = mockReq({ user: { id: 'user-guest' }, params: { code: 'ZZZZZZ' } });
  const res = mockRes();
  await joinRoom(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'INVALID_JOIN_CODE');
});

test('getRoom: a member can fetch the room', async () => {
  const created = await createRoomAs('user-host');

  const req = mockReq({ user: { id: 'user-host' }, params: { id: created.roomId } });
  const res = mockRes();
  await getRoom(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.roomId, created.roomId);
  assert.equal(res.body.players.length, 1);
});

test('getRoom: a non-member is rejected with 404, same as a non-existent room (privacy rule)', async () => {
  const created = await createRoomAs('user-host');

  const req = mockReq({ user: { id: 'user-stranger' }, params: { id: created.roomId } });
  const res = mockRes();
  await getRoom(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('getRoom: a genuinely non-existent room id is also 404', async () => {
  const req = mockReq({ user: { id: 'user-host' }, params: { id: 'no-such-room' } });
  const res = mockRes();
  await getRoom(req, res);

  assert.equal(res.statusCode, 404);
});

// ---- setReady ----

test('setReady: a player successfully sets their own ready status', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);

  const res = await setReadyAs('user-guest', created.roomId, true);

  assert.equal(res.statusCode, 200);
  const guest = res.body.players.find((p) => p.playerId === 'user-guest');
  assert.equal(guest.isReady, true);
});

test('setReady: once every non-host player is ready, room status advances to ready_check', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);

  const res = await setReadyAs('user-guest', created.roomId, true);

  assert.equal(res.body.status, 'ready_check');
});

test('setReady: un-readying after ready_check reverts status to waiting_for_players', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true); // -> ready_check

  const res = await setReadyAs('user-guest', created.roomId, false);

  assert.equal(res.body.status, 'waiting_for_players');
});

test('setReady: rejects a non-boolean ready value', async () => {
  const created = await createRoomAs('user-host');
  const res = await setReadyAs('user-host', created.roomId, 'yes');

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

// ---- setZodiac ----

test('setZodiac: a player successfully picks one of the 12 real zodiac keys', async () => {
  const created = await createRoomAs('user-host');
  const res = await setZodiacAs('user-host', created.roomId, 'dan'); // Hổ (tiger)

  assert.equal(res.statusCode, 200);
  const host = res.body.players.find((p) => p.playerId === 'user-host');
  assert.equal(host.zodiac, 'dan');
});

test('setZodiac: rejects an unrecognized key', async () => {
  const created = await createRoomAs('user-host');
  const res = await setZodiacAs('user-host', created.roomId, 'unicorn');

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('setZodiac: null explicitly clears a pick', async () => {
  const created = await createRoomAs('user-host');
  await setZodiacAs('user-host', created.roomId, 'mao'); // Mèo (cat)

  const res = await setZodiacAs('user-host', created.roomId, null);

  assert.equal(res.statusCode, 200);
  const host = res.body.players.find((p) => p.playerId === 'user-host');
  assert.equal(host.zodiac, null);
});

test('setZodiac: two different players picking the same animal is allowed (colour, not the animal, distinguishes them)', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setZodiacAs('user-host', created.roomId, 'thin'); // Rồng (dragon)

  const res = await setZodiacAs('user-guest', created.roomId, 'thin');

  assert.equal(res.statusCode, 200);
  const zodiacs = res.body.players.map((p) => p.zodiac);
  assert.deepEqual(zodiacs.sort(), ['thin', 'thin']);
});

test('setZodiac: a non-member is rejected with 404, same privacy rule as every other room endpoint', async () => {
  const created = await createRoomAs('user-host');
  const res = await setZodiacAs('user-stranger', created.roomId, 'ngo');

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('setZodiac: rejected once the room has already started, mirroring setReady\'s own ALREADY_STARTED guard', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);
  await startGameAs('user-host', created.roomId);

  const res = await setZodiacAs('user-host', created.roomId, 'hoi');

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'ALREADY_STARTED');
});

test('setZodiac: broadcasts S2C_ROOM_UPDATED, same push every other room-mutating endpoint already fires', async () => {
  const created = await createRoomAs('user-host');
  const io = fakeIo();
  const req = mockReq({ user: { id: 'user-host' }, params: { id: created.roomId }, body: { zodiac: 'suu' }, io });
  await setZodiac(req, mockRes());

  assert.equal(io.emitted.length, 1);
  assert.equal(io.emitted[0].event, 'S2C_ROOM_UPDATED');
  assert.equal(io.emitted[0].roomId, created.roomId);
});

// ---- startGame ----

test('startGame: the host successfully starts the game once all non-host players are ready', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true); // -> ready_check

  const res = await startGameAs('user-host', created.roomId);

  assert.equal(res.statusCode, 201);
  assert.equal(typeof res.body.gameId, 'string');
  assert.ok(['small', 'large'].includes(res.body.boardId));
  assert.equal(res.body.status, 'in_progress');
  assert.equal(typeof res.body.startedAt, 'string');
});

test('startGame: constructs one unowned Property per buyable tile from the real board — real bug found 2026-08-19 via this project\'s first full live playtest, this hardcoded properties: [] unconditionally, crashing the instant any player landed on a real property/transport/utility tile', async () => {
  const boardTilesByBoard = {
    small: [
      createTile({ id: 't0', boardId: 'small', position: 0, tileType: 'go', name: 'GO' }),
      createTile({ id: 't1', boardId: 'small', position: 1, tileType: 'property', name: 'Brown Ave', price: 60 }),
      createTile({ id: 't2', boardId: 'small', position: 2, tileType: 'transport', name: 'Station A', price: 200 }),
      createTile({ id: 't3', boardId: 'small', position: 3, tileType: 'utility', name: 'Electric Co', price: 150 }),
      createTile({ id: 't4', boardId: 'small', position: 4, tileType: 'tax', name: 'Income Tax', taxAmount: 100 }),
      createTile({ id: 't5', boardId: 'small', position: 5, tileType: 'chance', name: 'Chance' }),
    ],
  };

  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  const res = await startGameAs('user-host', created.roomId, boardTilesByBoard);
  assert.equal(res.statusCode, 201);

  const gameState = getGameState(created.roomId);
  // Exactly the 3 buyable tiles (property/transport/utility) get a row —
  // go/tax/chance don't, same BUYABLE_TILE_TYPES list resolveTile.js's own
  // resolveBuyableTile() checks against.
  assert.equal(gameState.properties.length, 3);
  assert.deepEqual(
    gameState.properties.map((p) => p.boardTileId).sort(),
    ['t1', 't2', 't3']
  );
  for (const property of gameState.properties) {
    assert.equal(property.ownerId, null); // unowned
    assert.equal(property.mortgaged, false);
    assert.equal(property.upgradeLevel, 0);
    assert.equal(property.gameId, res.body.gameId);
  }
});

test('startGame: ruleset ASYMMETRIC starts the match in DRAFTING_ACTIVE with a populated draftState, offering only property tiles', async () => {
  const boardTilesByBoard = {
    small: [
      createTile({ id: 't0', boardId: 'small', position: 0, tileType: 'go', name: 'GO' }),
      createTile({ id: 't1', boardId: 'small', position: 1, tileType: 'property', name: 'A', price: 60 }),
      createTile({ id: 't2', boardId: 'small', position: 2, tileType: 'property', name: 'B', price: 80 }),
      createTile({ id: 't3', boardId: 'small', position: 3, tileType: 'transport', name: 'Station A', price: 200 }),
      createTile({ id: 't4', boardId: 'small', position: 4, tileType: 'utility', name: 'Electric Co', price: 150 }),
    ],
  };

  const created = await createRoomAs('user-host', { ruleset: 'ASYMMETRIC' });
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  const res = await startGameAs('user-host', created.roomId, boardTilesByBoard);
  assert.equal(res.statusCode, 201);

  const gameState = getGameState(created.roomId);
  assert.equal(gameState.ruleset, 'ASYMMETRIC');
  assert.equal(gameState.phase, 'DRAFTING_ACTIVE');
  assert.ok(gameState.draftState);
  assert.equal(gameState.draftState.round, 1);
  assert.equal(gameState.draftState.currentPickIndex, 0);
  assert.deepEqual(gameState.draftState.pickOrder.sort(), gameState.players.filter((p) => !p.isBank).map((p) => p.id).sort());
  assert.deepEqual(
    gameState.draftState.availableTileIds.sort(),
    ['t1', 't2'],
    'only the property tiles are offered — the station and the utility never are'
  );
});

test('startGame: ruleset CLASSIC (the default) still starts in TURN_START with no draftState, unaffected by the Draft Phase wiring', async () => {
  const created = await createRoomAs('user-host'); // no ruleset in body -> CLASSIC
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  const res = await startGameAs('user-host', created.roomId, {
    small: [createTile({ id: 't0', boardId: 'small', position: 0, tileType: 'go', name: 'GO' })],
  });
  assert.equal(res.statusCode, 201);

  const gameState = getGameState(created.roomId);
  assert.equal(gameState.ruleset, 'CLASSIC');
  assert.equal(gameState.phase, 'TURN_START');
  assert.equal(gameState.draftState, null);
});

test('startGame: with no boardTilesByBoard available (req.app.get returns undefined), properties is an empty array rather than throwing — same graceful-degradation posture as board.controller.js\'s own fallback', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  const res = await startGameAs('user-host', created.roomId); // no boardTilesByBoard arg
  assert.equal(res.statusCode, 201);
  assert.deepEqual(getGameState(created.roomId).properties, []);
});

test('startGame: a player\'s own lobby zodiac pick carries through to their real PlayerGameState', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setZodiacAs('user-host', created.roomId, 'tuat'); // Chó (dog)
  await setReadyAs('user-guest', created.roomId, true);

  await startGameAs('user-host', created.roomId);

  const host = getGameState(created.roomId).players.find((p) => p.playerId === 'user-host');
  assert.equal(host.zodiac, 'tuat');
});

test('startGame: a player who never picked gets a random real zodiac key assigned, not left null', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true); // host never called setZodiac

  await startGameAs('user-host', created.roomId);

  const host = getGameState(created.roomId).players.find((p) => p.playerId === 'user-host');
  assert.ok(ZODIAC_KEYS.includes(host.zodiac));
});

test('startGame: the Bank sentinel row always has a null zodiac — it has no piece on the board', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  await startGameAs('user-host', created.roomId);

  const bank = getGameState(created.roomId).players.find((p) => p.isBank);
  assert.equal(bank.zodiac, null);
});

test('startGame: persists an initial durable snapshot (games + game_state_snapshots) alongside the in-memory hot state', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  const res = await startGameAs('user-host', created.roomId);

  const gamesRows = supabase._tables.get('games');
  assert.equal(gamesRows.length, 1);
  assert.equal(gamesRows[0].room_id, created.roomId);

  const snapshotRows = supabase._tables.get('game_state_snapshots');
  assert.equal(snapshotRows.length, 1);
  assert.equal(snapshotRows[0].game_id, res.body.gameId);
  assert.equal(snapshotRows[0].reason, 'turn_end'); // pragmatic choice, see gameRepository.js header
});

test('startGame: a non-host player is rejected with 403 NOT_HOST', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  const res = await startGameAs('user-guest', created.roomId);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'NOT_HOST');
});

test('startGame: the host cannot start while a non-host player is still not ready', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode); // never readies up

  const res = await startGameAs('user-host', created.roomId);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'NOT_ALL_READY');
});

test('startGame: the host cannot start with only 1 player', async () => {
  const created = await createRoomAs('user-host'); // host is the only player

  const res = await startGameAs('user-host', created.roomId);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'INVALID_PLAYER_COUNT');
});

// ---- leaveRoom / kickPlayer (GAME_DESIGN_SPEC.md §4, wired 2026-08-21) ----

async function leaveAs(userId, roomId) {
  const req = mockReq({ user: { id: userId }, params: { id: roomId } });
  const res = mockRes();
  await leaveRoom(req, res);
  return res;
}

async function kickAs(userId, roomId, targetPlayerId) {
  const req = mockReq({ user: { id: userId }, params: { id: roomId }, body: { targetPlayerId } });
  const res = mockRes();
  await kickPlayer(req, res);
  return res;
}

test('leaveRoom: a non-host player successfully leaves — removed, host unchanged', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);

  const res = await leaveAs('user-guest', created.roomId);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });

  const roomRes = mockRes();
  await getRoom(mockReq({ user: { id: 'user-host' }, params: { id: created.roomId } }), roomRes);
  assert.equal(roomRes.body.players.length, 1);
  assert.equal(roomRes.body.hostId, 'user-host'); // unchanged — the leaver wasn't host
});

test('leaveRoom: the host leaving transfers host role to the next-joined player', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-first-guest', created.joinCode);
  await joinAs('user-second-guest', created.joinCode);

  await leaveAs('user-host', created.roomId);

  const roomRes = mockRes();
  await getRoom(mockReq({ user: { id: 'user-first-guest' }, params: { id: created.roomId } }), roomRes);
  assert.equal(roomRes.body.players.length, 2);
  assert.equal(roomRes.body.hostId, 'user-first-guest'); // next-joined, not second-guest
  assert.equal(roomRes.body.players.find((p) => p.playerId === 'user-first-guest').isHost, true);
});

test('leaveRoom: a non-member is rejected with 404', async () => {
  const created = await createRoomAs('user-host');
  const res = await leaveAs('user-stranger', created.roomId);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('leaveRoom: rejected with 409 ALREADY_STARTED once the game is in progress', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);
  await startGameAs('user-host', created.roomId);

  const res = await leaveAs('user-guest', created.roomId);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'ALREADY_STARTED');
});

test('kickPlayer: the host successfully kicks a non-host member', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);

  const res = await kickAs('user-host', created.roomId, 'user-guest');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });

  const roomRes = mockRes();
  await getRoom(mockReq({ user: { id: 'user-host' }, params: { id: created.roomId } }), roomRes);
  assert.equal(roomRes.body.players.length, 1);
  assert.ok(!roomRes.body.players.some((p) => p.playerId === 'user-guest'));
});

test('kickPlayer: a non-host attempting to kick is rejected with 403 NOT_HOST', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest-a', created.joinCode);
  await joinAs('user-guest-b', created.joinCode);

  const res = await kickAs('user-guest-a', created.roomId, 'user-guest-b');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'NOT_HOST');
});

test('kickPlayer: rejects a missing targetPlayerId with 400 VALIDATION_ERROR', async () => {
  const created = await createRoomAs('user-host');
  const res = await kickAs('user-host', created.roomId, undefined);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('kickPlayer: the host cannot kick themselves (400 CANNOT_KICK_HOST)', async () => {
  const created = await createRoomAs('user-host');
  const res = await kickAs('user-host', created.roomId, 'user-host');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'CANNOT_KICK_HOST');
});

test('kickPlayer: kicking a non-member target is rejected with 404', async () => {
  const created = await createRoomAs('user-host');
  const res = await kickAs('user-host', created.roomId, 'user-not-in-room');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('kickPlayer: rejected with 409 ALREADY_STARTED once the game is in progress', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);
  await startGameAs('user-host', created.roomId);

  const res = await kickAs('user-host', created.roomId, 'user-guest');
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'ALREADY_STARTED');
});

test('MIN_PLAYERS/MAX_PLAYERS are exported and match GAME_DESIGN_SPEC.md §0', () => {
  assert.equal(MIN_PLAYERS, 2);
  assert.equal(MAX_PLAYERS, 6);
});

// ---- Lobby real-time push (S2C_ROOM_UPDATED, wired 2026-08-21) ----
// One test per mutating endpoint, each confirming the real emitted event
// name/roomId/roomStatus — not just "something was emitted" — since a
// wrong roomStatus would silently break App.jsx's own view-routing for
// every non-acting player (see notifyRoomUpdated's own header for why the
// payload carries roomStatus at all).

test('joinRoom: broadcasts S2C_ROOM_UPDATED to the room with the current roomStatus', async () => {
  const created = await createRoomAs('user-host');
  const io = fakeIo();

  const req = mockReq({ user: { id: 'user-guest' }, params: { code: created.joinCode }, io });
  await joinRoom(req, mockRes());

  assert.equal(io.emitted.length, 1);
  assert.equal(io.emitted[0].roomId, created.roomId);
  assert.equal(io.emitted[0].event, 'S2C_ROOM_UPDATED');
  assert.equal(io.emitted[0].payload.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.roomStatus, 'waiting_for_players');
  // The roster rides along as of 2026-09-04, so no client has to spend three
  // more sequential Supabase round trips re-fetching what the server already
  // had in hand — see notifyRoomUpdated's own header for the measurement.
  assert.ok(Array.isArray(io.emitted[0].payload.room?.players), 'the push must carry the roster');
  assert.equal(io.emitted[0].payload.room.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.room.status, 'waiting_for_players');
});

test('setReady: broadcasts S2C_ROOM_UPDATED reflecting the post-transition roomStatus (ready_check)', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  const io = fakeIo();

  const req = mockReq({ user: { id: 'user-guest' }, params: { id: created.roomId }, body: { ready: true }, io });
  await setReady(req, mockRes());

  assert.equal(io.emitted.length, 1);
  assert.equal(io.emitted[0].roomId, created.roomId);
  assert.equal(io.emitted[0].event, 'S2C_ROOM_UPDATED');
  assert.equal(io.emitted[0].payload.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.roomStatus, 'ready_check');
  // The roster rides along as of 2026-09-04, so no client has to spend three
  // more sequential Supabase round trips re-fetching what the server already
  // had in hand — see notifyRoomUpdated's own header for the measurement.
  assert.ok(Array.isArray(io.emitted[0].payload.room?.players), 'the push must carry the roster');
  assert.equal(io.emitted[0].payload.room.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.room.status, 'ready_check');
});

test('startGame: broadcasts S2C_ROOM_UPDATED with roomStatus in_progress — the field App.jsx\'s own gameHasStarted check reads for every non-acting player', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);
  const io = fakeIo();

  const req = mockReq({ user: { id: 'user-host' }, params: { id: created.roomId }, io });
  await startGame(req, mockRes());

  assert.equal(io.emitted.length, 1);
  assert.equal(io.emitted[0].roomId, created.roomId);
  assert.equal(io.emitted[0].event, 'S2C_ROOM_UPDATED');
  assert.equal(io.emitted[0].payload.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.roomStatus, 'in_progress');
  // The roster rides along as of 2026-09-04, so no client has to spend three
  // more sequential Supabase round trips re-fetching what the server already
  // had in hand — see notifyRoomUpdated's own header for the measurement.
  assert.ok(Array.isArray(io.emitted[0].payload.room?.players), 'the push must carry the roster');
  assert.equal(io.emitted[0].payload.room.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.room.status, 'in_progress');
});

test('startGame: a failure persisting the room status leaves NO live game behind — the room stays startable instead of becoming permanently unplayable', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  await setReadyAs('user-guest', created.roomId, true);

  // Every C2S_GAME_ACTION checks the DURABLE room row before anything else
  // (socketServer.js's ROOM_NOT_IN_PROGRESS guard). Publishing the game into
  // the in-memory hot store before that row is safely written produced a
  // match that exists and broadcasts but rejects every action anyone takes,
  // with no way back — so the ordering is pinned here, not left to chance.
  //
  // The failure is injected by making the shared fake's `rooms` update
  // throw, which is what a real network/RLS/DB failure surfaces as through
  // roomRepository.updateRoom.
  const realFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const builder = realFrom(table);
    if (table !== 'rooms') return builder;
    return { ...builder, update: () => { throw new Error('simulated rooms update failure'); } };
  };

  let sawError = null;
  const req = mockReq({ user: { id: 'user-host' }, params: { id: created.roomId } });
  try {
    await startGame(req, mockRes(), (err) => { sawError = err });
  } catch (err) {
    sawError = err;
  }
  supabase.from = realFrom;

  assert.ok(sawError, 'the failed start must surface as a real error, not a silent success');
  assert.equal(getGameState(created.roomId), null, 'no game may be left in the hot store after a failed start');
});

test('leaveRoom: broadcasts S2C_ROOM_UPDATED so the remaining players refresh their roster', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  const io = fakeIo();

  const req = mockReq({ user: { id: 'user-guest' }, params: { id: created.roomId }, io });
  await leaveRoom(req, mockRes());

  assert.equal(io.emitted.length, 1);
  assert.equal(io.emitted[0].roomId, created.roomId);
  assert.equal(io.emitted[0].event, 'S2C_ROOM_UPDATED');
  assert.equal(io.emitted[0].payload.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.roomStatus, 'waiting_for_players');
  // The roster rides along as of 2026-09-04, so no client has to spend three
  // more sequential Supabase round trips re-fetching what the server already
  // had in hand — see notifyRoomUpdated's own header for the measurement.
  assert.ok(Array.isArray(io.emitted[0].payload.room?.players), 'the push must carry the roster');
  assert.equal(io.emitted[0].payload.room.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.room.status, 'waiting_for_players');
});

test('kickPlayer: broadcasts S2C_ROOM_UPDATED so the remaining players refresh their roster', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  const io = fakeIo();

  const req = mockReq({ user: { id: 'user-host' }, params: { id: created.roomId }, body: { targetPlayerId: 'user-guest' }, io });
  await kickPlayer(req, mockRes());

  assert.equal(io.emitted.length, 1);
  assert.equal(io.emitted[0].roomId, created.roomId);
  assert.equal(io.emitted[0].event, 'S2C_ROOM_UPDATED');
  assert.equal(io.emitted[0].payload.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.roomStatus, 'waiting_for_players');
  // The roster rides along as of 2026-09-04, so no client has to spend three
  // more sequential Supabase round trips re-fetching what the server already
  // had in hand — see notifyRoomUpdated's own header for the measurement.
  assert.ok(Array.isArray(io.emitted[0].payload.room?.players), 'the push must carry the roster');
  assert.equal(io.emitted[0].payload.room.roomId, created.roomId);
  assert.equal(io.emitted[0].payload.room.status, 'waiting_for_players');
});


// --- The pushed roster must be the POST-mutation one (2026-09-04) ---
//
// notifyRoomUpdated now broadcasts the roster instead of telling every client
// to re-fetch it (three more sequential Supabase round trips each, from a
// Render backend in Oregon to a database in Asia — see that function's own
// header for the measurement). The one way that can go genuinely wrong is
// broadcasting a record captured BEFORE the mutation, which would arrive
// already stale. leave/kick are the sharp cases: both are removals, so a
// pre-update roster would still list the departed player and no lobby would
// ever drop them.

test('leaveRoom: the broadcast roster no longer contains the player who left', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  const io = fakeIo();

  await leaveRoom(mockReq({ user: { id: 'user-guest' }, params: { id: created.roomId }, io }), mockRes());

  assert.deepEqual(io.emitted[0].payload.room.players.map((p) => p.playerId), ['user-host']);
});

test('kickPlayer: the broadcast roster no longer contains the kicked player', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  const io = fakeIo();

  await kickPlayer(
    mockReq({ user: { id: 'user-host' }, params: { id: created.roomId }, body: { targetPlayerId: 'user-guest' }, io }),
    mockRes()
  );

  assert.deepEqual(io.emitted[0].payload.room.players.map((p) => p.playerId), ['user-host']);
});

test('setReady: the broadcast roster already carries the new ready flag', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-guest', created.joinCode);
  const io = fakeIo();

  await setReady(mockReq({ user: { id: 'user-guest' }, params: { id: created.roomId }, body: { ready: true }, io }), mockRes());

  const guest = io.emitted[0].payload.room.players.find((p) => p.playerId === 'user-guest');
  assert.equal(guest.isReady, true, 'the pushed roster is what every other client renders — it must already be current');
  assert.ok(guest.displayName, 'displayName must survive the no-refetch rebuild');
});

// updateRoom stopped re-reading the roster from the database after writing it
// (two more round trips) and rebuilds it from what it just persisted instead.
// These two pin the parts of that rebuild that could silently regress.
test('a ready-toggle preserves every other player row and the lobby ordering', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-a', created.joinCode);
  await joinAs('user-b', created.joinCode);
  await setReadyAs('user-a', created.roomId, true);

  const io = fakeIo();
  await setReady(mockReq({ user: { id: 'user-b' }, params: { id: created.roomId }, body: { ready: true }, io }), mockRes());

  const players = io.emitted[0].payload.room.players;
  assert.deepEqual(players.map((p) => p.playerId), ['user-host', 'user-a', 'user-b'], 'join order must stay stable across updates');
  assert.equal(players.find((p) => p.playerId === 'user-a').isReady, true, "another player's ready flag must not be clobbered");
  assert.equal(players.find((p) => p.playerId === 'user-host').isHost, true);
});

test('the rebuilt roster still matches what a fresh GET /rooms/:id returns', async () => {
  const created = await createRoomAs('user-host');
  await joinAs('user-a', created.joinCode);
  await joinAs('user-b', created.joinCode);

  const io = fakeIo();
  await setReady(mockReq({ user: { id: 'user-a' }, params: { id: created.roomId }, body: { ready: true }, io }), mockRes());
  const pushed = io.emitted[0].payload.room;

  const res = mockRes();
  await getRoom(mockReq({ user: { id: 'user-a' }, params: { id: created.roomId } }), res);

  assert.deepEqual(pushed.players, res.body.players, 'the no-refetch rebuild must agree with the database read it replaced');
  assert.equal(pushed.hostId, res.body.hostId);
  assert.equal(pushed.status, res.body.status);
});
