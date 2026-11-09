import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { GuidedVoxelPathTracer } from '../dist/guiding.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';

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

test('guiding is optional, zero is exact baseline, and all mixture PDFs share the guide', async () => {
  const a = harness(),
    b = harness(),
    c = harness();
  const tracers = [
    VoxelPathTracer.attach(a.engine, { scene: simpleScene() }),
    GuidedVoxelPathTracer.attach(b.engine, { scene: simpleScene(), guideStrength: 0 }),
    GuidedVoxelPathTracer.attach(c.engine, { scene: simpleScene() }),
  ];
  try {
    await Promise.all(tracers.map((t) => t.ready));
    assert.equal(a.sources[0], b.sources[0]);
    assert.ok(tracers[2] instanceof GuidedVoxelPathTracer);
    assert.match(c.sources[0], /e.pdf=guidePdf\(o,n,wi\)/);
    assert.match(c.sources[0], /guidedSurface\(m,n,wo,etaI,p\+off,inAir\)/);
    assert.match(c.sources[0], /s.pdf=guidePdf\(o,n,s.wi\)/);
    assert.match(c.sources[0], /k<count;k\+\+/);
    assert.match(c.sources[0], /guidedRoulette\(&thr,bounces,guideRoulette\)/);
    assert.ok(c.sources[0].indexOf('fn guidePdf') < c.sources[0].indexOf('@compute @workgroup_size(8,8) fn trace'));
  } finally {
    for (const t of tracers) t.dispose();
  }
  assert.throws(() => tracers[2].setScene(simpleScene()), { code: 'disposed' });
});

test('guiding validates hostile strengths before allocating any GPU resources', () => {
  for (const guideStrength of [-1, 0.951, 1, 1e30, NaN, Infinity]) {
    const h = harness();
    assert.throws(() => GuidedVoxelPathTracer.attach(h.engine, { scene: simpleScene(), guideStrength }), RangeError);
    assert.equal(h.device.buffers.length, 0);
  }
  for (const guideStrength of [null, '0.5', false, {}])
    assert.throws(
      () => GuidedVoxelPathTracer.attach(harness().engine, { scene: simpleScene(), guideStrength }),
      TypeError,
    );
});

test('guiding strength survives device replacement and native WebGL2 has coded help', async () => {
  const h = harness(),
    t = GuidedVoxelPathTracer.attach(h.engine, { scene: simpleScene(), guideStrength: 0.95 });
  try {
    await t.ready;
    const replacement = harness();
    h.engine.gpu = replacement.device;
    h.frame();
    await t.ready;
    assert.match(replacement.sources[0], /rand\(\)<0.950000000/);
  } finally {
    t.dispose();
  }
  h.engine.gpu = undefined;
  assert.throws(
    () => GuidedVoxelPathTracer.attach(h.engine, { scene: simpleScene() }),
    (error) =>
      error.code === 'unsupported' && error.message.includes('https://margoengine.com/errors#voxel-pathtracer'),
  );
});
