import test from 'node:test';
import assert from 'node:assert/strict';
import { Moon, moonEarthshine, loadMoonAlbedo } from '../dist/moon.js';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';
const map = () => ({ width: 2, height: 1, data: new Uint8Array(8).fill(255) });
test('complementary Earth phase has full, quarter and new limits', () => {
  assert.equal(moonEarthshine(-1), 1);
  assert.ok(Math.abs(moonEarthshine(0) - 1 / Math.PI) < 1e-15);
  assert.ok(moonEarthshine(1) < 1e-15);
  for (const x of [NaN, Infinity, 2, -2]) assert.throws(() => moonEarthshine(x), RangeError);
});
test('moon validates texture, illumination and world orientation', () => {
  for (const options of [
    {},
    { albedo: map(), direction: [0, 0, 0] },
    { albedo: map(), north: [0, 0, 1] },
    { albedo: map(), sunDirection: [NaN, 1, 0] },
  ])
    assert.throws(() => new Moon(options));
  for (const key of ['intensity', 'earthshine', 'angularRadius'])
    for (const value of [-1, Infinity, NaN]) assert.throws(() => new Moon({ albedo: map(), [key]: value }), RangeError);
  assert.throws(() => new Moon({ albedo: { ...map(), data: new Uint8Array(4) } }), TypeError);
  const moon = new Moon({ albedo: map() });
  moon.options.angularRadius = 0;
  assert.throws(() => moon.onPreUpdate(), RangeError);
});
test('moon uploads once, replaces map, restores and disposes all owned textures', () => {
  const h = tracedGPU(),
    d = h.engine.gpu,
    uploads = [],
    destroyed = [];
  const create = d.createTexture.bind(d);
  d.createTexture = (desc) => {
    const t = create(desc);
    t.destroy = () => destroyed.push(t);
    return t;
  };
  d.queue.writeTexture = (...args) => uploads.push(args);
  const moon = new Moon({ albedo: map() });
  h.engine.use(moon);
  const frame = () => {
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  frame();
  assert.equal(uploads.length, 1);
  moon.options.albedo = map();
  frame();
  assert.equal(uploads.length, 2);
  assert.equal(destroyed.length, 1);
  moon.onDeviceRestored(h.engine);
  frame();
  assert.equal(uploads.length, 3);
  assert.equal(destroyed.length, 2);
  moon.dispose();
  moon.dispose();
  assert.equal(destroyed.length, 3);
  assert.throws(
    () => moon.setup(h.engine),
    (e) => e.code === 'disposed',
  );
});
test('moon refuses preview and albedo fetching accepts cancellation', async () => {
  assert.throws(
    () => new Moon({ albedo: map() }).setup({}),
    (e) => e.code === 'unsupported',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadMoonAlbedo('https://example.invalid/moon.jpg', { signal: controller.signal }),
    (e) => e.name === 'AbortError',
  );
});
