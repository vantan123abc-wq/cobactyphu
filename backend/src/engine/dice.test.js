import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollDice, MAX_CONSECUTIVE_DOUBLES } from './dice.js';

// Math.floor(x * 6) + 1 === value  <=>  x in [(value-1)/6, value/6)
function forDie(value) {
  return (value - 1) / 6;
}

function fixedRandom(sequence) {
  let i = 0;
  return () => sequence[i++ % sequence.length];
}

test('die values are always within 1-6 across many real rolls', () => {
  for (let i = 0; i < 500; i++) {
    const { die1, die2 } = rollDice();
    assert.ok(die1 >= 1 && die1 <= 6);
    assert.ok(die2 >= 1 && die2 <= 6);
  }
});

test('total equals die1 + die2', () => {
  const { die1, die2, total } = rollDice();
  assert.equal(total, die1 + die2);
});

test('isDouble is true when both dice match (deterministic)', () => {
  const roll = rollDice(0, fixedRandom([forDie(4), forDie(4)]));
  assert.equal(roll.die1, 4);
  assert.equal(roll.die2, 4);
  assert.equal(roll.isDouble, true);
});

test('isDouble is false when dice differ, and streak resets', () => {
  const roll = rollDice(0, fixedRandom([forDie(2), forDie(5)]));
  assert.equal(roll.isDouble, false);
  assert.equal(roll.doublesStreak, 0);
  assert.equal(roll.sentToJail, false);
});

test('a fresh double sets doublesStreak to 1, no jail', () => {
  const roll = rollDice(0, fixedRandom([forDie(3), forDie(3)]));
  assert.equal(roll.doublesStreak, 1);
  assert.equal(roll.sentToJail, false);
});

test('a 2nd consecutive double is still allowed (streak reaches MAX_CONSECUTIVE_DOUBLES)', () => {
  const roll = rollDice(1, fixedRandom([forDie(5), forDie(5)]));
  assert.equal(roll.doublesStreak, MAX_CONSECUTIVE_DOUBLES);
  assert.equal(roll.sentToJail, false);
});

test('a 3rd consecutive double sends the player to jail instead of continuing', () => {
  const roll = rollDice(2, fixedRandom([forDie(6), forDie(6)]));
  assert.equal(roll.sentToJail, true);
  assert.equal(roll.doublesStreak, 0); // reset — the turn ends in jail, not another roll
});

test('rejects a negative or non-integer doublesStreak', () => {
  assert.throws(() => rollDice(-1));
  assert.throws(() => rollDice(1.5));
});
