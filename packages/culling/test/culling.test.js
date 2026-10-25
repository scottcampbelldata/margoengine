import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { CulledInstances } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const translate = (x, y, z, s = 1) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1];
const batches = () => [
  {
    geometry: box(),
    material: new PbrMaterial({ color: '#ff0000' }),
    transforms: new Float32Array([...translate(0, 0, 0), ...translate(4, 0, 0, 2)]),
  },
  {
    geometry: box(0.5),
    material: new PbrMaterial({ color: '#00ff00', doubleSided: false }),
    transforms: new Float32Array(translate(0, 3, 0)),
  },
];
function harness() {
  const h = optionalGPU();
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  h.context.shader = wgsl;
  h.context.descriptor = {
    multisample: { count: 4 },
    depthStencil: { format: 'depth32float-stencil8' },
    vertex: { buffers: [] },
    fragment: { targets: [] },
  };
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.2]) };
  const passes = [],
    bound = []; // [pass index, pipeline] for every setPipeline in a render pass
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    const at = passes.push(descriptor) - 1,
      pass = begin(descriptor);
    pass.setPipeline = (pipeline) => bound.push([at, pipeline]);
    return pass;
  };
  return {
    ...h,
    passes,
    bound,
    run(frames = 1) {
      for (let i = 0; i < frames; i++) h.engine.frameGraph.execute(h.context);
    },
  };
}
const _buffer = (h, size, usage) => h.resources.find((r) => r.size === size && r.usage === usage);

