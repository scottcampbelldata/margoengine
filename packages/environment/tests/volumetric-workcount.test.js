import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
// Far air (Scott 2026-11-16, re-pin equally strict): the composite WGSL gains the analytic tail and far light, and
// with no density given the clear-air default writes density 3.912/23000 and falloff 1/1200 into uniform floats
// 45/46 (was 0.02 and 0). Each is pinned exactly; every other entry stays byte-equal to the parent's tape.
const sha = (s) => createHash('sha256').update(s).digest('hex');
const composite = {
  1: ['c725bd91a27d3c0e22235fd9587c3f0055c9ba8c27f8e53f9c819d1bdfd3734e',
    '6e45b7b3154a0090393007e4be6a1449af7e98559a5ac607932a0c78ad6f5dcb'],
  4: ['d2ecdd160118b247f5da138518ad5f522f2cc275c52264eab2f5c97ef6c330a1',
    'ab3e53c03f5b09834afddd2a6109fec34627232ca6f81cdc13a9311d9bea7bd2'],
};
const OLD_AIR = '0ad7a33c00000000', CLEAR_AIR = 'a35932390e745a3a', AIR = 45 * 8;
function farAir(old, next, samples) {
  const [before, after] = composite[samples];
  let modules = 0, writes = 0;
  const expected = old.map((e, i) => {
    if (e[0] === 'module' && sha(e[2].code) === before) {
      assert.equal(sha(next[i]?.[2]?.code ?? ''), after, 'the far-air composite WGSL');
      modules++;
      return [e[0], e[1], { ...e[2], code: next[i][2].code }];
    }
    if (e[0] === 'writeBuffer' && e[3].slice(AIR, AIR + 16) === OLD_AIR) {
      writes++;
      return [e[0], e[1], e[2], e[3].slice(0, AIR) + CLEAR_AIR + e[3].slice(AIR + 16)];
    }
    return e;
  });
  assert.equal(modules, 2, 'the composite is built at setup and on device restore');
  assert.equal(writes, 3, 'the default air is written on the three frames before the story sets a density');
  return expected;
}
for (const samples of [1, 4]) for (const defaults of [false, true])
  test(`froxel ${samples}x defaults=${defaults}: no grid serialization, identical GPU tape`, () => {
    const old = story(Parent, samples, defaults), next = story(VolumetricFog, samples, defaults);
    if (!defaults) assert.ok(old.joins >= 12, 'parent serializes the live grid every frame');
    assert.equal(next.joins, 0, 'numeric dimensions need no join or string');
    assert.deepEqual(next.log, farAir(old.log, next.log, samples),
      'all descriptors, WGSL, uniform bytes, dispatches and draws identical but the far-air composite and default air');
  });
