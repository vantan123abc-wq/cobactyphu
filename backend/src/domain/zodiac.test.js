import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZODIAC_KEYS, isValidZodiac, randomZodiac } from './zodiac.js';

test('exactly 12 real, unique zodiac keys', () => {
  assert.equal(ZODIAC_KEYS.length, 12);
  assert.equal(new Set(ZODIAC_KEYS).size, 12);
});

test('isValidZodiac accepts every real key and rejects everything else', () => {
  for (const key of ZODIAC_KEYS) {
    assert.equal(isValidZodiac(key), true);
  }
  assert.equal(isValidZodiac('unicorn'), false);
  assert.equal(isValidZodiac(null), false);
  assert.equal(isValidZodiac(undefined), false);
  assert.equal(isValidZodiac(42), false);
});

test('randomZodiac always returns one of the 12 real keys', () => {
  for (let i = 0; i < 50; i++) {
    assert.ok(ZODIAC_KEYS.includes(randomZodiac()));
  }
});