test('uploads parts once and draws them with compute culling and indirect draws, in original order, without per-frame allocation', () => {
  const h = harness(),
    parts = new CulledInstances(batches(), { culling: 'occlusion' });
  h.engine.use(parts);
  h.run();
  assert.equal(parts.count, 3);
  assert.deepEqual(parts.starts, [0, 2]);
  // Occlusion frame: select pass + depth prepass (2 draws), Hi-Z + cull/scan/scatter, main pass (2 draws).
  assert.equal(h.counts.compute, 2);
  assert.equal(h.counts.render, 2);
  assert.equal(h.counts.indirect, 4);
  assert.equal(h.passes[0].colorAttachments.length, 0, 'prepass is depth only');
  assert.equal(h.passes[0].depthStencilAttachment.depthLoadOp, 'clear');
  assert.equal(h.passes[1].colorAttachments[0].view, h.originalColor);
  assert.equal(h.passes[1].colorAttachments[0].loadOp, 'load');
  assert.equal(h.passes[1].depthStencilAttachment.view, h.originalDepth);
  assert.equal(h.passes[1].depthStencilAttachment.stencilReadOnly, true);
  const records = new Float32Array(h.resources.find((r) => r.size === 3 * 96 && r.usage === (128 | 8)).data);
  assert.deepEqual(Array.from(records.subarray(24 + 12, 24 + 16)), [4, 0, 0, 1]);
  assert.equal(records[23], -1, 'no core mesh id');
  assert.equal(records[48 + 22], 0, 'single-sided material flag reaches the shader');
  // World spheres are computed in the cull pass from each record's matrix and its batch's local sphere.
  const bounds = new Float32Array(parts['buffers'].bounds.data);
  assert.deepEqual([...bounds], [...box().bounds, ...box(0.5).bounds]);
  const cullCode = h.pipelines.find((p) => p.compute?.entryPoint === 'cull').compute.module.code;
  assert.match(cullCode, /fn sphereOf\(i:u32\)->vec4f/);
  assert.match(cullCode, /let s=sphereOf\(i\);if\(inside\(s\)/);
  assert.match(cullCode, /max\(dot\(m\[0\]\.xyz,m\[0\]\.xyz\)/, 'radius scales with the largest axis');
  const args = new Uint32Array(h.resources.find((r) => r.size === 40 && r.usage === (128 | 256 | 4 | 8)).data);
  assert.deepEqual(Array.from(args), [36, 0, 0, 0, 0, 36, 0, 0, 0, 0]);
  const main = h.pipelines.find((p) => p.fragment?.module?.code === wgsl);
  assert.ok(main, 'main pass uses core shader unchanged');
  assert.deepEqual(main.depthStencil, { format: 'depth32float-stencil8' });
  const compute = h.pipelines.filter((p) => p.compute).map((p) => p.compute.entryPoint);
  assert.deepEqual(compute, ['early', 'depth0', 'reduce', 'cull', 'scan', 'scatter']);
  const code = h.pipelines.find((p) => p.compute).compute.module.code;
  assert.match(code, /texture_depth_multisampled_2d/);
  assert.match(code, /drawn\[s\+p-base\]=records\[i\]/, 'stable compaction');
  const created = { ...h.counts };
  h.run(600);
  assert.equal(h.counts.buffers, created.buffers);
  assert.equal(h.counts.groups, created.groups);
  assert.equal(h.counts.textures, created.textures);
  const frame = new Float32Array(h.resources.find((r) => r.size === 128 && r.usage === 72).data);
  assert.deepEqual([...frame.subarray(28, 32)], [1, 1, 1, 0], 'legacy lighting defaults to white');
  h.engine.lighting.ambient = new Float32Array([2, 0.5, 0]);
  h.run();
  assert.deepEqual([...frame.subarray(28, 32)], [2, 0.5, 0, 0], 'culled core meshes receive RGB ambient');
  delete h.engine.lighting.ambient;
  h.run();
  assert.deepEqual([...frame.subarray(28, 32)], [1, 1, 1, 0], 'omission clears a previous tint');
  parts.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.equal(h.engine.hasPlugin(parts.name), false);
});

test('Hi-Z levels cover the screen down to 1x1 and resize rebuilds only size-dependent resources', () => {
  const h = harness(),
    parts = new CulledInstances(batches(), { culling: 'occlusion' });
  h.engine.use(parts);
  h.run();
  const uniform = h.resources.find((r) => r.size === 448),
    words = () => new Uint32Array(uniform.data);
  assert.deepEqual(Array.from(words().subarray(40, 46)), [128, 96, 8, 3, 2, 2]);
  const levels = Array.from({ length: 8 }, (_, l) => Array.from(words().subarray(48 + l * 4, 51 + l * 4)));
  assert.deepEqual(
    levels.map((l) => l.slice(1)),
    [
      [128, 96],
      [64, 48],
      [32, 24],
      [16, 12],
      [8, 6],
      [4, 3],
      [2, 2],
      [1, 1],
    ],
  );
  assert.equal(levels[1][0], 128 * 96);
  const hiz = h.resources.filter((r) => r.usage === 128 && !r.destroyed).at(-1);
  assert.equal(hiz.size, levels.reduce((s, [, w, hh]) => s + w * hh, 0) * 4);
  const textures = h.counts.textures;
  h.context.width = 129;
  h.run();
  assert.equal(h.counts.textures, textures + 1);
  assert.ok(hiz.destroyed);
  assert.equal(new Uint32Array(uniform.data)[42], 9);
  parts.dispose();
});

test('an offset view gets a view-sized Hi-Z drawn at the target origin; smaller views reuse the resources', () => {
  const h = harness(),
    parts = new CulledInstances(batches(), { culling: 'occlusion' });
  h.engine.use(parts);
  const viewports = [];
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    return { ...pass, setViewport: (...v) => viewports.push(v) };
  };
  const frame = (viewport) => {
    h.context.view = { id: String(viewport), camera: h.context.camera, viewport, index: 1, count: 2 };
    viewports.length = 0;
    h.run();
  };
  try {
    frame([64, 32, 64, 64]);
    const uniform = h.resources.find((r) => r.size === 448),
      depth = h.resources.filter((r) => r.format === 'depth32float' && !r.destroyed).at(-1);
    assert.deepEqual([depth.size[0], depth.size[1]], [64, 64], 'occluder depth is view-sized');
    assert.deepEqual(viewports[0], [0, 0, 64, 64, 0, 1], 'occluders draw at the origin of their own target');
    assert.deepEqual(Array.from(new Uint32Array(uniform.data).subarray(40, 42)), [64, 64]);
    const textures = h.counts.textures;
    frame([0, 0, 32, 16]);
    assert.equal(h.counts.textures, textures, 'a smaller view reuses the resources');
    assert.deepEqual(Array.from(new Uint32Array(uniform.data).subarray(40, 43)), [32, 16, 6]);
    assert.deepEqual(viewports[0], [0, 0, 32, 16, 0, 1]);
  } finally {
    parts.dispose();
  }
});

test('frustum and none modes skip the prepass; sections fall back to frustum culling', () => {
  for (const [culling, shader, mode] of [
    ['frustum', wgsl, 1],
    ['none', wgsl, 0],
    ['occlusion', wgsl.replace('let facing=', 'if(i.position.x<0){discard;}\nlet facing='), 1],
  ]) {
    const h = harness();
    h.context.shader = shader;
    const parts = new CulledInstances(batches(), { culling });
    h.engine.use(parts);
    h.run();
    assert.equal(h.counts.render, 1, culling);
    assert.equal(h.counts.compute, 1);
    assert.equal(h.counts.indirect, 2);
    assert.equal(new Uint32Array(h.resources.find((r) => r.size === 448).data)[44], mode);
    assert.ok(
      h.pipelines.find((p) => p.fragment?.module?.code === shader),
      'clipping shader still applies to the parts',
    );
    parts.culling = 'occlusion';
    if (shader === wgsl) {
      h.run();
      assert.equal(h.counts.render, 3);
    }
    parts.dispose();
  }
  assert.equal(new CulledInstances(batches()).culling, 'frustum', 'default');
  assert.throws(() => new CulledInstances(batches(), { culling: 'hi-z' }), /mode/);
});

test('transform and visibility updates write only the changed part', () => {
  const h = harness(),
    parts = new CulledInstances(batches());
  h.engine.use(parts);
  h.run();
  const records = h.resources.find((r) => r.size === 3 * 96 && r.usage === (128 | 8)),
    hidden = parts['buffers'].hidden;
  parts.setTransform(0, 1, translate(-2, 1, 0));
  h.run();
  assert.deepEqual(Array.from(new Float32Array(records.data).subarray(24 + 12, 24 + 16)), [-2, 1, 0, 1]);
  assert.equal(
    new Float32Array(records.data)[24 + 16],
    new PbrMaterial({ color: '#ff0000' }).data[0],
    'material untouched',
  );
  h.bufferWrites.length = 0;
  parts.setVisible(1, 0, false);
  h.run();
  assert.deepEqual([...new Uint32Array(hidden.data, 0, 3)], [0, 0, 1]);
  assert.deepEqual(
    h.bufferWrites
      .filter((w) => w.buffer === hidden || w.buffer === records)
      .map((w) => [w.buffer === hidden, w.offset, w.bytes]),
    [[true, 8, 4]],
    'visibility uploads only its flag',
  );
  parts.setVisible(1, 0, true);
  h.run();
  assert.deepEqual([...new Uint32Array(hidden.data, 0, 3)], [0, 0, 0]);
  assert.throws(() => parts.setTransform(0, 2, translate(0, 0, 0)), /instance/);
  assert.throws(() => parts.setTransform(2, 0, translate(0, 0, 0)), /instance/);
  assert.throws(() => parts.setVisible(0, 0, 1), /visibility/);
  assert.throws(() => parts.setTransform(0, 0, [1]), /16/);
  // One finiteness test per matrix still catches every bad value; plain arrays are checked for non-numbers.
  for (const bad of [NaN, Infinity, 3.5e38, '1'])
    assert.throws(() => parts.setTransform(0, 0, Object.assign(translate(0, 0, 0), { 13: bad })), /transform/);
  parts.setTransform(0, 0, new Float64Array(translate(3e38, 0, 0)));
  parts.dispose();
});

test('moving many parts costs one records upload per frame, covering only the changed range', () => {
  // Regression: setTransform wrote 2 buffers per call (20,000 GPU calls a frame for 10,000 moving parts) and computed
  // each part's bounding sphere on the CPU; the cull pass now derives it from the uploaded matrix.
  const n = 1000,
    h = harness(),
    parts = new CulledInstances([
      {
        geometry: box(),
        material: new PbrMaterial({ doubleSided: false }),
        transforms: new Float32Array(Array.from({ length: n }, () => translate(0, 0, 0)).flat()),
      },
    ]);
  // Before attaching: kept on the CPU and uploaded with everything at setup.
  for (let i = 0; i < n; i++) parts.setTransform(0, i, translate(i, 0, 0));
  h.engine.use(parts);
  h.run();
  const records = h.resources.find((r) => r.size === n * 96 && r.usage === (128 | 8)),
    to = (buffer) => h.bufferWrites.filter((w) => w.buffer === buffer);
  h.bufferWrites.length = 0;
  for (let i = 10; i < 600; i++) parts.setTransform(0, i, translate(i, 2, 0));
  assert.equal(h.bufferWrites.length, 0, 'no GPU call per part');
  h.run();
  assert.deepEqual(
    to(records).map((w) => [w.offset, w.bytes]),
    [[10 * 96, 590 * 96]],
  );
  assert.equal(to(parts['buffers'].hidden).length, 0, 'visibility flags untouched');
  const r = new Float32Array(records.data);
  assert.deepEqual([...r.subarray(599 * 24 + 12, 599 * 24 + 16)], [599, 2, 0, 1]);
  assert.deepEqual([...r.subarray(600 * 24 + 12, 600 * 24 + 16)], [600, 0, 0, 1]);
  h.bufferWrites.length = 0;
  h.run();
  assert.equal(to(records).length, 0, 'an unchanged frame uploads nothing');
  parts.dispose();
});

test('single-sided batches without mirrored parts draw back-culled without the discard; others keep core state', () => {
  const h = harness(),
    parts = new CulledInstances(batches());
  h.engine.use(parts);
  h.run();
  const plain = h.pipelines.find((p) => p.fragment?.module?.code === wgsl && !p.primitive?.cullMode),
    culled = h.pipelines.find((p) => p.fragment?.module?.code === wgsl && p.primitive?.cullMode === 'back');
  assert.ok(plain && culled);
  assert.equal(culled.fragment.constants.C, 1, 'override C=1 compiles out the back-face discard');
  assert.deepEqual(culled.depthStencil, plain.depthStencil);
  const main = () => {
    const last = h.passes.length - 1;
    return h.bound.filter(([at]) => at === last).map(([, p]) => p);
  };
  // Batch 0 is double-sided (core's default), batch 1 single-sided.
  assert.deepEqual(main(), [plain, culled]);
  // A mirrored part (negative determinant) needs its back faces: the batch keeps the discard until it is unmirrored.
  parts.setTransform(1, 0, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
  h.run();
  assert.deepEqual(main(), [plain]);
  parts.setTransform(1, 0, translate(0, 3, 0));
  h.run();
  assert.deepEqual(main(), [plain, culled]);
  parts.dispose();
  // A shader without core's discard switch (a package replaced the fragment stage) gets no culled pipeline.
  const g = harness();
  g.context.shader = wgsl.replace('override C=false;', '').replaceAll('!C&&', '');
  const other = new CulledInstances(batches());
  g.engine.use(other);
  g.run();
  assert.equal(g.pipelines.filter((p) => p.primitive?.cullMode === 'back').length, 0);
  other.dispose();
});

test('rejects malformed batches and transforms, and rolls back partial uploads', () => {
  for (const mutate of [
    (b) => (b[0].transforms = new Float32Array(17)),
    (b) => (b[0].transforms[15] = 0),
    (b) => (b[0].transforms[0] = 0),
    (b) => (b[0].transforms[3] = 1),
    (b) => (b[0].transforms[5] = NaN),
    (b) => (b[0].geometry = {}),
    (b) => (b[1].material = {}),
  ]) {
    const b = batches();
    mutate(b);
    assert.throws(() => new CulledInstances(b), /batch|transform/);
  }
  assert.throws(() => new CulledInstances([]), /batches/);
  const h = harness();
  h.engine.gpu.limits.maxStorageBufferBindingSize = 100;
  assert.throws(() => h.engine.use(new CulledInstances(batches())), /limits/);
  assert.ok(h.resources.every((r) => r.destroyed));
  const restored = harness(),
    parts = new CulledInstances(batches());
  restored.engine.use(parts);
  restored.run();
  const before = restored.resources.filter((r) => !r.destroyed).length;
  parts.onDeviceRestored(restored.engine);
  restored.run();
  assert.equal(restored.resources.filter((r) => !r.destroyed).length, before);
  parts.dispose();
  assert.ok(restored.resources.every((r) => r.destroyed));
});

test('CulledMeshes culls core batches on the GPU and redirects core draws; storage is reused, regrown and released', async () => {
  const { CulledMeshes } = await import('../dist/index.js');
  const h = harness(),
    geometry = box(),
    other = box(0.5),
    core = new Map([
      [geometry, { size: 96 * 4 }],
      [other, { size: 96 * 2 }],
    ]);
  h.engine.canvas = { clientWidth: 64 };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.engine.geometryBuffers = (g) => ({ instance: core.get(g) });
  const batches = [
    { geometry, instances: new Float32Array(96), count: 3 },
    { geometry: other, instances: new Float32Array(48), count: 0 },
  ];
  h.context.batches = batches;
  const plugin = new CulledMeshes({ minRadius: 2 });
  h.engine.use(plugin);
  h.run();
  const redirect = batches[0].redirect;
  assert.ok(redirect, 'drawn batch redirected');
  assert.equal(batches[1].redirect, undefined, 'empty batch left to core');
  assert.equal(redirect.instances.usage, 128 | 32 | 8);
  assert.equal(redirect.instances.size, 256 * 96);
  assert.equal(redirect.args.usage, 128 | 256 | 4 | 8);
  assert.deepEqual(
    h.pipelines.filter((p) => p.compute).map((p) => p.compute.entryPoint),
    ['cull', 'scan', 'scatter'],
  );
  assert.match(h.pipelines.find((p) => p.compute).compute.module.code, /drawn\[p\]=records\[i\]/, 'stable compaction');
  const group = h.groups.at(-1);
  assert.equal(group.entries[2].resource.buffer, core.get(geometry), 'reads core instance buffer');
  const uniform = h.resources.find((r) => r.size === 32 && !r.destroyed),
    words = new Uint32Array(uniform.data);
  assert.deepEqual([words[0], words[1]], [3, geometry.indices.length]);
  assert.deepEqual(Array.from(new Float32Array(uniform.data, 16, 4)), Array.from(geometry.bounds));
  assert.equal(
    new Float32Array(h.resources.find((r) => r.size === 176).data)[42],
    (2 * 128) / 64,
    'minRadius in device pixels',
  );
  const created = { ...h.counts };
  h.run(30);
  assert.equal(h.counts.buffers, created.buffers, 'no per-frame buffers');
  assert.equal(h.counts.groups, created.groups);
  assert.equal(batches[0].redirect.instances, redirect.instances);
  core.set(geometry, { size: 96 * 8 });
  h.run();
  assert.equal(h.counts.groups, created.groups + 1, 'rebinds when core replaces its instance buffer');
  batches[0].count = 300;
  h.run();
  assert.ok(redirect.instances.destroyed);
  assert.equal(batches[0].redirect.instances.size, 512 * 96, 'grows by doubling');
  h.context.batches = [batches[1]];
  h.run();
  assert.equal(batches[0].redirect, undefined);
  assert.ok(
    h.resources.filter((r) => r.size === 512 * 96).every((r) => r.destroyed),
    'unused geometry released',
  );
  h.context.batches = batches;
  h.run();
  plugin.dispose();
  assert.equal(batches[0].redirect, undefined, 'dispose restores core draws');
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(() => new CulledMeshes({ minRadius: -1 }), /options/);
});
