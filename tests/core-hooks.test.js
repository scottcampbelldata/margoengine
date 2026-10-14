import test from 'node:test';
import assert from 'node:assert/strict';
import {Camera} from '../packages/core/dist/camera.js';
import {Engine} from '../packages/core/dist/engine.js';
import {TransformStore} from '../packages/core/dist/kernel.js';

test('camera up vector allows exact straight-down views; default up is unchanged', () => {
  const a = new Camera({position: [3, 4, 5], target: [0, 0, 0]}), b = new Camera({position: [3, 4, 5], target: [0, 0, 0]});
  b.up = [0, 1, 0]; a.update(1.5, true); b.update(1.5, true); assert.deepEqual(a.matrix, b.matrix);
  const top = new Camera({position: [0, 10, 0], target: [0, 0, 0]});
  assert.throws(() => top.update(1, true), /Vertical camera/);
  top.up = [0, 0, -1]; top.update(1, true); assert.ok(top.matrix.every(Number.isFinite));
});

test('projection hook replaces perspective and still yields frustum planes', () => {
  const camera = new Camera({position: [0, 0, 10], target: [0, 0, 0]});
  camera.project = (out) => {out[0] = 0.1; out[5] = 0.1; out[10] = 0.01; out[14] = 0.5; out[15] = 1;}; // orthographic, reversed-Z style
  camera.update(1, true); assert.equal(camera.matrix[15], 1, 'w row is orthographic'); assert.ok(camera.planes.every(Number.isFinite));
});

test('pace skips refreshes and delta spans them; plugins are readable', async () => {
  const frames = [], saved = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => frames.push(callback); globalThis.cancelAnimationFrame = () => {};
  const engine = new Engine({width: 4, height: 4, clientWidth: 4, clientHeight: 4}, await TransformStore.create(4), {backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {}}, undefined, null);
  try {
    const deltas = []; engine.onFrame((_, delta) => deltas.push(delta)); let refresh = 0; engine.pace = () => refresh++ % 2 === 0;
    engine.use({name: 'probe', setup() {}}); assert.equal(engine.plugins.get('probe').name, 'probe');
    engine.start(); for (let t = 0; t <= 6; t++) frames.shift()(t * 1000 / 120);
    assert.equal(deltas.length, 4, 'every other refresh renders');
  } finally {engine.dispose(); globalThis.requestAnimationFrame = saved;}
});
