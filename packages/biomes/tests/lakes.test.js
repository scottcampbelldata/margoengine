// Job E (biomes best plan): water that shows. Lakes at the fill level of the hydrology's pits and river lines from its
// channels, through `@margoengine/biomes/rivers` (`lakeLevels`, `riverWater` with `lakes`, `viewWater`). Before this,
// lakes existed in the hydrology's data only and no view drew them; channels were never drawn. The real-GPU proof is
// water-check.mjs (test:gpu).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { hydrology, hydrologyOf, riversOf } from '../dist/hydrology.js';
import { BiomeView } from '../dist/view.js';
import { lakeLevels, NO_LAKE, riverSources, riverWater, viewWater } from '../dist/rivers.js';

// A 7 x 7 grid 1 m apart: low border, a rim at 20 m with one spill corner at 12 m, a pit of 3 x 3 inside it at 0 m with
// one corner at 11.5 m (filled only 0.5 m, under the 1 m lake depth, but on the same flat fill).
function pit() {
  const nx = 7,
    height = new Int32Array(nx * nx);
  for (let z = 0; z < nx; z++)
    for (let x = 0; x < nx; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(z - 3));
      height[z * nx + x] = ring === 3 ? 0 : ring === 2 ? 20000 : 0;
    }
  height[1 * nx + 3] = 12000; // the spill
  height[3 * nx + 4] = 11500; // shallow, joined to the lake
  return { height, nx, nz: nx, step: 1000 };
}

test('lakeLevels: the lake and its flat fill take the spill level, the dry ring holds it, past that no lake', () => {
  const grid = pit(),
    h = hydrology(grid),
    lakes = lakeLevels(h),
    at = (x, z) => lakes.level[z * 7 + x];
  assert.equal(h.lake[3 * 7 + 3], 1);
  assert.equal(h.lake[3 * 7 + 4], 0, 'the shallow corner is no lake cell of its own');
  for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) assert.equal(at(x, z), 12000, `pit ${x},${z}`);
  // The rim, spill included, holds the level; the border beyond it has no lake.
  for (const [x, z] of [
    [1, 1],
    [3, 1],
    [5, 3],
    [5, 5],
  ])
    assert.equal(at(x, z), 12000, `rim ${x},${z}`);
  for (const [x, z] of [
    [0, 0],
    [3, 0],
    [6, 6],
  ])
    assert.equal(at(x, z), NO_LAKE, `border ${x},${z}`);
  assert.deepEqual([lakes.nx, lakes.nz, lakes.step], [7, 7, 1000]);
  // Integers only: the same hydrology, the same bytes.
  assert.deepEqual(lakeLevels(hydrology(pit())).level, lakes.level);
});

test('lakeLevels: a shallow pit not joined to a lake is no lake', () => {
  const grid = pit();
  // Raise the pit to 11.5 m: filled 0.5 m everywhere, under the 1 m lake depth.
  for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) grid.height[z * 7 + x] = 11500;
  const lakes = lakeLevels(hydrology(grid));
  assert.ok(
    lakes.level.every((l) => l === NO_LAKE),
    'no lake cell, no level',
  );
});

test('riverWater with lakes: the lake surface over the lowest ground, the sea wins below sea level', () => {
  const grid = pit(),
    lakes = lakeLevels(hydrology(grid)),
    heights = Float32Array.from(grid.height, (mm) => mm / 1000), // float division: mm to metres
    source = { bounds: [0, 0, 6, 6], heights, width: 7, depth: 7, lines: [], heightAt: () => 0, sea: -5, lakes },
    water = riverWater(source);
  assert.deepEqual([water.width, water.depth], [6, 6]);
  // Cell (2, 2) has its centre at 2.5 m, nearest corner 3: in the pit.
  assert.equal(water.fill(2.5, 2.5), 12);
  assert.equal(water.ground[2 * 6 + 2], 0, 'the lowest corner under the cell, not a bank');
  // Cell (0, 0) maps to corner 1: the rim, dry, holding the level.
  assert.equal(water.fill(0.5, 0.5), 12);
  // Cell (5, 5) maps to corner 6: the border, no lake.
  assert.equal(water.fill(5.5, 5.5), undefined);
  // Below the sea a lake is the sea's.
  assert.equal(riverWater({ ...source, sea: 12 }).fill(2.5, 2.5), undefined);
  // Without lakes, as before: no fill.
  assert.equal(riverWater({ ...source, lakes: undefined }).fill(2.5, 2.5), undefined);
  assert.throws(() => riverWater({ ...source, lakes: { ...lakes, nx: 6 } }), RangeError);
});

