// Textured instancing (gltf-pro PBRInstances via @margoengine/materials createInstancedMesh) against N separate materials
// meshes: CPU time per frame and GPU calls for 1,000-10,000 textured boxes sharing one material. GPU calls are counted on
// the recording mock GPU over one steady frame; CPU time is the median frame (transform tick + frame graph) on the silent
// mock, so it measures the engine's encoding work, not the GPU. `static`: nothing moves; `moving`: every box moves every
// frame (root.setPosition per mesh, against setMatrixAt per instance plus one upload).
// Run (after npm run build:packages): node examples/package-benchmarks/textured-instancing.mjs
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Engine, TransformStore } from '../../packages/core/dist/extension.js';
import { boxGeometry } from '../../packages/geometry/dist/index.js';
import { Texture, Material, createMesh, createInstancedMesh } from '../../packages/materials/dist/index.js';
import { mockGPU, context } from './proofs/gpu-recorder.js';

const image = { width: 64, height: 64, data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => (i * 7) % 256) };
const place = (k, t, out) => {
  out[0] = ((k % 100) - 50) * 1.5 + Math.sin(t + k) * 0.2;
  out[1] = 0;
  out[2] = (Math.floor(k / 100) - 50) * 1.5;
  return out;
};
async function scene(count, variant, moving) {
  const gpu = mockGPU(),
    device = gpu.device,
    store = await TransformStore.create(2 * count + 64);
  device.createCommandEncoder = () => ({ ...gpu.encoder, finish: () => ({}) });
  device.lost = new Promise(() => {});
  const engine = new Engine(
    { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 60, 90], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(16 / 9, true);
  const view = context(gpu, { samples: 4, format: 'bgra8unorm' }),
    box = boxGeometry(1, 1, 1),
    material = new Material({ map: new Texture(image), roughness: 0.6 });
  const p = [0, 0, 0],
    m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let move;
  const setupStart = performance.now();
  if (variant === 'meshes') {
    const meshes = Array.from({ length: count }, (_, k) => {
      const mesh = createMesh(engine, box, material);
      mesh.root.setPosition(place(k, 0, p));
      return mesh;
    });
    move = (t) => {
      for (let k = 0; k < count; k++) meshes[k].root.setPosition(place(k, t, p));
    };
  } else {
    const mesh = createInstancedMesh(engine, box, material, count);
    move = (t) => {
      for (let k = 0; k < count; k++) {
        place(k, t, p);
        m[12] = p[0];
        m[13] = p[1];
        m[14] = p[2];
        mesh.instances.setMatrixAt(k, m);
      }
    };
    move(0);
  }
  const setupMs = performance.now() - setupStart;
  const frame = (i) => {
    if (moving) move(i * 0.01);
    view.begin(i);
    store.tick(false);
    engine.frameGraph.execute(view.c);
    view.end();
  };
  frame(0);
  frame(1);
  const steady = gpu.record(() => frame(2)),
    kinds = (name) => steady.filter((e) => e[0] === name).length;
  const bytes = steady.filter((e) => e[0] === 'writeBuffer').reduce((n, e) => n + e[3].length / 2, 0);
  const times = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    frame(3 + i);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  engine.dispose();
  return {
    draws: kinds('pass.drawIndexed'),
    setPipeline: kinds('pass.setPipeline'),
    setBindGroup: kinds('pass.setBindGroup'),
    setVertexBuffer: kinds('pass.setVertexBuffer'),
    bufferWrites: kinds('writeBuffer'),
    bytesWritten: bytes,
    cpuMsPerFrame: +times[20].toFixed(3),
    setupMs: +setupMs.toFixed(1),
  };
}
const results = [];
for (const count of [1000, 2500, 5000, 10000])
  for (const moving of [false, true]) {
    const meshes = await scene(count, 'meshes', moving),
      instanced = await scene(count, 'instanced', moving);
    assert.equal(meshes.draws, count);
    assert.equal(instanced.draws, 1);
    const row = {
      count,
      case: moving ? 'moving' : 'static',
      meshes,
      instanced,
      cpuSpeedup: +(meshes.cpuMsPerFrame / instanced.cpuMsPerFrame).toFixed(1),
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
const report = {
  benchmark: 'textured-instancing',
  node: process.version,
  recordedAt: new Date().toISOString(),
  scene: 'N textured boxes (one 64x64 texture, one Material, standard shading), 4x MSAA bgra8unorm context, mock GPU',
  results,
  notes:
    'meshes = N createMesh calls (one gltf-pro draw each, the only way before PBRInstances); instanced = one createInstancedMesh of N. CPU ms is the median of 40 frames (transform tick + frame graph encode) on the silent mock GPU; GPU calls are one steady frame on the recording mock. Real-GPU frame equality and timings: textured-instancing-gpu.json.',
};
await writeFile(
  resolve(import.meta.dirname, 'results/textured-instancing.json'),
  JSON.stringify(report, null, 2) + '\n',
);
