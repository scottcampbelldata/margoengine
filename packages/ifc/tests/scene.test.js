// /scene: readIFCMeshes reads each geometry once, createIFCScene instances repeated geometry and batches the rest, and
// the per-element state (hide, isolate, ghost, colour, opacity, selection), picking maps, clipping and BCF wiring drive
// the materials meshes. A recording GPU (tests/support/optional-gpu.js) stands in; tests/scene-gpu-check.mjs draws it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcAPI } from 'web-ifc';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { openIFC } from '../dist/index.js';
import { readIFCData } from '../dist/data.js';
import { viewFromBCF, bcfFromView } from '../dist/bcf.js';
import { readIFCMeshes, createIFCScene } from '../dist/scene.js';

const api = new IfcAPI();
await api.Init();
const bytes = new Uint8Array(await readFile(new URL('./fixtures/building.ifc', import.meta.url)));

async function engine() {
  const device = optionalGPU().engine.gpu;
  device.queue.writeTexture = () => {};
  return new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}
const translate = (x, y, z) => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const box = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
};
const tri = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};
// Geometry 1 placed three times (elements 10, 11, 12), geometry 2 once (element 20), a translucent pane (element 30).
const meshes = () => ({
  schema: 'IFC4',
  origin: [0, 0, 0],
  geometries: new Map([
    [1, box],
    [2, tri],
  ]),
  placements: [
    { element: 10, geometry: 1, matrix: translate(0, 0, 0), color: [1, 0, 0, 1] },
    { element: 11, geometry: 1, matrix: translate(2, 0, 0), color: [0, 1, 0, 1] },
    { element: 12, geometry: 1, matrix: translate(4, 0, 0), color: [0, 0, 1, 1] },
    { element: 20, geometry: 2, matrix: translate(0, 2, 0), color: [0.5, 0.5, 0.5, 1] },
    { element: 30, geometry: 2, matrix: translate(0, 4, 0), color: [0.2, 0.4, 0.8, 0.4] },
  ],
});
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const row = (scene, at) => Array.from(scene.meshes[at].instances.data.subarray(0, 24));

test('readIFCMeshes reads each placed geometry once, rebased in float64', () => {
  const model = openIFC(api, bytes);
  const all = readIFCMeshes(model),
    auto = readIFCMeshes(model, { origin: 'auto' });
  model.close();
  assert.ok(all.placements.length >= all.geometries.size && all.geometries.size > 0);
  for (const p of all.placements) {
    assert.ok(all.geometries.has(p.geometry));
    assert.equal(p.matrix.length, 16);
  }
  assert.deepEqual(all.origin, [0, 0, 0]);
  const first = all.placements[0].matrix;
  assert.deepEqual(auto.origin, [Math.round(first[12]), Math.round(first[13]), Math.round(first[14])]);
  assert.equal(auto.placements[0].matrix[12], first[12] - auto.origin[0]);
  assert.deepEqual(structuredClone(all).placements.length, all.placements.length);
});

test('repeated geometry draws instanced, the rest batched, translucent surfaces in their own batch', async () => {
  const scene = createIFCScene(await engine(), meshes());
  // One instanced mesh (3 instances), one opaque batch, one translucent batch: three draws.
  assert.equal(scene.meshes.length, 3);
  const [opaque, translucent, instanced] = scene.meshes;
  assert.equal(instanced.instances.count, 3);
  assert.deepEqual(row({ meshes: [instanced] }, 0).slice(12, 20), [0, 0, 0, 1, 1, 0, 0, 1]);
  assert.equal(opaque.primitives.length, 1);
  assert.equal(translucent.material.transparent, true);
  assert.deepEqual(scene.elements, [10, 11, 12, 20, 30]);
  // instancing: 0 batches every placement.
  const flat = createIFCScene(await engine(), meshes(), { instancing: 0 });
  assert.equal(flat.meshes.length, 2);
  scene.dispose();
  flat.dispose();
});

