import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventCards } from './eventCard.controller.js';
import { EVENT_CARDS } from '../../domain/eventDictionary.js';

// Same minimal Express-shaped mocks as board.controller.test.js/
// room.controller.test.js — no req.app.get() dependency at all here, unlike
// those two, since EVENT_CARDS is a plain module constant, not something
// server.js loads asynchronously at boot.
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

test('getEventCards: returns the real EVENT_CARDS dictionary verbatim', () => {
  const res = mockRes();

  getEventCards({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { cards: EVENT_CARDS });
});

test('getEventCards: the response includes both INSTANT and CHOICE card shapes, not a filtered subset', () => {
  const res = mockRes();

  getEventCards({}, res);

  const cards = Object.values(res.body.cards);
  assert.ok(cards.some((c) => c.type === 'INSTANT'));
  assert.ok(cards.some((c) => c.type === 'CHOICE'));
});
