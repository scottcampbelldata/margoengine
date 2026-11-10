import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { load } from '../../../examples/package-benchmarks/proofs/compare.js';
import { SceneTarget } from '../../shared/msaa.js';
import { VolumetricFog } from '../dist/volumetric.js';

// Same shipped entry before the change, built from this repository, never a rival implementation.
const { VolumetricFog: Parent } = await load('environment', 'src/volumetric.ts', '960bb4f9b');
function story(Fog, samples, defaults) {
  const gpu = mockGPU(), view = context(gpu, { samples, format: 'rgba16float' }),
    grid = [16, 12, 8], options = defaults ? {} : { grid },
    engine = { gpu: gpu.device, plugins: new Map(), lighting: {
      direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]),
    }, sceneOf() { return this; }, removePlugin() {} },
    fog = new Fog(options);
  let joins = 0;
  Object.defineProperty(grid, 'join', { value(...args) { joins++; return Array.prototype.join.apply(this, args); } });
  const log = gpu.record(() => {
    fog.setup(engine);
    const run = passes(fog);
    for (let i = 0; i < 12; i++) {
      if (i === 3) { grid[0] = 24; options.density = 0.04; }
      if (i === 5) { options.color = [0.5, 0.7, 1]; options.temporal = 0; }
      if (i === 7) { view.state.width = 641; view.state.height = 359; }
      if (i === 9) fog.onDeviceRestored(engine);
      view.begin(i);
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
      const target = new SceneTarget(gpu.device,
        gpu.device.createTexture({ size: [view.c.width, view.c.height], format: 'rgba16float', usage }),
        gpu.device.createTexture({ size: [view.c.width, view.c.height], format: 'depth32float', usage }), samples);
      target.begin(view.c);
      run(view.c);
      target.dispose();
    }
    fog.dispose();
  });
  return { log, joins };
}
for (const samples of [1, 4]) for (const defaults of [false, true])
  test(`froxel ${samples}x defaults=${defaults}: no grid serialization, identical GPU tape`, () => {
    const old = story(Parent, samples, defaults), next = story(VolumetricFog, samples, defaults);
    if (!defaults) assert.ok(old.joins >= 12, 'parent serializes the live grid every frame');
    assert.equal(next.joins, 0, 'numeric dimensions need no join or string');
    assert.deepEqual(next.log, old.log, 'all descriptors, WGSL, uniform bytes, dispatches and draws identical');
  });