test('hide, isolate, ghost, colour, opacity and selection drive instances and batch items', async () => {
  const scene = createIFCScene(await engine(), meshes(), { selectionColor: [0, 0, 1] });
  const instances = scene.meshes[2].instances;
  scene.hide([11]);
  assert.deepEqual(Array.from(instances.data.subarray(24, 40)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  scene.show([11]);
  assert.equal(instances.data[24 + 12], 2);
  scene.isolate([20]);
  assert.deepEqual(scene.hidden, [10, 11, 12, 30]);
  scene.showAll();
  assert.deepEqual(scene.hidden, []);
  // Ghosting draws a translucent copy and hides the element itself.
  const before = scene.meshes.length;
  scene.isolate([10], { ghost: true });
  assert.deepEqual(scene.stateOf(11), { hidden: false, ghosted: true, selected: false });
  assert.equal(instances.data[24], 0, 'the ghosted instance is not drawn opaque');
  assert.equal(scene.meshes.length, before, 'the four ghosts join the translucent batch, which grows: no new draw');
  scene.showAll();
  assert.equal(instances.data[24], 1);
  scene.setColor([10], [1, 1, 0]);
  assert.deepEqual(Array.from(instances.data.subarray(16, 20)), [1, 1, 0, 1]);
  scene.setColor([10], null);
  assert.deepEqual(Array.from(instances.data.subarray(16, 20)), [1, 0, 0, 1]);
  scene.select([10, 20]);
  assert.deepEqual(scene.selected, [10, 20]);
  assert.deepEqual(Array.from(instances.data.subarray(16, 20)), [0, 0, 1, 1]);
  scene.setOpacity([20], 0.5);
  assert.equal(scene.stateOf(20).opacity, 0.5);
  scene.setOpacity([20], null);
  assert.equal(scene.stateOf(20).opacity, undefined);
  // Elements without geometry are skipped.
  scene.hide([999]);
  assert.equal(scene.stateOf(999), undefined);
  scene.dispose();
  assert.throws(() => scene.hide([10]), /disposed/);
});

test('picking maps: instance index for instanced meshes, the element slot in UV0 for batches', async () => {
  const scene = createIFCScene(await engine(), meshes());
  const [opaque, translucent, instanced] = scene.meshes;
  assert.equal(scene.elementAt({ model: instanced, instanceId: 2 }), 12);
  assert.equal(scene.elementAt({ model: opaque, uv: [3.0000002, 0] }), 20);
  assert.equal(scene.elementAt({ model: translucent, uv: [4, 0] }), 30);
  assert.equal(scene.elementAt({ model: opaque }), undefined, 'a batch hit needs HitDetails uv');
  assert.equal(scene.elementAt({ model: {} }), undefined);
  // The batch vertices carry the slot in UV0.
  const vertices = opaque.primitives[0].vertices;
  assert.equal(vertices[12], 3);
  scene.dispose();
});

test('section planes, section box and storey plans clip every material', async () => {
  const model = openIFC(api, bytes);
  const data = readIFCData(model),
    real = readIFCMeshes(model);
  model.close();
  const scene = createIFCScene(await engine(), real, { data });
  const planes = scene.sectionBox([0, 0, 0], [1, 2, 3]);
  assert.deepEqual(planes, [
    [1, 0, 0, -0],
    [-1, 0, 0, 1],
    [0, 1, 0, -0],
    [0, -1, 0, 2],
    [0, 0, 1, -0],
    [0, 0, -1, 3],
  ]);
  assert.deepEqual(scene.materials.opaque.clippingPlanes, planes);
  assert.deepEqual(scene.materials.translucent.clippingPlanes, planes);
  assert.throws(() => (scene.clippingPlanes = new Array(17).fill([0, 1, 0, 0])), /at most 16/);
  const storey = [...data.elements.values()].find(
    (e) => e.type === 'IfcBuildingStorey' && data.elements.get(25)?.storey === e.id,
  );
  const plan = scene.storeyPlan(storey.id, { cutHeight: 1.5 });
  assert.equal(plan.cut, plan.elevation + 1.5);
  assert.deepEqual(plan.clippingPlanes, [[0, -1, 0, plan.cut]]);
  assert.equal(scene.stateOf(25).hidden, false);
  assert.ok(
    scene.elements.filter((id) => data.elements.get(id).storey !== storey.id).every((id) => scene.stateOf(id).hidden),
  );
  assert.equal(plan.camera.type, 'orthogonal');
  assert.ok(plan.camera.height > 0);
  assert.throws(() => scene.storeyPlan(25), /not an IfcBuildingStorey/);
  assert.throws(() => createIFCScene(scene['engine'], meshes()).storeyPlan(1), /needs the model data/);
  scene.dispose();
});

test('applyBCFView and bcfView carry a viewpoint both ways', async () => {
  const model = openIFC(api, bytes);
  const data = readIFCData(model),
    real = readIFCMeshes(model);
  model.close();
  const scene = createIFCScene(await engine(), real, { data });
  const wall = 25,
    window = 60;
  scene.hide([window]).setColor([wall], [1, 0, 0]).setOpacity([wall], 0.5).select([wall]);
  scene.clippingPlanes = [[0, -1, 0, 2]];
  const state = scene.bcfView();
  assert.deepEqual(state.hidden, [window]);
  assert.deepEqual(state.colors.get(wall), [1, 0, 0, 0.5]);
  const vp = bcfFromView(state, data);
  const fresh = createIFCScene(await engine(), real, { data });
  const camera = fresh.applyBCFView(viewFromBCF(vp, data));
  assert.equal(camera, undefined);
  assert.equal(fresh.stateOf(window).hidden, true);
  assert.equal(fresh.stateOf(wall).selected, true);
  assert.ok(Math.abs(fresh.stateOf(wall).opacity - 0.5) <= 1 / 255, 'BCF stores alpha in 8 bits');
  assert.deepEqual(
    fresh.stateOf(wall).color.map((c) => Math.round(c * 255)),
    [255, 0, 0],
  );
  assert.equal(fresh.clippingPlanes.length, 1);
  for (const [a, b] of fresh.clippingPlanes[0].map((v, i) => [v, [0, -1, 0, 2][i]])) assert.ok(Math.abs(a - b) < 1e-9);
  scene.dispose();
  fresh.dispose();
});