test('viewWater: hydrology rivers follow the channels, auto lakes stand at the fill, nothing asked gives nothing', async () => {
  const world = await BiomeWorld.create({
      height: { relief: { seed: 3, relief: 900, base: 300, rivers: 1, coast: 'south' } },
    }),
    { width, depth, height: heights } = world.overview(),
    source = { bounds: world.bounds, heights, width, depth, heightAt: (x, z) => world.heightAt(x, z), sea: 0 },
    device = () => undefined,
    h = hydrologyOf(world),
    { lines } = riversOf(world, h);
  assert.ok(lines.length >= 1);
  const rivers = await viewWater(world, { rivers: 'hydrology' }, source, device);
  // Along the channels, every 2 m above the sea, the water stands over the ground (measured 0.916 on this world: the
  // lines run in 45 degree pieces over the region grid, so a few metres cross the detail's bumps).
  let n = 0,
    wet = 0;
  for (const line of lines)
    for (let k = 0; k + 3 < line.length; k += 2) {
      const ax = line[k] / 1000, // float division
        az = line[k + 1] / 1000, // float division
        bx = line[k + 2] / 1000, // float division
        bz = line[k + 3] / 1000, // float division
        m = Math.ceil(Math.hypot(bx - ax, bz - az) / 2); // float division: 2 m steps
      for (let s = 0; s < m; s++) {
        const x = ax + ((bx - ax) * s) / m, // float division
          z = az + ((bz - az) * s) / m, // float division
          ground = world.heightAt(x, z),
          level = rivers.options.fill(x, z);
        if (ground < 0) continue;
        n++;
        if (level !== undefined && level > ground) wet++;
      }
    }
  assert.ok(n > 1000 && wet / n > 0.85, `water over ${wet} of ${n} channel samples`);
  // Lakes: the deepest lake cell of the region is under water at its fill level.
  const lakes = await viewWater(world, { lakes: 'auto' }, source, device);
  let deepest = -1;
  for (let c = 0; c < h.lake.length; c++)
    if (h.lake[c] && (deepest < 0 || h.filled[c] - h.height[c] > h.filled[deepest] - h.height[deepest])) deepest = c;
  assert.ok(deepest >= 0, 'the world has a lake');
  const x = world.bounds[0] + ((deepest % h.nx) * h.step) / 1000, // float division
    z = world.bounds[1] + (Math.floor(deepest / h.nx) * h.step) / 1000; // float division
  assert.equal(lakes.options.fill(x + 1, z + 1), Math.fround(h.filled[deepest] / 1000)); // float division: f32 levels
  assert.ok(lakes.options.fill(x + 1, z + 1) > world.heightAt(x, z) + 1);
  // Lakes and rivers together; the world's own relief lines as before; nothing asked, nothing made.
  assert.ok(await viewWater(world, { rivers: 'auto', lakes: 'auto' }, source, device));
  assert.ok(await viewWater(world, { rivers: 'auto' }, source, device));
  assert.equal(await viewWater(world, {}, source, device), undefined);
  assert.equal(await viewWater(world, { rivers: [], lakes: false }, source, device), undefined);
  world.dispose();
});

test('viewWater: auto rivers on a world with no lines and no lakes asked give no river water, as before', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] }),
    { width, depth, height: heights } = world.overview();
  assert.equal(world.rivers.length, 0);
  const source = { bounds: world.bounds, heights, width, depth, heightAt: (x, z) => world.heightAt(x, z), sea: 0 };
  assert.equal(await viewWater(world, { rivers: 'auto' }, source, () => undefined), undefined);
  world.dispose();
});

test('view: bad lakes are a TypeError before anything loads', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] });
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { water: { lakes: 'yes' } }), TypeError);
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { water: { rivers: 'channels' } }), TypeError);
  world.dispose();
});

test('view flow: bad flow settings are rejected before anything loads; riverSources feeds each line at its high end', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] });
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { water: { flow: 'yes' } }), TypeError);
  await assert.rejects(
    BiomeView.attach({ backend: 'webgpu' }, world, { water: { flow: { discharge: -1 } } }),
    RangeError,
  );
  await assert.rejects(
    BiomeView.attach({ backend: 'webgpu' }, world, { water: { flow: { substeps: 0 } } }),
    RangeError,
  );
  world.dispose();
  // Two lines in millimetres; the ground falls to +x, so the first line starts and the second ends upstream.
  const lines = [Int32Array.of(0, 0, 50000, 0, 100000, 0), Int32Array.of(90000, 10000, 10000, 10000)],
    heightAt = (x) => 100 - x;
  assert.deepEqual(riverSources(lines, heightAt, 20, 4), [
    { position: [0, 0], discharge: 20, radius: 4 },
    { position: [10, 10], discharge: 20, radius: 4 },
  ]);
  assert.deepEqual(riverSources([Int32Array.of(5)], heightAt, 20, 4), []);
  assert.throws(() => riverSources(lines, heightAt, Number.NaN, 4), RangeError);
  assert.throws(() => riverSources(lines, 3, 20, 4), TypeError);
});
