import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectralVoxelPathTracer } from '../dist/spectral.js';
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

test('spectral entry owns deferred wavelength transport, radiance scaling and lens without changing root', async () => {
  const h = harness(),
    base = harness(),
    scene = simpleScene(),
    before = structuredClone(scene);
  const t = SpectralVoxelPathTracer.attach(h.engine, { scene, lensAbbe: 30, focalLength: 0.05 });
  const b = VoxelPathTracer.attach(base.engine, { scene });
  try {
    await Promise.all([t.ready, b.ready]);
    assert.ok(t instanceof SpectralVoxelPathTracer);
    assert.equal(h.sources[0].match(/fn radiance\(/g).length, 1);
    assert.doesNotMatch(h.sources[0], /spectralPath|spectralLane|pathSeed|spectralDiscard/);
    assert.match(h.sources[0], /collapse\(&cameraLambda,&cameraWeight\)/);
    assert.match(h.sources[0], /var thr=cameraWeight/);
    assert.match(h.sources[0], /var lambda=cameraLambda/);
    assert.match(h.sources[0], /let w=sampleLambda\(vec2f\(rand\(\),rand\(\)\)\)/);
    assert.match(h.sources[0], /\*thr\*=spectralRgb\(w.x\)\/w.y/);
    assert.match(h.sources[0], /s\.w\*=select\(1\.0,eta\*eta,s\.transmit\)/);
    assert.match(h.sources[0], /spectralLambda=bitcast<f32>\(f\.lights\.w\)/);
    assert.match(h.sources[0], /wT\*=\(1\.0-fr\)\*ma\.ior\*ma\.ior/);
    assert.doesNotMatch(base.sources[0], /cameraLambda|spectralLambda/);
    assert.deepEqual(scene, before);
    const replacement = harness();
    h.engine.gpu = replacement.device;
    h.frame();
    await t.ready;
    assert.equal(replacement.sources[0], h.sources[0]);
  } finally {
    t.dispose();
    b.dispose();
  }
  assert.throws(() => t.setScene(scene), { code: 'disposed' });
});

test('spectral validates zero, extremes and hostile lens inputs before allocation', async () => {
  for (const lensAbbe of [-1, 1, 4.99, 201, NaN, Infinity]) {
    const h = harness();
    assert.throws(() => SpectralVoxelPathTracer.attach(h.engine, { scene: simpleScene(), lensAbbe }), RangeError);
    assert.equal(h.device.buffers.length, 0);
  }
  for (const focalLength of [0, -1, 1e-7, 1e6 + 1, NaN, Infinity])
    assert.throws(
      () => SpectralVoxelPathTracer.attach(harness().engine, { scene: simpleScene(), focalLength }),
      RangeError,
    );
  for (const key of ['lensAbbe', 'focalLength'])
    for (const value of [null, '5', {}, []])
      assert.throws(
        () => SpectralVoxelPathTracer.attach(harness().engine, { scene: simpleScene(), [key]: value }),
        TypeError,
      );
  for (const [lensAbbe, focalLength] of [
    [0, 0.05],
    [5, 1e-6],
    [200, 1e6],
  ]) {
    const t = SpectralVoxelPathTracer.attach(harness().engine, { scene: simpleScene(), lensAbbe, focalLength });
    await t.ready;
    t.dispose();
  }
});

test('spectral plain WebGL2 supplies coded help', () => {
  const h = harness();
  h.engine.gpu = undefined;
  assert.throws(
    () => SpectralVoxelPathTracer.attach(h.engine, { scene: simpleScene() }),
    (e) => e.code === 'unsupported' && e.message.includes('https://margoengine.com/errors#voxel-pathtracer'),
  );
});
