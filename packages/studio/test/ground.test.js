import test from 'node:test';
import assert from 'node:assert/strict';
import { GroundShadows } from '../dist/ground.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
function setup(direction = [1, 2, 0], options = {}) {
  const h = optionalGPU(),
    radiance = new Float32Array(27);
  radiance.fill(1, 0, 3);
  [3, 1, 2].forEach((band, i) => radiance.fill(direction[i], band * 3, band * 3 + 3));
  const environment = { sh: { radiance }, rotation: 0, intensity: 1 };
  const effect = GroundShadows.attach(h.engine, {
    environment,
    resolution: 16,
    static: true,
    size: 4,
    height: 2,
    blur: 0,
    ...options,
  });
  const node = {
    id: 0,
    engine: h.engine,
    matrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    check() {},
  };
  const vertex = h.engine.gpu.createBuffer({ size: 72, usage: GPUBufferUsage.VERTEX }),
    index = h.engine.gpu.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX });
  const remove = effect.add({ shadowPrimitives: [{ node, vertex, index, count: 3, stride: 24 }] });
  h.context.camera.position = [0, 5, 4];
  const frame = () => h.engine.frameGraph.execute(h.context);
  return { h, effect, environment, frame, remove };
}
test('HDR first moment projects along light rays and rotates with the live environment', () => {
  const s = setup();
  try {
    s.frame();
    const b = s.h.resources.find((r) => r.size === 144),
      read = () => new Float32Array(b.data, 0, 16);
    const project = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    assert.deepEqual(project(read(), [0, 1, 0]), [-0.25, 0, 0.5], 'ray opposite (1,2,0) reaches x=-0.5');
    s.frame();
    assert.equal(s.effect.stats.updates, 1, 'static history is reused');
    s.environment.rotation = Math.PI;
    s.frame();
    assert(Math.abs(project(read(), [0, 1, 0])[0] - 0.25) < 1e-7);
    assert.equal(s.effect.stats.updates, 2, 'rotation invalidates a static shadow');
    s.environment.sh.radiance.fill(0, 3);
    s.frame();
    assert.equal(s.effect.coverageScale(), 0, 'isotropic light has no arbitrary directional shadow');
    s.environment.sh.radiance.fill(2, 3, 6);
    s.environment.intensity = 0;
    s.frame();
    assert.equal(s.effect.coverageScale(), 0, 'a dark environment casts no shadow');
  } finally {
    s.effect.dispose();
    s.h.cleanup();
  }
});
test('HDR direction respects an arbitrary receiver normal and rejects invalid source data', () => {
  const s = setup([2, 1, 0], { up: [1, 0, 0] });
  try {
    s.frame();
    assert.equal(s.effect.coverageScale(), 1);
    s.environment.sh.radiance[3] = NaN;
    assert.throws(s.frame, RangeError);
  } finally {
    s.effect.dispose();
    s.h.cleanup();
  }
});

test('ground receiver refuses native preview and malformed options without GPU allocations', () => {
  assert.throws(() => new GroundShadows(null), RangeError);
  assert.throws(() => new GroundShadows([]), RangeError);
  const effect = new GroundShadows();
  assert.throws(
    () => effect.setup({}),
    (e) => e.code === 'unsupported' && e.message.includes('https://margoengine.com/errors#unsupported'),
  );
  const h = optionalGPU();
  assert.throws(
    () => GroundShadows.attach(h.engine),
    (e) => e.code === 'state',
  );
  h.cleanup();
});
