// Regression (KB-FSM-DOC1): validateMachine reported problems a document does not have. A non-object document was
// reported twice; a state whose ancestor chain left the states, or met a cycle above it, was reported as being in a
// cycle; and a state's initial was refused when its descendant's chain left the states further up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMachine } from '../dist/document.js';

const doc = (states, initial = Object.keys(states)[0], extra = {}) => ({ version: 1, initial, states, ...extra });

test('a document that is not an object is one issue at "document"', () => {
  for (const value of [42, null, 'x', [], undefined])
    assert.deepEqual(validateMachine(value), [{ path: 'document', message: 'A machine is an object' }]);
});

test('a missing ancestor is reported once, on the state that names it, not as a cycle below it', () => {
  assert.deepEqual(validateMachine(doc({ a: { parent: 'b' }, b: { parent: 'zz' } })), [
    { path: 'states.b.parent', message: 'Unknown parent; name one of the states' },
  ]);
  // An initial that is not a name is refused even when a state is keyed by its string form.
  assert.deepEqual(validateMachine(doc({ x: { initial: 5 }, 5: { parent: 'x' } }, 'x')), [
    { path: 'states.x.initial', message: 'Name one of the descendants of this state' },
  ]);
  assert.deepEqual(validateMachine(doc({ x: { initial: 'y', parent: 'zz' }, y: { parent: 'x' } })), [
    { path: 'states.x.parent', message: 'Unknown parent; name one of the states' },
  ]);
});

test('a cycle is reported on its members only; a state hanging below it is not its own ancestor', () => {
  const cycle = 'Hierarchy cycle; a state cannot be its own ancestor';
  assert.deepEqual(validateMachine(doc({ a: { parent: 'b' }, b: { parent: 'c' }, c: { parent: 'b' } })), [
    { path: 'states.b.parent', message: cycle },
    { path: 'states.c.parent', message: cycle },
  ]);
  assert.deepEqual(validateMachine(doc({ a: { parent: 'a' } })), [{ path: 'states.a.parent', message: cycle }]);
  // An initial inside a cycle is not a descendant of the state naming it.
  assert.deepEqual(validateMachine(doc({ p: { initial: 'b' }, b: { parent: 'c' }, c: { parent: 'b' } })), [
    { path: 'states.p.initial', message: 'Name one of the descendants of this state' },
    { path: 'states.b.parent', message: cycle },
    { path: 'states.c.parent', message: cycle },
  ]);
});

test('a cross-fade of 0 is valid; a region nested in a state takes no version key', () => {
  assert.deepEqual(
    validateMachine(doc({ a: {}, b: {} }, 'a', { transitions: [{ from: 'a', to: 'b', event: 'go', duration: 0 }] })),
    [],
  );
  assert.deepEqual(
    validateMachine(doc({ a: {}, b: {} }, 'a', { transitions: [{ from: 'a', to: 'b', event: 'go', duration: -1 }] })),
    [{ path: 'transitions[0].duration', message: 'A cross-fade is a number of seconds, 0 or more' }],
  );
  const region = { states: { r: {} }, initial: 'r' };
  assert.deepEqual(validateMachine(doc({ p: { regions: { one: region } } })), []);
  assert.deepEqual(validateMachine(doc({ p: { regions: { one: { ...region, version: 1 } } } })), [
    { path: 'states.p.regions.one.version', message: 'Unknown key; remove it' },
  ]);
});
