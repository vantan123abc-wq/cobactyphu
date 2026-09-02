import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToJail, payFine, useCard, rollForExit, JAIL_FINE, MAX_JAIL_TURNS } from './jail.js';
import { createPlayerGameState } from '../domain/gameState.js';
import { rollDice } from './dice.js';

function player(overrides = {}) {
  return createPlayerGameState({
    id: 'gp1',
    gameId: 'g1',
    playerId: 'profile1',
    currentBalance: 1500,
    currentPosition: 22,
    ...overrides,
  });
}

test('sendToJail relocates to the jail tile, sets inJail, resets jailTurns', () => {
  const before = player({ currentPosition: 22, jailTurns: 2 });
  const after = sendToJail(before, 10);

  assert.equal(after.inJail, true);
  assert.equal(after.currentPosition, 10);
  assert.equal(after.jailTurns, 0);
});

test('payFine releases immediately and reports JAIL_FINE owed', () => {
  const inJail = player({ inJail: true, jailTurns: 1 });
  const { player: after, fineOwed } = payFine(inJail);

  assert.equal(after.inJail, false);
  assert.equal(after.jailTurns, 0);
  assert.equal(fineOwed, JAIL_FINE);
});

test('payFine on a player not in jail throws', () => {
  assert.throws(() => payFine(player({ inJail: false })));
});

test('useCard releases immediately with no fine owed', () => {
  const inJail = player({ inJail: true, jailTurns: 1 });
  const after = useCard(inJail);

  assert.equal(after.inJail, false);
  assert.equal(after.jailTurns, 0);
});

test('useCard on a player not in jail throws', () => {
  assert.throws(() => useCard(player({ inJail: false })));
});

test('rollForExit releases on doubles, no fine owed', () => {
  const inJail = player({ inJail: true, jailTurns: 1 });
  const { player: after, released, fineOwed } = rollForExit(inJail, { isDouble: true });

  assert.equal(after.inJail, false);
  assert.equal(after.jailTurns, 0);
  assert.equal(released, true);
  assert.equal(fineOwed, null);
});

test('rollForExit on a failed (non-double) roll under MAX_JAIL_TURNS stays in jail, no fine', () => {
  const inJail = player({ inJail: true, jailTurns: 0 });
  const { player: after, released, fineOwed } = rollForExit(inJail, { isDouble: false });

  assert.equal(after.inJail, true);
  assert.equal(after.jailTurns, 1);
  assert.equal(released, false);
  assert.equal(fineOwed, null);
});

test('the 3rd failed roll attempt force-releases and charges JAIL_FINE', () => {
  let current = player({ inJail: true, jailTurns: 0 });

  for (let attempt = 1; attempt < MAX_JAIL_TURNS; attempt++) {
    const result = rollForExit(current, { isDouble: false });
    assert.equal(result.released, false);
    current = result.player;
  }
  assert.equal(current.jailTurns, MAX_JAIL_TURNS - 1);

  const final = rollForExit(current, { isDouble: false });
  assert.equal(final.released, true);
  assert.equal(final.fineOwed, JAIL_FINE);
  assert.equal(final.player.inJail, false);
  assert.equal(final.player.jailTurns, 0);
});

test('rollForExit on a player not in jail throws', () => {
  assert.throws(() => rollForExit(player({ inJail: false }), { isDouble: true }));
});

test('integrates with dice.js: a real doubles roll releases via rollForExit', () => {
  const inJail = player({ inJail: true, jailTurns: 2 });
  // Fixed sequence forcing die1 === die2 (a double), independent of dice.js's default RNG.
  const fixedRoll = rollDice(0, () => 0.5); // both dice land on the same face
  assert.equal(fixedRoll.isDouble, true);

  const { released } = rollForExit(inJail, fixedRoll);
  assert.equal(released, true);
});
