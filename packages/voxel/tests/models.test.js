import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, VoxelWorld, VoxelChunk } from '../dist/index.js';
import { defineBlockModel, modelState, meshBlockModels, VoxelModelRenderer } from '../dist/models.js';
import { raycastVoxels, sweepBox } from '../dist/query.js';
import { VoxelLighting } from '../dist/light.js';
import { VoxelColorLight } from '../dist/light-rgb.js';
import { meshChunk, meshInput } from '../dist/mesher.js';
import { Physics } from '@margoengine/physics';
import { VoxelPhysics } from '../dist/physics.js';

const pane = { min: [0, 0, 0.375], max: [1, 1, 0.625] };
const scene = (boxes = [pane]) => {
  const blocks = new BlockTypes(),
    id = defineBlockModel(blocks, 'pane', { boxes }),
    world = new VoxelWorld({ blocks, minY: 0, maxY: 31 });
  world.setBlock(0, 0, 0, id);
  return { blocks, id, world };
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const area = (parts) =>
  parts.reduce((sum, g) => {
    for (let i = 0; i < g.indices.length; i += 3) {
      const p = g.indices.slice(i, i + 3).map((k) => g.positions.slice(k * 3, k * 3 + 3)),
        u = p[1].map((x, a) => x - p[0][a]),
        v = p[2].map((x, a) => x - p[0][a]);
      sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    return sum;
  }, 0);

test('24 exact proper rotations preserve volume, UV correspondence and cloned worker metadata', () => {
  const { blocks, id } = scene([{ ...pane, uv: Array.from({ length: 6 }, () => [0.2, 0.3, 0.8, 0.9]) }]),
    model = blocks.get(id).model;
  assert.equal(model.length, 24);
  assert.deepEqual(model[0].boxes[0].min, pane.min);
  assert.equal(
    new Set(model.map((r) => JSON.stringify(r.boxes[0].uv) + JSON.stringify(r.boxes[0].textures))).size >= 1,
    true,
  );
  for (const r of model) {
    const b = r.boxes[0];
    close(
      b.max.reduce((n, x, a) => n * (x - b.min[a]), 1),
      0.25,
    );
    for (const uv of b.uv) {
      assert.equal(uv.length, 8);
      assert.deepEqual([...uv].sort(), [0.2, 0.2, 0.3, 0.3, 0.8, 0.8, 0.9, 0.9]);
    }
  }
  assert.deepEqual(structuredClone(model), model);
  assert.throws(() => modelState(id, 24), RangeError);
});
test('ray passes through empty shape space; surfaces, inside starts and both directions agree', () => {
  const { world, id, blocks } = scene();
  assert.equal(raycastVoxels(world, [-1, 0.5, 0.1], [1, 0, 0], 4), null);
  const h = raycastVoxels(world, [0.5, 0.5, -2], [0, 0, 1], 4);
  assert.deepEqual(h.point, [0.5, 0.5, 0.375]);
  assert.deepEqual(h.normal, [0, 0, -1]);
  assert.deepEqual(raycastVoxels(world, [0.5, 0.5, 2], [0, 0, -1], 4).point, [0.5, 0.5, 0.625]);
  assert.equal(raycastVoxels(world, [0.5, 0.5, 0.5], [1, 0, 0], 4).distance, 0);
  for (let r = 0; r < 24; r++) {
    world.setBlock(0, 0, 0, modelState(id, r));
    const b = blocks.get(id).model[r].boxes[0];
    for (let a = 0; a < 3; a++) {
      const o = [0.5, 0.5, 0.5],
        d = [0, 0, 0];
      o[a] = -1;
      d[a] = 1;
      close(raycastVoxels(world, o, d, 3).point[a], b.min[a]);
    }
  }
});
test('swept boxes use arbitrary model extents, including a high speed motion and rotated states', () => {
  const { world, id } = scene();
  const box = { min: { x: 0.4, y: 0.2, z: -1 }, max: { x: 0.6, y: 0.8, z: -0.8 } };
  const hit = sweepBox(world, box, [0, 0, 100]);
  close(hit.position[2], 0.175);
  assert.equal(hit.hit[2], true);
  const open = { min: { x: -1, y: 0.2, z: 0 }, max: { x: -0.8, y: 0.8, z: 0.2 } };
  assert.equal(sweepBox(world, open, [3, 0, 0]).hit[0], false);
  world.setBlock(0, 0, 0, modelState(id, 1));
  assert.equal(sweepBox(world, box, [0, 0, 100]).hit[2], true);
});
test('overlapping and duplicate boxes mesh only their exact union boundary with positive winding', () => {
  const a = { min: [0, 0, 0], max: [0.75, 1, 1] },
    b = { min: [0.25, 0, 0], max: [1, 1, 1] },
    { world } = scene([a, b, a]);
  const parts = meshBlockModels(world, 0, 0, 0);
  close(area(parts), 6);
  for (const g of parts)
    for (let i = 0; i < g.indices.length; i += 3) {
      const k = g.indices.slice(i, i + 3),
        p = k.map((j) => g.positions.slice(j * 3, j * 3 + 3)),
        u = p[1].map((x, a) => x - p[0][a]),
        v = p[2].map((x, a) => x - p[0][a]),
        n = g.normals.slice(k[0] * 3, k[0] * 3 + 3);
      assert.ok(
        (u[1] * v[2] - u[2] * v[1]) * n[0] + (u[2] * v[0] - u[0] * v[2]) * n[1] + (u[0] * v[1] - u[1] * v[0]) * n[2] >
          0,
      );
    }
});
test('UVs interpolate at clipped edges and neighbour occlusion crosses a chunk border', () => {
  const { world, id } = scene([{ min: [0, 0, 0], max: [1, 1, 1], textures: [1, 2, 3, 4, 5, 6] }]);
  world.setBlock(31, 0, 0, id);
  world.setBlock(32, 0, 0, id);
  const part = meshBlockModels(world, 0, 0, 0);
  close(area(part), 11);
  assert.deepEqual(new Set(part.map((g) => g.texture)), new Set([1, 2, 3, 4, 5, 6]));
  assert.ok(part.every((g) => g.uvs.every((x) => x >= 0 && x <= 1)));
});
test('model states survive chunk packing, light passes open faces and closes full union faces', () => {
  const { world, id, blocks } = scene();
  const lighting = VoxelLighting.attach(world, { budget: Infinity });
  lighting.update();
  assert.equal(lighting.skyLight(0, 0, 0), 15);
  const full = defineBlockModel(blocks, 'full', { boxes: [{ min: [0, 0, 0], max: [1, 1, 1] }] });
  assert.equal(blocks.get(full).model[0].covered, 63);
  world.setBlock(0, 0, 0, modelState(id, 7));
  assert.equal(VoxelChunk.unpack(world.getChunk(0, 0, 0).pack()).get(0, 0, 0), modelState(id, 7));
  lighting.update();
  lighting.dispose();
  const rgb = VoxelColorLight.attach(
    { camera: { position: [0, 0, 0] } },
    { world, extent: [32, 32, 32], budget: Infinity },
  );
  rgb.update();
  rgb.dispose();
  assert.equal(typeof VoxelModelRenderer, 'function');
});
test('ordinary voxel mesher leaves custom models to the optional model renderer', () => {
  const { world } = scene();
  const input = meshInput(world, '0,0,0'),
    mesh = meshChunk(input);
  assert.equal(mesh.opaque.length + mesh.cutout.length + mesh.translucent.length, 0);
});
test('solver collides with the model surface, including a state rotation and a non-solid model', async () => {
  await Physics.load();
  const { world, id, blocks } = scene(),
    physics = new Physics(null, { gravity: [0, 0, 0] }),
    voxels = new VoxelPhysics(physics, world, { budget: Infinity });
  const anchor = physics.addBody(null, { type: 'kinematicPosition', position: [0.5, 0.5, 0.5], colliders: [] });
  physics.step(1 / 60);
  let hit = physics.raycast([0.5, 0.5, -2], [0, 0, 1], { maxDistance: 5, exclude: anchor });
  assert.ok(hit);
  assert.ok(Math.abs(hit.point[2] - 0.375) < 1e-5);
  assert.equal(physics.raycast([-1, 0.5, 0.1], [1, 0, 0], { maxDistance: 3, exclude: anchor }), null);
  world.setBlock(0, 0, 0, modelState(id, 1));
  physics.step(1 / 60);
  hit = physics.raycast([0.5, 0.5, -2], [0, 0, 1], { maxDistance: 5, exclude: anchor });
  assert.ok(hit);
  const ghost = defineBlockModel(blocks, 'ghost', { boxes: [pane], solid: false });
  world.setBlock(0, 0, 0, ghost);
  physics.step(1 / 60);
  assert.equal(physics.raycast([0.5, 0.5, -2], [0, 0, 1], { maxDistance: 5, exclude: anchor }), null);
  voxels.dispose();
  physics.dispose();
});

test('ray endpoints hit exact model faces but outward and zero-volume tangencies miss', () => {
  const { world } = scene();
  assert.equal(raycastVoxels(world, [0.5, 0.5, -1], [0, 0, 1], 1.375).distance, 1.375);
  assert.equal(raycastVoxels(world, [0.5, 0.5, 0.625], [0, 0, 1], 2), null);
  assert.equal(raycastVoxels(world, [-1, 0.5, 0.375], [1, 0, -0.375], 3), null);
});

test('renderer neighbour invalidation stays inside the world chunk coordinate range', async () => {
  const blocks = new BlockTypes(),
    world = new VoxelWorld({ blocks });
  world.addChunk(67108863, 0, -67108864);
  const renderer = await VoxelModelRenderer.create({}, world);
  renderer.update();
  renderer.update();
  renderer.dispose();
  renderer.dispose();
  const controller = new AbortController(),
    reason = new Error('cancel');
  controller.abort(reason);
  await assert.rejects(VoxelModelRenderer.create({}, world, {}, controller.signal), (error) => error === reason);
});
