// KB-COMPAT-READY1: on the WebGL2 layer a plain Scatter takes its route once ./compat.js has loaded by import(); frames
// before it ran the WebGPU kernels on the layer, and nothing told a caller when the frames stopped changing.
// Scatter.ready settles once the route is in place, and at once on WebGPU and for the Scatters that keep the layer's
// generic tiers (subclasses, texture maps, states).
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Scatter } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const pending = Symbol('pending');
const state = (scatter) => Promise.race([scatter.ready, Promise.resolve(pending)]);
const harness = (vendor) => {
  const h = optionalGPU();
  h.engine.gpu.adapterInfo = { vendor };
  return h;
};

test('Scatter.ready is settled at once on WebGPU and before attaching', async () => {
  assert.notEqual(await state(new Scatter(box(), { count: 16 })), pending, 'before attaching');
  const h = harness('nvidia'),
    scatter = new Scatter(box(), { count: 16 });
  h.engine.use(scatter);
  assert.notEqual(await state(scatter), pending);
  assert.equal(scatter['route'], undefined, 'no route on WebGPU');
  scatter.dispose();
});

test('on the WebGL2 layer Scatter.ready waits for the route and settles with it in place', async () => {
  const h = harness('margo-webgl2'),
    scatter = new Scatter(box(), { count: 16 });
  h.engine.use(scatter);
  assert.equal(await state(scatter), pending, 'ready waits for the route');
  await scatter.ready;
  assert.ok(scatter['route'], 'the route draws from the first frame after ready');
  scatter.dispose();
});

test('a Scatter subclass keeps the generic tiers on the WebGL2 layer: ready is settled at once', async () => {
  class Tinted extends Scatter {}
  const h = harness('margo-webgl2'),
    scatter = new Tinted(box(), { count: 16 });
  h.engine.use(scatter);
  assert.notEqual(await state(scatter), pending);
  scatter.dispose();
});
