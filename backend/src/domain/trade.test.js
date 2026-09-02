import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrade, TRADE_STATUSES, MAX_COUNTER_DEPTH, TRADE_EXPIRY_SECONDS } from './trade.js';

function baseFields(overrides = {}) {
  return {
    id: 'trade-1',
    roomId: 'r1',
    proposerId: 'gp-alice',
    targetId: 'gp-bob',
    proposerOffer: { properties: ['p1'], money: 100 },
    targetOffer: { properties: [], money: 0 },
    status: 'PROPOSED',
    createdAt: '2026-08-18T00:00:00.000Z',
    expiresAt: '2026-08-18T00:01:00.000Z',
    counterDepth: 0,
    ...overrides,
  };
}

test('createTrade builds a well-formed trade with the given fields', () => {
  const trade = createTrade(baseFields());
  assert.equal(trade.proposerId, 'gp-alice');
  assert.equal(trade.targetId, 'gp-bob');
  assert.deepEqual(trade.proposerOffer, { properties: ['p1'], money: 100 });
  assert.deepEqual(trade.targetOffer, { properties: [], money: 0 });
  assert.equal(trade.status, 'PROPOSED');
  assert.equal(trade.counterDepth, 0);
  assert.equal(trade.previousTradeId, null);
});

test('createTrade defaults counterDepth to 0 and previousTradeId to null when omitted', () => {
  const fields = baseFields();
  delete fields.counterDepth;
  const trade = createTrade(fields);
  assert.equal(trade.counterDepth, 0);
  assert.equal(trade.previousTradeId, null);
});

test('createTrade rejects an unknown status', () => {
  assert.throws(() => createTrade(baseFields({ status: 'PENDING' })), TypeError);
});

test('every TRADE_STATUSES value is accepted by createTrade', () => {
  for (const status of TRADE_STATUSES) {
    assert.doesNotThrow(() => createTrade(baseFields({ status })));
  }
});

test('createTrade rejects proposerId === targetId', () => {
  assert.throws(() => createTrade(baseFields({ targetId: 'gp-alice' })), TypeError);
});

test('createTrade rejects a negative counterDepth', () => {
  assert.throws(() => createTrade(baseFields({ counterDepth: -1 })), TypeError);
});

test('createTrade copies offer arrays defensively (mutating the input does not mutate the trade)', () => {
  const proposerOffer = { properties: ['p1'], money: 100 };
  const trade = createTrade(baseFields({ proposerOffer }));
  proposerOffer.properties.push('p2');
  assert.deepEqual(trade.proposerOffer.properties, ['p1']);
});

test('MAX_COUNTER_DEPTH and TRADE_EXPIRY_SECONDS are the documented values', () => {
  assert.equal(MAX_COUNTER_DEPTH, 5);
  assert.equal(TRADE_EXPIRY_SECONDS, 60);
});
