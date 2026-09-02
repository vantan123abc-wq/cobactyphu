import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawCard, evaluateEvent, resolveChoice, EventChoiceError } from './eventResolver.js';
import { EVENT_CARDS } from '../domain/eventDictionary.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';

function baseGameState(overrides = {}) {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', currentBalance: 1500 }),
  ];
  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'DRAWING_CARD',
    players,
    startedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  });
}

// ---- drawCard ----

test('drawCard: draws the top card and moves it to the bottom of the deck', () => {
  const { drawnCardId, newDeck } = drawCard(['A', 'B', 'C']);
  assert.equal(drawnCardId, 'A');
  assert.deepEqual(newDeck, ['B', 'C', 'A']);
});

test('drawCard: cycling repeatedly visits every card once per full cycle', () => {
  let deck = ['A', 'B', 'C'];
  const drawn = [];
  for (let i = 0; i < 3; i++) {
    const result = drawCard(deck);
    drawn.push(result.drawnCardId);
    deck = result.newDeck;
  }
  assert.deepEqual(drawn, ['A', 'B', 'C']);
  assert.deepEqual(deck, ['A', 'B', 'C']); // back to the original order after one full cycle
});

test('drawCard: does not mutate the input deck array', () => {
  const original = ['A', 'B', 'C'];
  drawCard(original);
  assert.deepEqual(original, ['A', 'B', 'C']);
});

test('drawCard: rejects an empty deck', () => {
  assert.throws(() => drawCard([]), TypeError);
});

// ---- evaluateEvent ----

test('evaluateEvent: an INSTANT card returns its settlement intent array directly', () => {
  const intents = evaluateEvent(EVENT_CARDS.DIVIDEND_50);
  assert.deepEqual(intents, [{ action: 'ADD_MONEY', amount: 50 }]);
});

test('evaluateEvent: a CHOICE card returns a REQUIRE_CHOICE transition intent with the card\'s options', () => {
  const result = evaluateEvent(EVENT_CARDS.INVESTMENT_OPPORTUNITY);
  assert.equal(result.type, 'REQUIRE_CHOICE');
  assert.deepEqual(
    result.options.map((o) => o.id),
    ['OPT_SAFE', 'OPT_RISK']
  );
});

test('evaluateEvent: rejects an unknown card type', () => {
  assert.throws(() => evaluateEvent({ id: 'x', type: 'MYSTERY' }), TypeError);
});

// ---- resolveChoice ----

test('resolveChoice: the safe option resolves to its flat intent, no probabilityRoll needed', () => {
  const gameState = baseGameState();
  const intents = resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_SAFE');
  assert.deepEqual(intents, [{ action: 'ADD_MONEY', amount: 200 }]);
});

test('resolveChoice: the risky option, probability succeeds, resolves to REMOVE_MONEY then the onSuccess payout', () => {
  const gameState = baseGameState();
  // chance is 0.5; a roll strictly below 0.5 succeeds.
  const intents = resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_RISK', 0.2);
  assert.deepEqual(intents, [
    { action: 'REMOVE_MONEY', amount: 300 },
    { action: 'ADD_MONEY', amount: 900 },
  ]);
});

test('resolveChoice: the risky option, probability fails, resolves to REMOVE_MONEY only (empty onFailure)', () => {
  const gameState = baseGameState();
  // a roll at or above 0.5 fails.
  const intents = resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_RISK', 0.8);
  assert.deepEqual(intents, [{ action: 'REMOVE_MONEY', amount: 300 }]);
});

test('resolveChoice: rejects the risky option when the player cannot afford validation.amount', () => {
  const gameState = {
    ...baseGameState(),
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 100 } : p)),
  };

  try {
    resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_RISK', 0.2);
    assert.fail('expected EventChoiceError');
  } catch (e) {
    assert.ok(e instanceof EventChoiceError);
    assert.equal(e.reason, 'INSUFFICIENT_BALANCE');
  }
});

test('resolveChoice: the safe option has no validation, so it is available regardless of balance', () => {
  const gameState = {
    ...baseGameState(),
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 0 } : p)),
  };
  const intents = resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_SAFE');
  assert.deepEqual(intents, [{ action: 'ADD_MONEY', amount: 200 }]);
});

test('resolveChoice: rejects an unknown optionId', () => {
  const gameState = baseGameState();
  assert.throws(
    () => resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_DOES_NOT_EXIST', 0.2),
    EventChoiceError
  );
});

test('resolveChoice: rejects a missing/invalid probabilityRoll when the option needs one', () => {
  const gameState = baseGameState();
  assert.throws(() => resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_RISK'), TypeError);
  assert.throws(() => resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_RISK', 1), TypeError);
  assert.throws(() => resolveChoice(gameState, 'gp-alice', EVENT_CARDS.INVESTMENT_OPPORTUNITY, 'OPT_RISK', -0.1), TypeError);
});

test('resolveChoice: rejects being called on an INSTANT card', () => {
  const gameState = baseGameState();
  assert.throws(() => resolveChoice(gameState, 'gp-alice', EVENT_CARDS.DIVIDEND_50, 'anything'), TypeError);
});

// ---- full lifecycle ----

test('lifecycle: draw -> evaluate -> (choice) -> resolve, using the real dictionary end to end', () => {
  let deck = ['DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'];
  const gameState = baseGameState();

  const { drawnCardId, newDeck } = drawCard(deck);
  deck = newDeck;
  assert.equal(drawnCardId, 'DIVIDEND_50');

  const instantResult = evaluateEvent(EVENT_CARDS[drawnCardId]);
  assert.deepEqual(instantResult, [{ action: 'ADD_MONEY', amount: 50 }]);

  const { drawnCardId: secondCardId } = drawCard(deck);
  assert.equal(secondCardId, 'INVESTMENT_OPPORTUNITY');

  const choiceResult = evaluateEvent(EVENT_CARDS[secondCardId]);
  assert.equal(choiceResult.type, 'REQUIRE_CHOICE');

  const finalIntents = resolveChoice(gameState, 'gp-alice', EVENT_CARDS[secondCardId], 'OPT_RISK', 0.1);
  assert.deepEqual(finalIntents, [
    { action: 'REMOVE_MONEY', amount: 300 },
    { action: 'ADD_MONEY', amount: 900 },
  ]);
});
