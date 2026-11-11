import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { ResampledVoxelPathTracer } from '../dist/restir.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';
import { entries } from '../../../scripts/errors/entries.js';

const harness = () => {
  const device = fakeDevice(),
    sources = [],
    create = device.createShaderModule;
  device.createShaderModule = (descriptor) => {
    sources.push(descriptor.code);
    return create(descriptor);
  };
  return { ...fakeEngine(device), sources };
};

test('optional RIS kernel and exact one-candidate baseline preserve tracer identity', async () => {
  const original = harness(),
    one = harness(),
    many = harness();
  const a = VoxelPathTracer.attach(original.engine, { scene: simpleScene() });
  const b = ResampledVoxelPathTracer.attach(one.engine, { scene: simpleScene(), candidates: 1 });
  const c = ResampledVoxelPathTracer.attach(many.engine, { scene: simpleScene() });
  try {
    await Promise.all([a.ready, b.ready, c.ready]);
    assert.ok(b instanceof ResampledVoxelPathTracer);
    assert.ok(c instanceof VoxelPathTracer);
    assert.equal(original.sources[0], one.sources[0]);
    assert.ok(!original.sources[0].includes('resampledEmitter'));
    assert.match(many.sources[0], /candidate<8u/);
    assert.match(many.sources[0], /L\+=resampledEmitters\(kind,m,n,wo,o,mask\)/);
    assert.match(many.sources[0], /4.0\*light.pdfA\*d2\/cosine\+4.0\*bp/);
    // The WebGL2 route's staged programs (src/compat-staged.ts) keep the text before the `trace` entry as the prefix
    // every program shares, so a helper the variant adds must be declared there to reach the `sample` stage.
    const fragmentBoundary = many.sources[0].indexOf('@compute @workgroup_size(8,8) fn trace');
    for (const helper of ['fn directionalEmitter', 'fn resampledEmitters']) {
      const declaration = many.sources[0].indexOf(helper);
      assert.ok(declaration >= 0 && declaration < fragmentBoundary, `${helper} must be in the staged programs' shared prefix`);
    }
  } finally {
    a.dispose();
    b.dispose();
    c.dispose();
  }
  assert.throws(() => c.setScene(simpleScene()), { code: 'disposed' });
});

test('candidate validation is finite, integral and bounded before resources are allocated', () => {
  for (const candidates of [0, -1, 65, 1e30, NaN, Infinity, 1.5]) {
    const h = harness();
    assert.throws(() => ResampledVoxelPathTracer.attach(h.engine, { scene: simpleScene(), candidates }), RangeError);
    assert.equal(h.device.buffers.length, 0);
  }
  for (const candidates of [null, false, '8', {}])
    assert.throws(
      () => ResampledVoxelPathTracer.attach(harness().engine, { scene: simpleScene(), candidates }),
      TypeError,
    );
});

test('candidate limit is encoded per instance and restored after device replacement', async () => {
  const h = harness();
  const tracer = ResampledVoxelPathTracer.attach(h.engine, { scene: simpleScene(), candidates: 64 });
  try {
    await tracer.ready;
    assert.match(h.sources[0], /candidate<64u/);
    const replacement = harness();
    h.engine.gpu = replacement.device;
    h.frame();
    await tracer.ready;
    assert.match(replacement.sources[0], /candidate<64u/);
  } finally {
    tracer.dispose();
  }
});

test('native WebGL rejection carries a stable code and help link', () => {
  assert.ok(
    entries.some((entry) => entry.id === 'voxel-pathtracer'),
    'help link has a registered destination',
  );
  for (const Tracer of [VoxelPathTracer, ResampledVoxelPathTracer]) {
    const h = harness();
    h.engine.gpu = undefined;
    assert.throws(
      () => Tracer.attach(h.engine, { scene: simpleScene() }),
      (error) => {
        assert.equal(error.code, 'unsupported');
        assert.match(error.message, /https:\/\/margoengine.com\/errors#voxel-pathtracer/);
        return true;
      },
    );
  }
});
