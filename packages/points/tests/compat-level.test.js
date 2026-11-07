// The WebGPU compatibility level has no `sample_index`: 4x passes read each sample by a masked draw per sample.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointCloud, PointsPlugin } from '../dist/index.js';
import { SurfelPlugin } from '../dist/surfels.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig(plugin, { compatibility, material }) {
  const gpu = mockGPU(),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  gpu.device.features = new Set(compatibility ? [] : ['core-features-and-limits']);
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device }));
  plugin.add(new PointCloud({ positions: [0, 0, 0, 1, 1, 0, -1, 0, 1], material }));
  const run = passes(plugin);
  return gpu.record(() =>
    run({
      backend: 'webgpu',
      device: gpu.device,
      encoder: gpu.encoder,
      camera,
      width: 64,
      height: 64,
      format: 'rgba8unorm',
      color: view,
      depth: view,
      descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 4 } },
    }),
  );
}
const code = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const masks = (log) =>
  log
    .filter((e) => e[0] === 'renderPipeline')
    .map((e) => e[2].multisample?.mask)
    .filter((mask) => mask !== undefined);

test('eye-dome lighting at 4x on the compatibility level draws once per sample with no sample_index', () => {
  const log = rig(new PointsPlugin(), { compatibility: true, material: { edl: true } });
  assert.deepEqual(masks(log), [1, 2, 4, 8]);
  for (const shader of code(log)) assert.doesNotMatch(shader, /sample_index/);
  assert.ok(code(log).some((shader) => /,3\)/.test(shader) && shader.includes('texture_multisampled_2d')));
});

test('eye-dome lighting at 4x on a full device keeps one draw with sample_index', () => {
  const log = rig(new PointsPlugin(), { compatibility: false, material: { edl: true } });
  assert.deepEqual(masks(log), []);
  assert.ok(code(log).some((shader) => shader.includes('@builtin(sample_index)')));
});

test('surfels at 4x on the compatibility level refuse with a coded error, as no float format multisamples there', () => {
  assert.throws(() => rig(new SurfelPlugin(), { compatibility: true }), { code: 'unsupported' });
  assert.ok(rig(new SurfelPlugin(), { compatibility: false }).length > 0);
});

test('packed depth keeps every float bit', () => {
  // The same arithmetic as the WGSL, on bytes through unorm values.
  for (const depth of [0, 1e-6, 0.1, 1, 3.5, 12345.678, 1e30]) {
    const bytes = new Uint8Array(new Float32Array([depth]).buffer),
      back = Uint8Array.from(bytes, (byte) => Math.round(Math.fround(byte / 255) * 255));
    assert.equal(new Float32Array(back.buffer)[0], Math.fround(depth));
  }
  const shaders = code(rig(new PointsPlugin(), { compatibility: true, material: { edl: true } })).join();
  assert.match(shaders, /packDepth\(i\.info\.y\)/);
  assert.match(shaders, /unpackDepth\(textureLoad\(depths,p,3\)\)/);
});

test('every sample of eye-dome lighting shares one layout, so one bind group serves them', () => {
  const log = rig(new PointsPlugin(), { compatibility: true, material: { edl: true } }),
    layouts = new Set(
      log.filter((e) => e[0] === 'renderPipeline' && e[2].multisample?.mask !== undefined).map((e) => e[2].layout),
    );
  assert.equal(layouts.size, 1);
  assert.notEqual([...layouts][0], 'auto');
});

test('the eye-dome depth of the compatibility level is a second pass of the same draws, with no blend beside it', () => {
  const log = rig(new PointsPlugin(), { compatibility: true, material: { edl: true } }),
    pipelines = log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]),
    alone = pipelines.find((p) => p.fragment.targets[0] === null);
  assert.equal(alone.fragment.targets[1].format, 'rgba8unorm');
  assert.equal(alone.depthStencil.depthWriteEnabled, false);
  assert.equal(alone.depthStencil.depthCompare, 'greater-equal');
  for (const pipeline of pipelines) {
    const blended = pipeline.fragment.targets.filter(Boolean).map((target) => target.blend !== undefined);
    assert.equal(new Set(blended).size, 1, 'one blend on all targets');
  }
  const draws = log.filter((e) => e[0] === 'pass.draw').map((e) => e.slice(1, 5).join());
  assert.equal(draws[0], draws[1], 'the same points in both passes');
});
