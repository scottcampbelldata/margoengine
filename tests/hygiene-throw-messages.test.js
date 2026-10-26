// Regression: the hygiene "message names no fix" count read only the literal up to the first interpolation, so
// `bad value ${x}; pass a number` and `'bad ' + x + '; pass a number'` were counted as naming no fix.
import assert from 'node:assert/strict';
import test from 'node:test';
import { countNoFix } from '../scripts/support/throw-messages.js';

test('a fix after an interpolated variable is read', () => {
  assert.equal(countNoFix('throw new RangeError(`bad value ${x}; pass a number`);'), 0);
  assert.equal(countNoFix('throw new TypeError(`value ${x} is bad, use a number`);'), 0);
});

test('a fix after a concatenated variable or call is read', () => {
  assert.equal(countNoFix("throw new Error('bad ' + name + ', pass a number');"), 0);
  assert.equal(
    countNoFix("throw new Error('bad ' + String(x) + ' in ' + f(a, b) + ' and you must pass a number');"),
    0,
  );
  assert.equal(countNoFix("throw new MargoError('BAD_VALUE', 'bad ' + x + ' , use a number');"), 0);
});

test('a fix after a nested template or string substitution is read', () => {
  assert.equal(countNoFix('throw new Error(`bad ${a ? `one ${b}` : "two"} then pass a number`);'), 0);
  assert.equal(countNoFix('throw new Error(`bad ${list.join(", ")} items; fix them`);'), 0);
});

test('a message split over several lines is read as one', () => {
  assert.equal(countNoFix("throw new Error(\n  'bad value ' +\n    x +\n    '; pass a number',\n);"), 0);
});

test('messages that really name no fix are still counted', () => {
  assert.equal(countNoFix('throw new Error(`bad value ${x}`);'), 1);
  assert.equal(countNoFix("throw new RangeError('bad ' + x + ' in ' + y);"), 1);
  assert.equal(countNoFix("throw new MargoError('BAD_VALUE', `bad ${x} here`);"), 1);
  assert.equal(countNoFix('throw new Error(`bad ${list.join("; ")} here`);'), 1); // the "; " is code, not message
  assert.equal(countNoFix("throw new Error('bad ' + f(a, 'use it') + ' here');"), 1);
});

test('only the message argument counts, not later arguments', () => {
  assert.equal(countNoFix("throw new Error('bad value ' + x, { cause: 'you must pass a number' });"), 1);
});

test('a message that is only a variable is not counted', () => {
  assert.equal(countNoFix('throw new Error(message);'), 0);
  assert.equal(countNoFix("throw new MargoError(code, 'bad');"), 0);
});
