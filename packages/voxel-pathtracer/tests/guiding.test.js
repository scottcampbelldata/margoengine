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
    // The bounce builds the guide boxes in its own loop (one guideBox copy) and weighs them as guidePdf does.
    const mix = c.sources[0].match(/return ([\d.]+)\*base\+([\d.]+)\*pdf;/);
    assert.ok(mix, 'guidePdf mixes the cosine and box PDFs');
    assert.ok(c.sources[0].includes(`s.pdf=${mix[1]}*(max(dot(n,s.wi),0.0)*INV_PI)+${mix[2]}*pdf;`));
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

test('the lines caustic guiding adds to the shader carry no comment text (KB-WGSL1)', async () => {
  const plain = harness(),
    guided = harness();
  const tracers = [
    VoxelPathTracer.attach(plain.engine, { scene: simpleScene() }),
    GuidedVoxelPathTracer.attach(guided.engine, { scene: simpleScene() }),
  ];
  try {
    await Promise.all(tracers.map((t) => t.ready));
    const known = new Set(plain.sources[0].split('\n')),
      added = guided.sources[0].split('\n').filter((line) => !known.has(line));
    assert.ok(
      added.some((line) => line.includes('guidedRoulette')),
      'the guided shader differs from the plain one',
    );
    assert.deepEqual(
      added.filter((line) => line.includes('//')),
      [],
    );
    // No loop the guide adds leaves by `break`: the face choice did, after a `continue`, and the WebGL2 layer on ANGLE
    // Direct3D 11 then picked a wrong face (KB-VPT-GUIDE-D3D11; tests/guiding-browser.mjs has the measured leg).
    assert.deepEqual(
      added.filter((line) => /break;/.test(line)),
      [],
    );
  } finally {
    for (const tracer of tracers) tracer.dispose();
  }
});
