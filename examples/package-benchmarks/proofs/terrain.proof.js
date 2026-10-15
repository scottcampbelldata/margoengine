// Proof for @margoengine/terrain: clipmapGrid fills presized typed arrays; Terrain's per-frame prepare writes ring
// uniforms without temporary arrays; draw reuses last frame's pipeline before rebuilding the shader-text key.
// No GPU is involved: a recording stand-in device captures every upload and draw so both versions can be compared.
// Run: node examples/package-benchmarks/proofs/terrain.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/terrain.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('terrain', ref, undefined, pin);
globalThis.GPUBufferUsage ??= {COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128};
globalThis.GPUTextureUsage ??= {TEXTURE_BINDING: 4}; globalThis.GPUShaderStage ??= {VERTEX: 1, FRAGMENT: 2};

for (const resolution of [8, 12, 64, 128, 256]) assert.deepEqual(candidate.clipmapGrid(resolution), baseline.clipmapGrid(resolution));
for (const resolution of [4, 10, 260, 8.5, NaN]) assert.throws(() => candidate.clipmapGrid(resolution), {name: 'RangeError', message: 'Clipmap resolution must be a multiple of four in 8..256'});

/** One Terrain on a stand-in engine. `log` receives every observable GPU call while `recording` is on. */
function world(module, options = {}) {
  const log = [], state = {recording: true, ids: 0}, note = (...entry) => {if (state.recording) log.push(entry);};
  const object = (kind, extra) => ({kind, id: state.ids++, destroy() {note('destroy', this.id);}, ...extra});
  const texture = (format, layers) => object('texture', {dimension: '2d', usage: 4, sampleCount: 1, depthOrArrayLayers: layers, format, createView: () => object('view')});
  const device = {limits: {maxBufferSize: 2 ** 28},
    createBuffer: d => object('buffer', {data: new Uint8Array(d.size)}), createSampler: () => object('sampler'), createBindGroupLayout: () => object('layout'),
    createBindGroup: d => {note('createBindGroup', d.entries.length); return object('group');}, createShaderModule: d => object('module', {code: d.code}), createPipelineLayout: () => object('pipelineLayout'),
    createRenderPipeline: d => {note('createRenderPipeline', d.vertex.module.code, d.fragment?.targets[0].format, d.multisample?.count, d.depthStencil.format); return object('pipeline', {getBindGroupLayout: () => object('layout')});},
    // Like a real queue, the upload copies the staging array; recording keeps a second copy to compare.
    queue: {writeBuffer(buffer, offset, data) {buffer.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset); note('writeBuffer', buffer.id, offset, new Uint8Array(buffer.data));}}};
  const pass = {setPipeline(p) {note('setPipeline', p.id);}, setBindGroup(i, g) {note('setBindGroup', i, g.id);}, setVertexBuffer(i, b) {note('setVertexBuffer', i, b.id);},
    setIndexBuffer(b, f) {note('setIndexBuffer', b.id, f);}, drawIndexed(n) {note('drawIndexed', n);}, end() {note('end');}};
  const engine = {gpu: device, lighting: {direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.15])}, stats: {drawCalls: 0}, removePlugin() {}};
  const context = {backend: 'webgpu', device, format: 'bgra8unorm', color: {}, depth: {}, camera: {matrix: new Float32Array(16).map((_, i) => Math.sin(i + 1)), position: [0, 30, 0]},
    descriptor: {multisample: {count: 4}, depthStencil: {format: 'depth32float'}}, encoder: {beginRenderPass(d) {note('beginRenderPass', JSON.stringify(d)); return pass;}}};
  const terrain = new module.Terrain({size: [4096, 4096], layers: Array.from({length: 4}, (_, i) => ({height: [i * 40 - 10, i * 40 + 60], slope: [0, 1], scale: 8 + i})),
    textures: () => ({heightmap: texture('r32float', 1), layers: texture('rgba8unorm', 4), ...(options.normalmap ? {normalmap: texture('rgba8unorm', 1)} : {})}), ...options.terrain});
  const passes = []; terrain.setup(engine); terrain.registerPasses({add: p => passes.push(p)}); passes.sort((a, b) => a.order - b.order);
  // A walking camera: ring origins snap at different rates, so some frames invalidate shadows and some do not.
  const frame = i => {context.camera.position[0] = i * 0.37; context.camera.position[2] = Math.sin(i * 0.01) * 200; context.camera.matrix[12] = i; for (const p of passes) p.execute(context);};
  return {log, state, terrain, engine, context, pass, frame, suffix: '', view: {}, sampler: {}, summary: () => ({log, shadowVersion: terrain.shadowVersion, drawCalls: engine.stats.drawCalls})};
}
// A lighting provider shaped like Shadows/Clustered: it rewrites the shader text and returns fresh binding wrappers each frame.
function provider(w, tag) {
  const buffer = {tag};
  return {shader: (source, group) => `@group(${group}) @binding(1) var<uniform> light${tag}:vec4f;\n` + source + w.suffix,
    bindings: () => [{binding: 1, resource: {buffer, offset: 0, size: 64}}, {binding: 2, resource: w.view}, {binding: 3, resource: w.sampler}]};
}
// Format, sample-count and depth-format switches, lighting added/changed/removed, shadows, device restoration, disposal.
function script(module, options) {
  const w = world(module, options); let f = 0; const run = n => {for (let i = 0; i < n; i++) w.frame(f++);};
  run(40); w.context.format = 'rgba16float'; run(3); w.context.format = 'bgra8unorm'; run(3); w.context.descriptor.multisample = undefined; run(2);
  w.context.descriptor.depthStencil = {format: 'depth24plus-stencil8'}; run(2); w.context.descriptor = {multisample: {count: 4}, depthStencil: {format: 'depth32float'}}; run(2);
  const remove = w.terrain.addLighting(provider(w, 1)); run(5); w.suffix = '\n// changed'; run(3); const second = w.terrain.addLighting(provider(w, 2)); run(3); w.view = {}; run(2); remove(); run(2); second(); run(3);
  w.terrain.drawShadow({context: w.context, pass: w.pass, matrix: new Float32Array(16).fill(0.25), cascade: 2}); w.terrain.invalidate();
  w.terrain.onDeviceRestored(w.engine); run(4); w.terrain.dispose(); w.terrain.drawShadow({context: w.context, pass: w.pass, matrix: new Float32Array(16), cascade: 0});
  return w.summary();
}
for (const options of [{}, {normalmap: true, terrain: {origin: [-2048, 512.5], resolution: 32, levels: 3, cellSize: 0.5, heightScale: 250, heightOffset: -20}}, {terrain: {levels: 12, resolution: 8}}])
  assert.deepEqual(script(candidate, options), script(baseline, options));

