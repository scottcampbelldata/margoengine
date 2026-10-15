// Proof for @margoengine/taa: per-frame pass descriptors, the patched shader and uniform packing are reused instead of rebuilt.
// Run: node examples/package-benchmarks/proofs/taa.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/taa.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';
import {mockGPU, passes, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('taa', ref, undefined, pin);

/** One engine with TAA attached: core meshes (stride 24), an optional PBR velocity source (stride 80), and a frame driver. */
function scene(module, samples, meshCount, pbrCount) {
  const gpu = mockGPU(), ids = meshCount + pbrCount + 1;
  const engine = {gpu: gpu.device, meshes: new Map(), stats: {drawCalls: 0}, removePlugin() {}, geometryBuffers: geometry => geometry.buffers,
    store: {visible: new Uint8Array(ids).fill(1), hidden: new Uint8Array(ids), parents: new Int32Array(ids).fill(-1)}};
  const buffer = size => gpu.device.createBuffer({size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE});
  const node = id => ({id, engine, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, id, 0, 0, 1]), check() {}});
  for (let id = 0; id < meshCount; id++) engine.meshes.set(id, Object.assign(node(id), {geometry: {indices: {length: 36}, buffers: {vertex: buffer(576), index: buffer(144), instance: buffer(64), frame: -1}}}));
  const alpha = gpu.device.createTexture({size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING}).createView(), sampler = gpu.device.createSampler({});
  const source = {disposed: false, shadowPrimitives: Array.from({length: pbrCount}, (_, i) => ({node: node(meshCount + i), vertex: buffer(8000), index: buffer(1200), count: 300, stride: 80, alphaTexture: alpha, alphaSampler: sampler, alpha: 0.8, cutoff: i % 2 ? 0.5 : undefined, texCoord: i % 3 ? 1 : undefined}))};
  const taa = new module.TAA({historyWeight: 0.9}); taa.setup(engine); if (pbrCount) taa.add(source);
  const run = passes(taa), view = context(gpu, {samples, shader: wgsl});
  function frame(index) {
    view.begin(index);
    for (const mesh of engine.meshes.values()) if (mesh.id % 2) mesh.matrix[13] = Math.sin(index * 0.1 + mesh.id);
    for (const primitive of source.shadowPrimitives) primitive.node.matrix[14] = Math.cos(index * 0.07 + primitive.node.id);
    try {run(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
    view.end();
  }
  return {gpu, engine, taa, source, camera: view.camera, state: view.state, frame};
}

// Same calls first: 44 frames covering every input the effect caches on.
function story(module, samples) {
  const s = scene(module, samples, 12, 6);
  return s.gpu.record(() => {
    for (let i = 0; i < 44; i++) {
      if (i === 6) {s.state.width = 1920; s.state.height = 1080;}           // resize
      if (i === 10) s.camera.fov = 45;                                       // projection change resets history
      if (i === 12) s.camera.near = NaN; if (i === 13) s.camera.near = 0.1;  // NaN projection values compare as equal text did
      if (i === 14) s.engine.store.hidden[3] = 1;                            // hidden mesh: its record goes stale and is destroyed
      if (i === 16) s.engine.store.hidden[3] = 0;
      if (i === 18) s.engine.meshes.delete(5);                               // removed mesh
      if (i === 20) s.engine.store.visible[7] = 0;
      if (i === 22) s.taa.options.historyWeight = 0.5;                       // option change
      if (i === 24) s.state.depthFormat = 'depth32float';                    // no stencil aspect: different depth attachment and pipelines
      if (i === 27) s.state.depthFormat = 'depth24plus-stencil8';
      if (i === 29) s.state.shader = wgsl + '\n// variant';                  // another plugin changed the shader
      if (i === 31) s.state.shader = wgsl;
      if (i === 33) s.taa.reset();
      s.state.singular = i === 35;                                           // capture throws, the next frame recovers
      if (i === 37) s.source.shadowPrimitives[2].vertex = s.gpu.device.createBuffer({size: 8000, usage: GPUBufferUsage.VERTEX}); // replaced vertex buffer
      if (i === 39) s.source.disposed = true;                                // source dropped
      if (i === 41) s.taa.onDeviceRestored(s.engine);                        // device restoration
      s.frame(i);
    }
    s.taa.dispose();
  });
}
for (const samples of [1, 4]) {
  const expected = story(baseline, samples), actual = story(candidate, samples);
  assert.ok(expected.length > 2000 && expected.some(entry => entry[0] === 'throw') && expected.filter(entry => entry[0] === 'destroy').length > 20, 'story must exercise the GPU, the error path and stale records');
  assert.deepEqual(actual, expected, `TAA GPU calls differ at ${samples}x`);
}

const cases = [];
for (const [label, samples, meshCount, pbrCount, frames] of [['300 meshes + 100 PBR primitives, 4x MSAA', 4, 300, 100, 300], ['300 meshes + 100 PBR primitives, 1x', 1, 300, 100, 300], ['40 meshes, 4x MSAA', 4, 40, 0, 1000], ['no velocity geometry, 4x MSAA', 4, 0, 0, 5000]]) {
  const a = scene(baseline, samples, meshCount, pbrCount), b = scene(candidate, samples, meshCount, pbrCount); let ia = 0, ib = 0;
  cases.push({case: label, frames, ...time(() => {for (let i = 0; i < frames; i++) a.frame(ia++);}, () => {for (let i = 0; i < frames; i++) b.frame(ib++);})});
}
await record('taa', ref, cases, 'Mock WebGPU device: identical call sequence, descriptors and buffer bytes over a 44-frame story (resize, projection/option/shader changes, hidden/removed meshes, error recovery, device restoration) at 1x and 4x. Times are CPU-side JavaScript only.', pin);
