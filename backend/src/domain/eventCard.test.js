import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventCard, EVENT_CARD_EFFECT_TYPES } from './eventCard.js';

test('constructs a pay-effect chance card', () => {
  const card = createEventCard({
    id: 'c1',
    deck: 'chance',
    text: 'Placeholder card text',
    effect: { type: 'pay', amount: 50 },
  });

  assert.equal(card.deck, 'chance');
  assert.equal(card.effect.amount, 50);
});

test('constructs a no-parameter effect (go_to_jail) on the fortune deck', () => {
  const card = createEventCard({
    id: 'c2',
    deck: 'fortune',
    text: 'Placeholder card text',
    effect: { type: 'go_to_jail' },
  });

  assert.equal(card.deck, 'fortune');
  assert.equal(card.effect.type, 'go_to_jail');
});

test('every declared effect type constructs without throwing', () => {
  for (const type of EVENT_CARD_EFFECT_TYPES) {
    assert.doesNotThrow(() =>
      createEventCard({ id: 'c', deck: 'chance', text: 'x', effect: { type } })
    );
  }
});

test('rejects an unknown deck, including the stale community_chest naming', () => {
  assert.throws(() =>
    createEventCard({ id: 'c', deck: 'community_chest', text: 'x', effect: { type: 'go_to_jail' } })
  );
});

test('rejects an unknown or missing effect type', () => {
  assert.throws(() =>
    createEventCard({ id: 'c', deck: 'chance', text: 'x', effect: { type: 'do_something_else' } })
  );
  assert.throws(() => createEventCard({ id: 'c', deck: 'chance', text: 'x' }));
});