const cases = [];
// Grid construction happens at setup and after every device restoration: the default 64 and the maximum 256.
for (const [resolution, builds] of [[64, 50], [256, 5]]) cases.push({case: `clipmapGrid(${resolution}) x ${builds}`, ...time(
  () => {for (let i = 0; i < builds; i++) baseline.clipmapGrid(resolution);}, () => {for (let i = 0; i < builds; i++) candidate.clipmapGrid(resolution);})});
// Ten seconds at 60 FPS of the default six-ring terrain: uniform prepare plus the draw pass, without and with one lighting provider.
for (const lit of [false, true]) {
  const pair = [baseline, candidate].map(module => {const w = world(module); if (lit) w.terrain.addLighting(provider(w, 1)); w.frame(0); w.state.recording = false; return w;});
  cases.push({case: `prepare + draw, 6 rings, ${lit ? 'one lighting provider' : 'unlit'}, 600 frames`, ...time(() => {for (let i = 0; i < 600; i++) pair[0].frame(i);}, () => {for (let i = 0; i < 600; i++) pair[1].frame(i);})});
}
await record('terrain', ref, cases, 'Frame timings run against a recording stand-in device (no GPU work), so they measure only the CPU cost Terrain adds per frame. Uploaded uniform bytes, draw calls, pipeline and bind-group creation, and shadowVersion are identical.', pin);
