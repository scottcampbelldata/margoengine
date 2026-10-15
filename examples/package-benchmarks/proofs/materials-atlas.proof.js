// Draw and batch reduction from texture atlases (@margoengine/materials packAtlas, uvTransform, transformUVs), counted on
// the recording mock GPU over a steady frame, and the CPU time per frame of the same scenes (silent mock, medians).
// 256 boxes, each with its own 32x32 image:
//   separate - 256 Textures, 256 Materials, 256 meshes (the three.js default);
//   shared   - one packAtlas texture, 256 Materials that differ only in uvTransform, 256 meshes (one texture, same draws);
//   merged   - one packAtlas texture, region UVs baked with transformUVs, boxes merged with @margoengine/geometry: one mesh.
// Run: node examples/package-benchmarks/proofs/materials-atlas.proof.js
// Pinned: geometry and materials built at 700838e, the commit that recorded results/materials-atlas.json (--current: the
// working tree's builds).
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Engine, TransformStore} from '@margoengine/core/extension';
import {current, entryAt, announce, save} from './compare.js';
import {mockGPU, context} from './gpu-recorder.js';

const pin = current ? undefined : '700838e';
announce('geometry + materials (measured, no baseline)', '-', pin);
const [{boxGeometry, mergeGeometries, applyMatrix4}, {Texture, Material, createMesh, packAtlas, transformUVs}] = await Promise.all(['geometry', 'materials'].map(name => entryAt(name, 'src/index.ts', pin)));

const count = 256, side = 16, images = Array.from({length: count}, (_, k) => ({width: 32, height: 32, data: Uint8Array.from({length: 32 * 32 * 4}, (_, i) => (i * (k + 3) + k) % 256)}));
const place = k => [(k % side - side / 2) * 1.5, 0, (Math.floor(k / side) - side / 2) * 1.5];
async function scene(variant) {
  const gpu = mockGPU(), device = gpu.device, store = await TransformStore.create(1024);
  device.createCommandEncoder = () => ({...gpu.encoder, finish: () => ({})}); device.lost = new Promise(() => {});
  const engine = new Engine({width: 1280, height: 720, clientWidth: 1280, clientHeight: 720}, store, {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}}, {position: [0, 20, 30], target: [0, 0, 0]}, null);
  engine.camera.update(16 / 9, true);
  const view = context(gpu, {samples: 4, format: 'bgra8unorm'}), box = boxGeometry(1, 1, 1);
  const frame = i => {view.begin(i); store.tick(false); engine.frameGraph.execute(view.c); view.end();};
  const setup = gpu.record(() => {
    if (variant === 'separate') images.forEach((image, k) => createMesh(engine, box, new Material({map: new Texture(image)})).root.setPosition(place(k)));
    else {
      const atlas = packAtlas(images), map = new Texture(atlas.image);
      if (variant === 'shared') atlas.regions.forEach((uvTransform, k) => createMesh(engine, box, new Material({map, uvTransform})).root.setPosition(place(k)));
      else {
        const boxes = atlas.regions.map((region, k) => {const [x, y, z] = place(k); return {...applyMatrix4(box, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]), uvs: transformUVs(box.uvs, region)};});
        createMesh(engine, mergeGeometries(boxes), new Material({map}));
      }
    }
    frame(0); frame(1);
  });
  const steady = gpu.record(() => frame(2)), kinds = name => steady.filter(e => e[0] === name).length;
  const times = []; for (let i = 0; i < 60; i++) {const t = performance.now(); frame(3 + i); times.push(performance.now() - t);}
  times.sort((a, b) => a - b);
  return {draws: kinds('pass.drawIndexed'), setBindGroup: kinds('pass.setBindGroup'), setPipeline: kinds('pass.setPipeline'), uniformWrites: kinds('writeBuffer'),
    texturesCreated: setup.filter(e => e[0] === 'texture').length, pipelinesCreated: setup.filter(e => e[0] === 'renderPipeline').length, bindGroupsCreated: setup.filter(e => e[0] === 'group').length,
    cpuMsPerFrame: +times[30].toFixed(3)};
}
const results = {};
for (const variant of ['separate', 'shared', 'merged']) {results[variant] = await scene(variant); console.log(variant, JSON.stringify(results[variant]));}
assert.equal(results.separate.draws, count); assert.equal(results.shared.draws, count); assert.equal(results.merged.draws, 1);
assert.equal(results.separate.texturesCreated - results.shared.texturesCreated, count - 1, 'one atlas texture replaces 256');
const report = {proof: 'materials-atlas', packages: pin ?? 'working tree', node: process.version, recordedAt: new Date().toISOString(), objects: count, image: '32x32 RGBA each, atlas 1024x512 with 2-texel padding', results,
  notes: 'Counts are one steady frame on the recording mock GPU. gltf-pro draws one call per mesh and caches pipelines per model, so sharing a texture alone does not cut draws; merging atlas-mapped geometry does (static meshes only).'};
await save('materials-atlas', report);
