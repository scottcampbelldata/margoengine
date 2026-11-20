import test from 'node:test';
import assert from 'node:assert/strict';
import { audioReplay } from './workcount-replay.js';

test('pose writes use no vector iterators and preserve all parent automation bytes', () => {
  const result = audioReplay();
  assert.equal(result.iterators, 0, 'the parent starts 154500 vector iterators');
  assert.equal(result.events, 931662);
  assert.equal(result.hash, '16196051c30a9163715121ff66d1e81464af7f587e59d562fcfd314577a83202');
});
