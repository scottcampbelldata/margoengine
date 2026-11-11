import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { resampledEmitters, ResampledVoxelPathTracer } from '../dist/resampled.js';
import { causticGuiding, GuidedVoxelPathTracer } from '../dist/guiding.js';
import { coloredMedia, MediaVoxelPathTracer } from '../dist/media.js';
import { triangleMeshes, MeshPathTracer } from '../dist/mesh.js';
import { spectralTransport, SpectralVoxelPathTracer } from '../dist/spectral.js';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';

const factories = [resampledEmitters, triangleMeshes, coloredMedia, causticGuiding, spectralTransport];
const signatures = ['fn resampledEmitters', 'fn meshClosest', 'fn mediaIntegral', 'fn guidePdf', 'spectralLambda'];

test('feature factories reject malformed option containers before specialization', () => {
  for (const make of [resampledEmitters, causticGuiding, spectralTransport])
    for (const options of [null, false, 0, 'settings', [], () => {}]) assert.throws(() => make(options), TypeError);
});
const scene = () => ({
  ...simpleScene(),
  meshes: [
    {
      id: 'panel',
      material: 1,
      positions: new Float32Array([-2, 0, -2, 2, 0, -2, 0, 0, 2]),
      indices: new Uint32Array([0, 2, 1]),
    },
  ],
});
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

test('all 32 feature subsets compose in a fixed order, with no unselected kernels', async () => {
  for (let mask = 0; mask < 32; mask++) {
    const selected = factories.filter((_, i) => mask & (1 << i)).map((make) => make());
    const a = harness(),
      b = harness();
    const t = await ComposedVoxelPathTracer.create(a.engine, { scene: scene(), features: selected });
    const u = await ComposedVoxelPathTracer.create(b.engine, { scene: scene(), features: selected.toReversed() });
    try {
      await Promise.all([t.ready, u.ready]);
      assert.equal(a.sources[0], b.sources[0], `order ${mask}`);
      for (let i = 0; i < factories.length; i++)
        assert.equal(a.sources[0].includes(signatures[i]), Boolean(mask & (1 << i)), `${mask}: ${signatures[i]}`);
      if ((mask & 6) === 6)
        assert.match(a.sources[0], /fn shadow\([^\n]+->vec3f \{\n if\(meshOccludes[^\n]+return vec3f\(0.0\)/);
      if ((mask & 3) === 3) assert.match(a.sources[0], /if\(h.inst>=TRIANGLE\|\|h.value==0u\)/);
    } finally {
      t.dispose();
      u.dispose();
    }
    assert.ok(a.device.buffers.every((b) => b.destroyed));
  }
});

test('single features retain the exact standalone specialization', async () => {
  for (const [make, Tracer] of [
    [resampledEmitters, ResampledVoxelPathTracer],
    [triangleMeshes, MeshPathTracer],
    [coloredMedia, MediaVoxelPathTracer],
    [causticGuiding, GuidedVoxelPathTracer],
    [spectralTransport, SpectralVoxelPathTracer],
    [undefined, VoxelPathTracer],
  ]) {
    const a = harness(),
      b = harness();
    const t = await ComposedVoxelPathTracer.create(a.engine, { scene: scene(), features: make ? [make()] : [] });
    const u = Tracer.create
      ? await Tracer.create(b.engine, { scene: scene() })
      : Tracer.attach(b.engine, { scene: scene() });
    try {
      await Promise.all([t.ready, u.ready]);
      assert.equal(a.sources[0], b.sources[0]);
    } finally {
      t.dispose();
      u.dispose();
    }
  }
});

test('composed scene updates copy inputs, convert RGB palettes, preserve geometry and restore every feature', async () => {
  const h = harness(),
    s = scene();
  s.materials.push({ id: 2, type: 'media', color: [0.2, 0.5, 0.8], extinction: [1, 2, 3] });
  const t = await ComposedVoxelPathTracer.create(h.engine, { scene: s, features: factories.map((make) => make()) });
  try {
    await t.ready;
    const bytes = t.stats.gpuBytes,
      original = h.sources[0];
    s.materials[1].extinction[0] = -1;
    await assert.rejects(t.setScene(s), RangeError);
    assert.equal(t.stats.sceneRevision, 1);
    const updated = scene();
    updated.revision = 2;
    updated.models[0].contentKey = {};
    const pending = t.setScene(updated);
    updated.meshes[0].positions.fill(NaN);
    await pending;
    assert.equal(t.stats.sceneRevision, 2);
    assert.equal(t.stats.gpuBytes, bytes);
    const replacement = harness();
    h.engine.gpu = replacement.device;
    h.frame();
    await t.ready;
    assert.equal(replacement.sources[0], original);
    const empty = { ...scene(), revision: 3, meshes: [] };
    const a = t.setScene(empty),
      b = t.setScene({ ...scene(), revision: 4 });
    await Promise.all([a, b]);
    assert.equal(t.stats.sceneRevision, 4);
    const c = t.setScene({ ...scene(), revision: 5 });
    t.dispose();
    await assert.rejects(c, { code: 'disposed' });
    await assert.rejects(t.setScene(scene()), { code: 'disposed' });
  } finally {
    t.dispose();
  }
});

test('composition validates identities, feature options, palettes and cancellation before allocating GPU resources', async () => {
  for (const features of [
    null,
    {},
    [null],
    [{ id: 'other', source: (s) => s }],
    [coloredMedia(), coloredMedia()],
    [{ ...coloredMedia(), geometry: async () => new Uint32Array(0) }],
  ]) {
    const h = harness();
    await assert.rejects(ComposedVoxelPathTracer.create(h.engine, { scene: scene(), features }), TypeError);
    assert.equal(h.device.buffers.length, 0);
  }
  for (const [make, key] of [
    [resampledEmitters, 'candidates'],
    [causticGuiding, 'guideStrength'],
    [spectralTransport, 'lensAbbe'],
  ])
    for (const value of [null, NaN, Infinity, -1, '1']) assert.throws(() => make({ [key]: value }));
  const h = harness(),
    signal = AbortSignal.abort(new Error('cancel geometry'));
  await assert.rejects(
    ComposedVoxelPathTracer.create(h.engine, { scene: scene(), features: [triangleMeshes()], signal }),
    /cancel geometry/,
  );
  assert.equal(h.device.buffers.length, 0);
});
