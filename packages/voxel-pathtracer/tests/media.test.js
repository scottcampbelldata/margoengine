import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaVoxelPathTracer } from '../dist/media.js';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';

function harness() {
  const device = fakeDevice(),
    sources = [],
    create = device.createShaderModule;
  device.createShaderModule = (d) => {
    sources.push(d.code);
    return create(d);
  };
  return { ...fakeEngine(device), sources };
}
const medium = (extinction) => ({ id: 1, type: 'media', color: [0.5, 0.7, 0.9], extinction });
const input = (material) => ({ ...simpleScene(), materials: [material] });

test('media owns optional RGB transport without changing the root kernel or the caller palette', async () => {
  const h = harness(),
    base = harness(),
    s = input(medium([0, 2, 1])),
    before = structuredClone(s);
  const t = MediaVoxelPathTracer.attach(h.engine, { scene: s });
  const b = VoxelPathTracer.attach(base.engine, { scene: simpleScene() });
  try {
    await Promise.all([t.ready, b.ready]);
    assert.ok(t instanceof MediaVoxelPathTracer);
    assert.match(h.sources[0], /fn mediaExtinction/);
    assert.match(h.sources[0], /fn shadow\(o:vec3f,d:vec3f,tMax:f32\)->vec3f/);
    assert.doesNotMatch(base.sources[0], /fn mediaExtinction/);
    assert.deepEqual(s, before);
    t.setScene({ ...s, revision: 2, materials: [medium([1e6, 0, 1e-8])] });
    assert.throws(() => t.setScene({ ...s, materials: [medium([NaN, 0, 0])] }), RangeError);
    const replacement = harness();
    h.engine.gpu = replacement.device;
    h.frame();
    await t.ready;
    assert.equal(replacement.sources[0], h.sources[0]);
  } finally {
    t.dispose();
    b.dispose();
  }
  assert.throws(() => t.setScene(s), { code: 'disposed' });
});

test('media validates hostile coefficients and model palettes before GPU allocation', () => {
  for (const extinction of [
    [-1, 0, 0],
    [NaN, 0, 0],
    [Infinity, 0, 0],
    [1e6 + 1, 0, 0],
  ]) {
    const h = harness();
    assert.throws(() => MediaVoxelPathTracer.attach(h.engine, { scene: input(medium(extinction)) }), RangeError);
    assert.equal(h.device.buffers.length, 0);
  }
  for (const extinction of [null, 1, 'red', [], [1, 2], ['1', 0, 0], { length: 3 }])
    assert.throws(() => MediaVoxelPathTracer.attach(harness().engine, { scene: input(medium(extinction)) }), TypeError);
  assert.throws(
    () => MediaVoxelPathTracer.attach(harness().engine, { scene: input({ ...medium([1, 0, 0]), type: 'diffuse' }) }),
    TypeError,
  );
  const s = simpleScene();
  s.models = s.models.map((m) => ({ ...m, materials: [medium([0, -1, 0])] }));
  assert.throws(() => MediaVoxelPathTracer.attach(harness().engine, { scene: s }), RangeError);
});

test('media plain WebGL2 refusal supplies coded help', () => {
  const h = harness();
  h.engine.gpu = undefined;
  assert.throws(
    () => MediaVoxelPathTracer.attach(h.engine, { scene: simpleScene() }),
    (e) => e.code === 'unsupported' && e.message.includes('https://margoengine.com/errors#voxel-pathtracer'),
  );
});
