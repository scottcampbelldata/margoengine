import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { TrampledScatter } from '../dist/interact.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('trample inputs must survive GPU float conversion and have every vector component', () => {
  for (const size of [Number.MIN_VALUE, 1e-320, Number.MAX_VALUE, 1e40])
    assert.throws(() => new TrampledScatter(box(), {}, { size }), RangeError);
  assert.throws(() => new TrampledScatter(box(), {}, { bend: Number.MIN_VALUE }), RangeError);
  const effect = new TrampledScatter(box());
  for (const mover of [
    { position: new Array(3), radius: 1 },
    { position: [0, 0, Number.MAX_VALUE], radius: 1 },
    { position: [0, 0, 0], radius: Number.MAX_VALUE },
    { position: [0, 0, 0], radius: Number.MIN_VALUE },
    { position: [0, 0, 0], radius: 1, strength: '0.5' },
  ]) assert.throws(() => effect.setInteractors([mover]), RangeError);
  assert.throws(() => effect.setInteractors(new Array(1)), TypeError);
  effect.dispose();
});

test('a rejected interactor list preserves all of the last successful upload', () => {
  const h = optionalGPU(), effect = new TrampledScatter(box(), { count: 1 }, { resolution: 8 });
  effect.setInteractors([
    { position: [2, 0, 3], radius: 4, strength: 0.5 },
    { position: [7, 0, 8], radius: 2 },
  ]);
  h.engine.use(effect);
  h.frame();
  const moverBuffer = h.resources.find(r => r.size === 64 && new Float32Array(r.data)[0] === 2);
  assert.ok(moverBuffer, 'the mover upload');
  const before = Array.from(new Float32Array(moverBuffer.data));
  assert.throws(() => effect.setInteractors([
    { position: [9, 0, 9], radius: 2 }, { position: [0, NaN, 0], radius: 1 },
  ]), RangeError);
  h.frame();
  assert.deepEqual(Array.from(new Float32Array(moverBuffer.data)), before);
  effect.dispose();
});

test('camera moves with no field overlap cannot wrap through a signed 32-bit shift', () => {
  const h = optionalGPU(), effect = new TrampledScatter(box(), { count: 1 }, { resolution: 16, size: 8 });
  h.engine.use(effect);
  h.frame();
  h.engine.camera.position[0] = 2 ** 31;
  h.engine.camera.position[2] = -(2 ** 31);
  h.frame();
  const uniform = h.resources.find(r => r.size === 48 && new Int32Array(r.data)[5] === 16);
  assert.ok(uniform);
  const words = new Int32Array(uniform.data);
  assert.deepEqual(Array.from(words.subarray(2, 4)), [16, -16]);
  effect.dispose();
});

test('interaction restoration retains valid interactors and terminal disposal releases every resource', () => {
  const h = optionalGPU(), effect = new TrampledScatter(box(), { count: 1 }, { resolution: 8 });
  effect.setInteractors([{ position: [2, 0, 3], radius: 4 }]);
  h.engine.use(effect);
  h.frame();
  const oldField = effect.field;
  effect.onDeviceRestored(h.engine);
  assert.ok(oldField.destroyed);
  h.frame();
  assert.notEqual(effect.field, oldField);
  const uploads = h.resources.filter(r => r.size === 16 && new Float32Array(r.data)[0] === 2);
  assert.equal(uploads.length, 2);
  assert.deepEqual(Array.from(new Float32Array(uploads[1].data)), [2, 3, 4, 1]);
  effect.dispose();
  effect.dispose();
  assert.ok(h.resources.every(r => r.destroyed));
  assert.throws(() => effect.setup(h.engine), e => e.code === 'disposed' && /https:/.test(e.message));
});
