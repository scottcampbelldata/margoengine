// Island demo helpers: `BiomeWorld.heightAt` (ground height in metres at a point, equal to what the tiles hold) and a
// painted clearing (a biome without plants, painted through the editor, which keeps stored objects and detail out).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomeEditor } from '../dist/editor.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets, presetWorlds } from '../dist/presets.js';

const island = presetWorlds.island;
const islandWorld = (extra = {}) =>
  BiomeWorld.create({
    size: [1024, 1024],
    climate: island.climate,
    height: { relief: island.relief },
    biomes: island.biomes,
    workers: false,
    ...extra,
  });

test('heightAt equals the height cells of the tiles at their nodes, and is bilinear between them', async () => {
  const w = await islandWorld(),
    tile = await w.tile(1, 1),
    height = tile.layer('height'),
    cells = tile.cells;
  for (const [i, j] of [
    [0, 0],
    [17, 3],
    [128, 200],
    [cells - 2, cells - 2],
  ]) {
    const x = tile.origin[0] + i * w.resolution,
      z = tile.origin[1] + j * w.resolution,
      want = height.data[j * cells + i] * height.scale;
    assert.equal(w.heightAt(x, z), want, `node ${i},${j}`);
    const next = height.data[j * cells + i + 1] * height.scale,
      mid = w.heightAt(x + 0.5 * w.resolution, z);
    assert.ok(Math.abs(mid - (want + next) / 2) < 1e-9, `midpoint of ${i},${j}`);
  }
});

test('heightAt follows a plane exactly and reads the source again after update', async () => {
  const w = await BiomeWorld.create({
    size: [512, 512],
    height: { field: (x, z) => 3 + 0.25 * x - 0.125 * z },
    workers: false,
  });
  for (const [x, z] of [
    [0, 0],
    [12.3, -40.7],
    [-200.25, 111.1],
  ])
    assert.ok(Math.abs(w.heightAt(x, z) - (3 + 0.25 * x - 0.125 * z)) < 1e-3, `plane at ${x},${z}`);
  w.update({ height: { field: () => 7 } });
  assert.equal(w.heightAt(5.5, 6.5), 7);
});

test('heightAt answers for the nearest edge outside the world and rejects non-finite input', async () => {
  const w = await BiomeWorld.create({ size: [512, 512], height: { field: (x) => x / 10 }, workers: false });
  assert.equal(w.heightAt(-9999, 0), w.heightAt(w.bounds[0], 0));
  assert.equal(w.heightAt(9999, 9999), w.heightAt(w.bounds[2], w.bounds[3]));
  for (const bad of [Number.NaN, Infinity]) {
    assert.throws(() => w.heightAt(bad, 0), RangeError);
    assert.throws(() => w.heightAt(0, bad), RangeError);
  }
  w.dispose();
  assert.throws(() => w.heightAt(0, 0), { code: 'disposed' });
});

test('point queries made while tiles are requested leave the tiles unchanged', async () => {
  const fresh = await islandWorld(),
    probed = await islandWorld(),
    want = [];
  for (const [x, z] of [
    [1, 1],
    [2, 2],
  ])
    want.push(await fresh.digest(x, z));
  const got = [];
  for (const [x, z] of [
    [1, 1],
    [2, 2],
  ]) {
    const pending = probed.digest(x, z);
    for (let k = 0; k < 50; k++) probed.heightAt(k * 7.3 - 200, k * 3.1 - 100);
    got.push(await pending);
  }
  assert.deepEqual(got, want);
});

/** A tropical forest on flat land with a `clearing` biome that no climate selects (only paint does). */
const forest = () =>
  BiomeWorld.create({
    size: [512, 512],
    seed: 5,
    height: { field: () => 30 },
    climate: { latitude: 9, rainfall: 2400, coldAir: 0 },
    biomes: [
      presets.tropical,
      defineBiome({
        id: 'clearing',
        climate: { custom: { 'mask/clearing': [0.5, null] } },
        ground: [{ material: 'grass' }],
      }),
    ],
    workers: false,
  });

const records = async (world, placement) => {
  const out = [];
  for (let z = 0; z < world.tilesZ; z++)
    for (let x = 0; x < world.tilesX; x++)
      (await placement.tile(x, z)).forEachInstance((i) => out.push({ x: i.x, z: i.z }));
  return out;
};

test('a clearing painted through the editor keeps stored objects out and leaves the rest of the forest alone', async () => {
  const world = await forest(),
    placement = BiomePlacement.attach(world),
    before = await records(world, placement),
    inside = (r, c, radius) => Math.hypot(r.x - c[0], r.z - c[1]) < radius;
  assert.ok(before.filter((r) => inside(r, [40, -30], 60)).length > 40, 'a forest stands there before the paint');
  const editor = BiomeEditor.attach(world);
  editor.paint('clearing', { center: [40, -30], radius: 60, falloff: 'constant' });
  const after = await records(world, placement);
  // The 24 m ecotone feather ramps the edge: the core (radius less 25 m) is bare.
  assert.equal(after.filter((r) => inside(r, [40, -30], 35)).length, 0, 'nothing stands in the clearing');
  const far = (r) => !inside(r, [40, -30], 60 + placement.reach + 30);
  assert.deepEqual(
    after.filter(far).map((r) => [r.x, r.z]),
    before.filter(far).map((r) => [r.x, r.z]),
    'tiles beyond the edit are unchanged',
  );
  editor.undo();
  assert.equal((await records(world, placement)).length, before.length, 'undo brings the forest back');
});
