import test from 'node:test';
import assert from 'node:assert/strict';
import {GPURenderer} from '../packages/core/dist/renderer.js';
import {FrameGraph} from '../packages/core/dist/plugin.js';
import {Camera} from '../packages/core/dist/camera.js';
import {box} from '../packages/core/dist/index.js';

// Core hook for package GPU culling (HANDOFF 5m.b): passes see this frame's batches, and a batch's `redirect` makes every
// core draw of it read a package's compacted instances and indirect arguments, while core still uploads its own buffer.
test('passes see the frame batches; a redirect replaces the instance buffer and count of every core draw, uploads unchanged', () => {
  globalThis.GPUBufferUsage = {COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256};
  globalThis.GPUTextureUsage = {RENDER_ATTACHMENT: 16, COPY_SRC: 1};
  const calls = [], writes = [], buffers = [];
  const pass = {setPipeline() {}, setBindGroup() {}, setIndexBuffer() {}, end() {},
    setVertexBuffer: (slot, buffer) => calls.push(['vertex', slot, buffer]), drawIndexed: (indices, count) => calls.push(['draw', indices, count]), drawIndexedIndirect: (buffer, offset) => calls.push(['indirect', buffer, offset])};
  const device = {createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroup: () => ({}), createTexture: () => ({createView: () => ({}), destroy() {}}),
    createBuffer: d => {const b = {...d, destroy() {}};buffers.push(b);return b;}, lost: new Promise(() => {}), addEventListener() {}, destroy() {}, limits: {maxBufferSize: 1 << 30},
    queue: {writeBuffer: (buffer, offset) => writes.push([buffer, offset]), submit() {}}, createCommandEncoder: () => ({finish: () => ({}), beginRenderPass: () => pass})};
  const pipeline = {getBindGroupLayout: () => ({})}, renderer = new GPURenderer({width: 4, height: 4}, device, {configure() {}, unconfigure() {}, getCurrentTexture: () => ({createView: () => ({})})}, 'bgra8unorm', pipeline, {multisample: {count: 4}, depthStencil: {format: 'depth32float'}}, pipeline);
  const geometry = box(), other = box(2), batches = [geometry, other].map(g => ({geometry: g, instances: new Float32Array(48), count: 2, mask: 1}));
  for (const b of batches) renderer.add(b.geometry, 2);
  const core = buffers.filter(b => b.size === 2 * 96), redirect = {instances: {label: 'drawn'}, args: {label: 'args'}}, seen = [];
  const graph = new FrameGraph();graph.add({name: 'cull', order: -1, execute: c => {seen.push(c.batches);c.batches[0].redirect = redirect;}});
  const light = {direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array(4)};
  renderer.render(new Camera(), light, batches, graph, 0);
  assert.deepEqual(seen[0], batches, 'passes get the batches in draw order');
  assert.deepEqual(calls.filter(c => c[0] === 'vertex' && c[1] === 1).map(c => c[2]), [redirect.instances, core[1]]);
  assert.deepEqual(calls.filter(c => c[0] !== 'vertex'), [['indirect', redirect.args, 0], ['draw', other.indices.length, 2]]);
  assert.deepEqual(writes.filter(([b]) => core.includes(b)).map(([b]) => core.indexOf(b)), [0, 1], 'both batches still upload into core instance buffers');
  // Without a redirect core draws from its own buffer again.
  calls.length = 0;delete batches[0].redirect;const plain = new FrameGraph();
  renderer.render(new Camera(), light, batches, plain, 0);
  assert.deepEqual(calls.filter(c => c[0] !== 'vertex'), [['draw', geometry.indices.length, 2], ['draw', other.indices.length, 2]]);
  renderer.dispose(false);
});
