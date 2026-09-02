import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBoardConfig } from './board.controller.js';

// Same minimal Express-shaped mocks as room.controller.test.js.
function mockReq({ params = {}, boardTilesByBoard } = {}) {
  return { params, app: { get: (key) => (key === 'boardTilesByBoard' ? boardTilesByBoard : undefined) } };
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

const SAMPLE_TILES = [
  { id: 't0', boardId: 'small', position: 0, tileType: 'go', name: 'Bắt Đầu', groupId: null, price: null, baseRent: null, rentTable: null, houseCost: null, mortgageValue: null, taxAmount: null },
  { id: 't1', boardId: 'small', position: 1, tileType: 'property', name: 'Property 1', groupId: null, price: 100, baseRent: 10, rentTable: null, houseCost: null, mortgageValue: null, taxAmount: null },
];

test('getBoardConfig: a valid boardId with cached tiles returns them, in position order as cached', () => {
  const req = mockReq({ params: { boardId: 'small' }, boardTilesByBoard: { small: SAMPLE_TILES } });
  const res = mockRes();

  getBoardConfig(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.boardId, 'small');
  assert.deepEqual(res.body.tiles, SAMPLE_TILES);
});

test('getBoardConfig: "large" is also a valid boardId', () => {
  const req = mockReq({ params: { boardId: 'large' }, boardTilesByBoard: { large: SAMPLE_TILES } });
  const res = mockRes();

  getBoardConfig(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.boardId, 'large');
});

test('getBoardConfig: an unknown boardId is rejected with 404 NOT_FOUND, cache never consulted', () => {
  const req = mockReq({ params: { boardId: 'medium' }, boardTilesByBoard: { small: SAMPLE_TILES, large: SAMPLE_TILES } });
  const res = mockRes();

  getBoardConfig(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('getBoardConfig: a valid boardId with no cache entry (Supabase not configured at startup) returns 503, not a crash', () => {
  const req = mockReq({ params: { boardId: 'small' }, boardTilesByBoard: {} });
  const res = mockRes();

  getBoardConfig(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'BOARD_DATA_UNAVAILABLE');
});

test('getBoardConfig: a valid boardId with an empty tile array (fetch succeeded but returned nothing) also returns 503', () => {
  const req = mockReq({ params: { boardId: 'small' }, boardTilesByBoard: { small: [] } });
  const res = mockRes();

  getBoardConfig(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'BOARD_DATA_UNAVAILABLE');
});

test('getBoardConfig: req.app.get("boardTilesByBoard") returning undefined entirely (never set) is handled, not a crash', () => {
  const req = mockReq({ params: { boardId: 'small' }, boardTilesByBoard: undefined });
  const res = mockRes();

  getBoardConfig(req, res);

  assert.equal(res.statusCode, 503);
});
