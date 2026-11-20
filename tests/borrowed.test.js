import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { borrow, fix, isOptionObject, lend, relend } from '../packages/shared/borrowed.js';

// docs/conventions.md, "Borrowed GPU objects" (KB-RESTORE-BORROWED1). Devices and objects are plain stand-ins: the
// helper compares identities and never calls a GPU method.
const device = (label) => ({ label });
const reporter = () => {
  const errors = [];
  return { errors, onError: (error) => errors.push(error) };
};

test('a function is called once per device, again after a restore, and never reported', () => {
  const a = device('a'),
    b = device('b'),
    engine = reporter(),
    calls = [];
  const slot = borrow((d) => (calls.push(d), { texture: d.label }), 'Layer atlas', 'setAtlas');
  assert.deepEqual(lend(slot, a, engine), { texture: 'a' });
  assert.equal(lend(slot, a, engine), lend(slot, a, engine));
  assert.deepEqual(lend(slot, b, engine), { texture: 'b' });
  lend(slot, b, engine);
  assert.deepEqual(calls, [a, b]);
  assert.equal(engine.errors.length, 0);
});

test('a plain object is lent on its own device, then dropped and reported once on a new one', () => {
  const a = device('a'),
    b = device('b'),
    engine = reporter(),
    texture = { texture: 'plain' };
  const slot = borrow(texture, 'SpriteLayer atlas', 'setAtlas');
  assert.equal(lend(slot, a, engine), texture);
  assert.equal(lend(slot, a, engine), texture);
  assert.equal(lend(slot, b, engine), undefined);
  assert.equal(lend(slot, b, engine), undefined);
  assert.equal(engine.errors.length, 1);
  const [error] = engine.errors;
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'state');
  assert.equal(
    error.message,
    'SpriteLayer atlas lost with the device; pass a function or call setAtlas; see https://margoengine.com/errors#borrowed-lost',
  );
});

test('an object given before attach belongs to the device fixed at setup, not the first one lent', () => {
  const a = device('a'),
    b = device('b'),
    engine = reporter(),
    texture = {};
  const slot = borrow(texture, 'Decals atlas', 'setAtlas', a);
  assert.equal(lend(slot, b, engine), undefined);
  assert.equal(engine.errors.length, 1);
  // fix at setup: given before attach, set up on a, restored to b before the first frame.
  const early = borrow(texture, 'Decals atlas', 'setAtlas');
  fix(early, a);
  assert.equal(lend(early, b, engine), undefined);
  assert.equal(engine.errors.length, 2);
  // fix leaves a function alone, so the first lend still calls it.
  const made = borrow((d) => ({ on: d }), 'Decals atlas', 'setAtlas');
  fix(made, a);
  assert.deepEqual(lend(made, a, engine), { on: a });
});

test('a setter called before or after the owner sees the new device both work', () => {
  const a = device('a'),
    b = device('b'),
    engine = reporter();
  // The caller's hook runs first: the new object is recorded under engine.gpu, the new device, before any frame.
  const first = borrow({ id: 1 }, 'Layer atlas', 'setAtlas', a);
  const fresh = { id: 2 };
  relend(first, fresh, b);
  assert.equal(lend(first, b, engine), fresh);
  // The owner's frame runs first: the old object is reported, then the caller's setter brings drawing back.
  const second = borrow({ id: 3 }, 'Layer atlas', 'setAtlas', a);
  assert.equal(lend(second, b, engine), undefined);
  relend(second, fresh, b);
  assert.equal(lend(second, b, engine), fresh);
  assert.equal(engine.errors.length, 1);
  // A setter given a function forgets the device: the function makes the object for the device of the next lend.
  relend(second, (d) => ({ on: d }), b);
  assert.deepEqual(lend(second, b, engine), { on: b });
});

test('an empty slot lends nothing and reports nothing; a missing engine is not called', () => {
  const engine = reporter();
  assert.equal(lend(borrow(undefined, 'x', 'y'), device('a'), engine), undefined);
  assert.equal(lend(borrow(null, 'x', 'y'), device('a'), engine), undefined);
  assert.equal(engine.errors.length, 0);
  assert.equal(lend(borrow({}, 'x', 'y', device('a')), device('b')), undefined);
});

test('isOptionObject: a plain object from any realm is an options object; a GPU object or any class instance is not (KB-COMPAT-RAWFIRST1)', () => {
  class LayerTexture {
    texture = { gl: true };
    createView() {}
  }
  assert.equal(isOptionObject({ texture: null }), true);
  assert.equal(isOptionObject(Object.create(null)), true);
  assert.equal(isOptionObject(runInNewContext('({ texture: null })')), true, 'another realm');
  assert.equal(isOptionObject(new LayerTexture()), false, "a texture whose own field is called 'texture'");
  for (const v of [null, undefined, 0, 'texture', [], () => {}, new Map()]) assert.equal(isOptionObject(v), false);
});
