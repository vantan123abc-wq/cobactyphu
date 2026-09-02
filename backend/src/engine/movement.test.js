import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movePlayer } from './movement.js';

test('moves forward by steps without wrapping', () => {
  const { newPosition, passedGo } = movePlayer(0, 7, 36);
  assert.equal(newPosition, 7);
  assert.equal(passedGo, false);
});

test('wraps around the board and reports passing GO', () => {
  const { newPosition, passedGo } = movePlayer(30, 8, 36); // 30+8=38, 38%36=2
  assert.equal(newPosition, 2);
  assert.equal(passedGo, true);
});

test('landing exactly on GO after a wrap still counts as passing GO', () => {
  const { newPosition, passedGo } = movePlayer(30, 6, 36); // 30+6=36, %36=0
  assert.equal(newPosition, 0);
  assert.equal(passedGo, true);
});

test('works identically for the Large (44-tile) board', () => {
  const { newPosition, passedGo } = movePlayer(40, 9, 44); // 40+9=49, 49%44=5
  assert.equal(newPosition, 5);
  assert.equal(passedGo, true);
});

test('rejects a board size other than the two approved configurations', () => {
  assert.throws(() => movePlayer(0, 5, 40)); // 40 was the superseded single-board value
  assert.throws(() => movePlayer(0, 5, 32));
});

test('rejects an out-of-range current position', () => {
  assert.throws(() => movePlayer(36, 5, 36));
  assert.throws(() => movePlayer(-1, 5, 36));
});

// Rewritten 2026-08-25 (was: "rejects a steps value outside the valid 1-12
// range", asserting movePlayer(0, 13, 36) throws). 12 was the dice maximum,
// but this function is shared with card-driven movement — C02 walks the whole
// board looking for the nearest unowned property and legitimately needs more
// than 12, which used to crash the draw. The real bound is the board itself.
test('rejects a steps value outside the valid 1..boardTileCount range', () => {
  assert.throws(() => movePlayer(0, 0, 36));
  assert.throws(() => movePlayer(0, -1, 36));
  assert.throws(() => movePlayer(0, 37, 36));
  assert.throws(() => movePlayer(0, 1.5, 36));
});

test('allows a card-driven move longer than any dice total (C02 can need most of the board)', () => {
  const { newPosition, passedGo } = movePlayer(30, 31, 36); // 30 + 31 = 61 -> wraps to 25
  assert.equal(newPosition, 25);
  assert.equal(passedGo, true);

  // The far edge: all the way around, back onto the same tile, still passing GO.
  const full = movePlayer(7, 36, 36);
  assert.equal(full.newPosition, 7);
  assert.equal(full.passedGo, true);
});

test('allows a single-tile step — below a real dice total, but valid for card-driven relative movement', () => {
  const { newPosition, passedGo } = movePlayer(0, 1, 36);
  assert.equal(newPosition, 1);
  assert.equal(passedGo, false);
});
