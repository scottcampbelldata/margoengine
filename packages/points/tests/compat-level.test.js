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

// Bug sweep L3 (KB2272 follow-up): surfels refused 4x at the level, which multisamples neither r32float nor rgba16float.
// The front depth now goes packed into rgba8unorm and the sums into two rg16float targets (r,g and b,weight: the same
// half floats the full level adds in rgba16float), resolved by a masked draw per sample.
const textures = (log) => log.filter((e) => e[0] === 'texture').map((e) => e[2]);
const surfelPipelines = (log) => log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);

test('surfels at 4x on the compatibility level draw with formats the level multisamples and no sample_index', () => {
  const log = rig(new SurfelPlugin(), { compatibility: true });
  assert.deepEqual(
    textures(log)
      .filter((t) => t.sampleCount === 4)
      .map((t) => t.format),
    ['rgba8unorm', 'rg16float', 'rg16float'],
  );
  for (const shader of code(log)) assert.doesNotMatch(shader, /sample_index/);
  assert.deepEqual(masks(log), [1, 2, 4, 8], 'one resolve draw per sample');
  const [depth, blend] = surfelPipelines(log);
  assert.deepEqual(
    depth.fragment.targets.map((t) => t.format),
    ['rgba8unorm'],
  );
  assert.deepEqual(
    blend.fragment.targets.map((t) => t.format),
    ['rg16float', 'rg16float'],
  );
  assert.equal(new Set(blend.fragment.targets.map((t) => JSON.stringify(t.blend))).size, 1, 'one blend on all targets');
  const shaders = code(log).join();
  assert.match(shaders, /packDepth\(-dot\(i\.world,frame\.back\.xyz\)\)/);
  assert.match(shaders, /unpackDepth\(textureLoad\(front,vec2i\(i\.clip\.xy\),0\)\)/);
  for (const sample of [0, 1, 2, 3]) assert.ok(shaders.includes(`textureLoad(rest,q,${sample})`), `resolve reads sample ${sample}`);
  // The front clear is NOTHING (3e38) as its four bytes, which unpack to the same float.
  const clear = log.find((e) => e[0] === 'beginRenderPass')[1].colorAttachments[0].clearValue,
    bytes = Uint8Array.from([clear.r, clear.g, clear.b, clear.a], (v) => Math.round(Math.fround(v) * 255));
  assert.equal(new Float32Array(bytes.buffer)[0], Math.fround(3e38));
  const resolves = log.filter((e) => e[0] === 'pass.draw' && e[1] === 3);
  assert.equal(resolves.length, 4, 'four resolve draws');
});

test('surfels at 4x on a full device keep r32float, rgba16float and one sample_index resolve', () => {
  const log = rig(new SurfelPlugin(), { compatibility: false });
  assert.deepEqual(
    textures(log)
      .filter((t) => t.sampleCount === 4)
      .map((t) => t.format),
    ['r32float', 'rgba16float'],
  );
  assert.deepEqual(masks(log), []);
  assert.ok(code(log).some((shader) => shader.includes('@builtin(sample_index)')));
  assert.equal(log.filter((e) => e[0] === 'pass.draw' && e[1] === 3).length, 1);
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

// Bug sweep L3a (red main after 34f9772d2a): on the WebGL2 layer's half-float tier the r32float front depth is stored as
// r16float, whose rounding moved the blend window and changed 1.2% of the 4x surfel image. Below its full tier the layer
// now takes the packed front depth (exact in rgba8unorm) and keeps the rgba16float sums the tier stores unchanged.
function layer(plugin, tier, samples = 4) {
  const gpu = mockGPU(),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  gpu.device.features = new Set(['core-features-and-limits']);
  gpu.device.adapterInfo = { vendor: 'margo-webgl2' };
  gpu.device.adapter = { capabilities: { tier } };
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device }));
  plugin.add(new PointCloud({ positions: [0, 0, 0, 1, 1, 0, -1, 0, 1] }));
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
      descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: samples } },
    }),
  );
}

for (const samples of [1, 4]) {
  test(`surfels at ${samples}x on the layer's half-float tier pack the front depth and keep rgba16float sums`, () => {
    const log = layer(new SurfelPlugin(), 'half-float', samples);
    assert.deepEqual(
      textures(log)
        .filter((t) => t.sampleCount === samples)
        .map((t) => t.format),
      ['rgba8unorm', 'rgba16float'],
    );
    const [depth, blend] = surfelPipelines(log);
    assert.deepEqual(depth.fragment.targets.map((t) => t.format), ['rgba8unorm']);
    assert.deepEqual(blend.fragment.targets.map((t) => t.format), ['rgba16float']);
    const shaders = code(log).join();
    assert.match(shaders, /packDepth\(-dot\(i\.world,frame\.back\.xyz\)\)/);
    assert.match(shaders, /unpackDepth\(textureLoad\(front,vec2i\(i\.clip\.xy\),0\)\)/);
    assert.match(shaders, /->@location\(0\) vec4f\{\n  if\(cut\(i\)\)\{discard;\}\n  let behind/, 'one rgba16float sum');
    const clear = log.find((e) => e[0] === 'beginRenderPass')[1].colorAttachments[0].clearValue,
      bytes = Uint8Array.from([clear.r, clear.g, clear.b, clear.a], (v) => Math.round(Math.fround(v) * 255));
    assert.equal(new Float32Array(bytes.buffer)[0], Math.fround(3e38));
    assert.deepEqual(masks(log), [], 'the layer has sample_index: one resolve');
    assert.equal(log.filter((e) => e[0] === 'pass.draw' && e[1] === 3).length, 1);
  });
}

test("surfels on the layer's full tier keep the r32float front depth", () => {
  const log = layer(new SurfelPlugin(), 'full');
  assert.deepEqual(
    textures(log)
      .filter((t) => t.sampleCount === 4)
      .map((t) => t.format),
    ['r32float', 'rgba16float'],
  );
});

test("surfels refuse the layer's ldr tier, which would clamp their weight sums at 1", () => {
  assert.throws(
    () => layer(new SurfelPlugin(), 'ldr'),
    (error) =>
      error.name === 'MargoError' &&
      error.code === 'unsupported' &&
      /SurfelPlugin weighted sums requires the half-float compatibility tier; this device is ldr/.test(error.message),
  );
});
