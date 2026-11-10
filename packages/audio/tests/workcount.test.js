import test from 'node:test';
import assert from 'node:assert/strict';
import { audioReplay } from './workcount-replay.js';

test('pose writes use no vector iterators and preserve all parent automation bytes', () => {
  const result = audioReplay();
  assert.equal(result.iterators, 0, 'the parent starts 154500 vector iterators');
  assert.equal(result.events, 931662);
  assert.equal(result.hash, '3468f19ee9de8dea6679e6814e1b6163b2fd3441c34607da58f59b183e95d836');
});
