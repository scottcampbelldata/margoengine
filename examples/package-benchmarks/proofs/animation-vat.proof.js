// CPU cost per frame of a crowd of RobotExpressive characters (7,214 vertices, 19 primitives, 43 joints, Walking clip):
//   skinned - one gltf-pro model + Animation each: track sampling, joint palettes and a compute dispatch per skinned
//             primitive, then one draw per primitive (the GPU-skinning path this package already had);
//   vat     - bakeVAT once, then one VATCrowd: one instanced draw, per-frame CPU independent of the instance count;
//   cpu     - CPU skinning every vertex every frame (bakeVAT's per-row cost times the crowd), for reference.
// Timed on the silent mock GPU (CPU work only; medians of 20 frames). About 90 s and 1 GB for 1,000 skinned models.
// Run: node examples/package-benchmarks/proofs/animation-vat.proof.js [counts, default 100,1000]
// Pinned: gltf-pro and animation built at 700838e, the commit that recorded results/animation-vat.json (--current: the
// working tree's builds).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { current, entryAt, announce, save } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';

const pin = current ? undefined : '700838e';
announce('gltf-pro + animation (measured, no baseline)', '-', pin);
const [{ GLTFAsset, PBRModel }, { Animation }, { bakeVAT, VATCrowd }] = await Promise.all(
  [
    ['gltf-pro', 'src/index.ts'],
    ['animation', 'src/index.ts'],
    ['animation', 'src/vat.ts'],
  ].map(([name, entry]) => entryAt(name, entry, pin)),
);

const bytes = await readFile(resolve(import.meta.dirname, '../../assets/robot-expressive.glb')),
  json = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + json).toString()),
  bin = bytes.subarray(28 + json, 28 + json + bytes.readUInt32LE(20 + json));
const median = (a) => {
  a.sort((x, y) => x - y);
  return +a[a.length >> 1].toFixed(3);
};
async function rig(capacity) {
  const gpu = mockGPU(),
    device = gpu.device,
    store = await TransformStore.create(capacity);
  device.createCommandEncoder = () => ({ ...gpu.encoder, finish: () => ({}) });
  device.lost = new Promise(() => {});
  const engine = new Engine(
    { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 30, 60], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(16 / 9, true);
  return { gpu, store, engine, view: context(gpu, { samples: 4, format: 'bgra8unorm' }) };
}
const place = (k, n) => {
  const side = Math.ceil(Math.sqrt(n));
  return [((k % side) - side / 2) * 2, 0, (Math.floor(k / side) - side / 2) * 2];
};
async function skinned(n) {
  const { gpu, store, engine, view } = await rig(n * 80 + 64),
    asset = new GLTFAsset(doc, [], bin),
    animations = [];
  for (let k = 0; k < n; k++) {
    const model = new PBRModel(engine, asset);
    engine.use(model);
    model.root.setPosition(place(k, n));
    const a = Animation.attach(model);
    a.play('Walking').seek(k * 0.013);
    animations.push(a);
  }
  const update = [],
    render = [];
  for (let f = 0; f < 23; f++) {
    view.begin(f);
    const t0 = performance.now();
    for (const a of animations) a.onPreUpdate(1 / 60);
    store.tick(false);
    const t1 = performance.now();
    engine.frameGraph.execute(view.c);
    const t2 = performance.now();
    view.end();
    if (f >= 3) {
      update.push(t1 - t0);
      render.push(t2 - t1);
    }
  }
  const calls = gpu.record(() => {
    view.begin(30);
    for (const a of animations) a.onPreUpdate(1 / 60);
    store.tick(false);
    engine.frameGraph.execute(view.c);
    view.end();
  });
  engine.dispose();
  return {
    updateMs: median(update),
    recordMs: median(render),
    draws: calls.filter((e) => e[0] === 'pass.drawIndexed').length,
    dispatches: calls.filter((e) => e[0] === 'pass.dispatchWorkgroups').length,
    bufferWrites: calls.filter((e) => e[0] === 'writeBuffer').length,
    uploadBytes: calls.filter((e) => e[0] === 'writeBuffer').reduce((s, e) => s + e[3].length / 2, 0),
  };
}
async function vat(n, data) {
  const { gpu, engine, view } = await rig(64),
    crowd = new VATCrowd(data, { color: [0.9, 0.75, 0.3, 1] });
  engine.use(crowd);
  for (let k = 0; k < n; k++) {
    const [x, y, z] = place(k, n);
    crowd.add({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1], offset: k * 0.013 });
  }
  const update = [],
    render = [];
  for (let f = 0; f < 23; f++) {
    view.begin(f);
    const t0 = performance.now();
    crowd.onPreUpdate(1 / 60);
    const t1 = performance.now();
    engine.frameGraph.execute(view.c);
    const t2 = performance.now();
    view.end();
    if (f >= 3) {
      update.push(t1 - t0);
      render.push(t2 - t1);
    }
  }
  const calls = gpu.record(() => {
    view.begin(30);
    crowd.onPreUpdate(1 / 60);
    engine.frameGraph.execute(view.c);
    view.end();
  });
  engine.dispose();
  return {
    updateMs: median(update),
    recordMs: median(render),
    draws: calls.filter((e) => e[0] === 'pass.drawIndexed').length,
    dispatches: 0,
    bufferWrites: calls.filter((e) => e[0] === 'writeBuffer').length,
    uploadBytes: calls.filter((e) => e[0] === 'writeBuffer').reduce((s, e) => s + e[3].length / 2, 0),
  };
}

// Bake once (timed), from a headless model.
const { engine: bakeEngine } = await rig(128),
  model = new PBRModel(bakeEngine, new GLTFAsset(doc, [], bin)),
  animation = new Animation(model);
let t = performance.now();
const data = bakeVAT(animation, { fps: 30, clips: ['Walking'] });
const bakeMs = performance.now() - t;
t = performance.now();
bakeVAT(animation, { fps: 30, clips: ['Walking'] });
const rowMs = (performance.now() - t) / data.rows;
const bake = {
  vertices: data.vertexCount,
  rows: data.rows,
  textureBytes: data.texels.byteLength,
  bakeMs: +bakeMs.toFixed(1),
  cpuSkinningMsPerCharacterFrame: +rowMs.toFixed(3),
};
console.log('bake', JSON.stringify(bake));
const results = {};
for (const n of (process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '100,1000').split(',').map(Number)) {
  const s = await skinned(n),
    v = await vat(n, data);
  results[n] = { skinned: s, vat: v, cpuSkinningMs: +(rowMs * n).toFixed(1) };
  console.log(n, JSON.stringify(results[n]));
  assert.equal(v.draws, 1);
  assert.equal(s.draws, n * model.primitives.length);
}
const report = {
  proof: 'animation-vat',
  packages: pin ?? 'working tree',
  node: process.version,
  recordedAt: new Date().toISOString(),
  asset: 'RobotExpressive, Walking clip at 30 rows/s',
  bake,
  results,
  notes:
    'CPU work per frame only (mock GPU). VAT moves skinning to a texture read in the vertex shader: per-frame CPU is one uniform write and one draw, whatever the crowd size. GPU cost is not measured here.',
};
await save('animation-vat', report);
