// KB-COMPAT-READY1: with the lighting feature on the WebGL2 layer, the sky's ambient projection takes its route once
// ./compat.js has loaded by import(); frames before it ran the WebGPU projection on the layer's CPU tier, and nothing
// told a caller when the ambient stopped changing. Sky.ready settles once the route is in place. Its own file: the
// route is cached per module once loaded, and this test needs the first load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const pending = Symbol('pending');
const state = (sky) => Promise.race([sky.ready, Promise.resolve(pending)]);
const harness = (vendor) => {
  const h = optionalGPU();
  h.engine.gpu.adapterInfo = { vendor };
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  return h;
};

test('Sky.ready is settled at once on WebGPU and without the lighting feature', async () => {
  const h = harness('nvidia'),
    sky = new Sky({ lighting: {}, environment: true });
  h.engine.use(sky);
  assert.notEqual(await state(sky), pending);
  sky.dispose();
  h.cleanup?.();
  assert.notEqual(await state(new Sky()), pending, 'before attaching');
});

test('on the WebGL2 layer Sky.ready waits for the ambient projection route and settles with it', async () => {
  const h = harness('margo-webgl2'),
    sky = new Sky({ lighting: {}, environment: true });
  h.engine.use(sky);
  assert.equal(await state(sky), pending, 'ready waits for the route');
  await sky.ready;
  assert.notEqual(await state(sky), pending);
  sky.dispose();
  h.cleanup?.();
});
