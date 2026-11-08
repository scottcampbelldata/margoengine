// @margoengine/voxel/lod: node choice (one node over every point in view, a ring per level), level-1 masking by the
// real world's chunks, no hole while levels change, and noiseTerrainLod against the full-resolution noiseTerrain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelChunk, VoxelWorld } from '../dist/index.js';
import { noiseTerrain } from '../dist/generate.js';
import { noiseTerrainLod, VoxelLod } from '../dist/lod.js';
import { BlockTextures, VoxelRenderer } from '../dist/render.js';

const terrainBlocks = () => {
  const blocks = new BlockTypes();
  for (const name of ['stone', 'dirt', 'grass', 'sand']) blocks.define(name);
  blocks.define('water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' });
  blocks.define('log');
  blocks.define('leaves', { layer: 'cutout' });
  return blocks;
};
const solid = (chunk) => chunk.fill(1);

// Every far node on show (and the real chunks) holding block (x, y, z), counted.
const owners = (lod, world, x, y, z) => {
  let n = world.getChunk(x >> 5, y >> 5, z >> 5) ? 1 : 0;
  for (const { scale, world: level } of lod.levels) {
    const s = 32 * scale,
      node = level.getChunk(Math.floor(x / s), Math.floor(y / s), Math.floor(z / s));
    if (!node) continue;
    // A level-1 node over a loaded real chunk has those cells empty.
    if (node.get(Math.floor(x / scale) & 31, Math.floor(y / scale) & 31, Math.floor(z / scale) & 31) !== 0) n++;
  }
  return n;
};
let seed = 7;
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;

test('one node over every point in view, the view doubling per level at the same node count', () => {
  const world = new VoxelWorld({ blocks: terrainBlocks() }),
    eye = [1000.5, 40, -333.25],
    counts = [];
  for (const levels of [3, 4, 5]) {
    const lod = new VoxelLod({ world, generate: solid, levels, radius: 6, minY: -64, maxY: 191, budget: Infinity });
    assert.equal(lod.update(eye) > 0, true);
    assert.equal(lod.update(eye), 0);
    assert.equal(lod.stats.pending, 0);
    const reach = 6 * 32 * 2 ** levels;
    for (let i = 0; i < 4000; i++) {
      const x = Math.floor(eye[0] + (random() * 2 - 1) * reach * 0.999),
        z = Math.floor(eye[2] + (random() * 2 - 1) * reach * 0.999),
        y = Math.floor(-64 + random() * 256);
      assert.equal(owners(lod, world, x, y, z), 1, `level ${levels}: block ${x},${y},${z}`);
    }
    // Past the view: nothing.
    assert.equal(owners(lod, world, Math.floor(eye[0] + reach + 32 * 2 ** levels + 1), 0, Math.floor(eye[2])), 0);
    counts.push(lod.stats.nodes);
    lod.dispose();
  }
  // Each level is a ring of nodes of about the same count, whatever its size: (2 radius + 4)^2 columns at most,
  // times the node layers that the y range -64..191 crosses (4 at level 1, then 3, then 2).
  for (const c of counts)
    c.forEach((n, l) => assert.ok(n <= 16 * 16 * Math.max(2, 4 - l), `level ${l + 1}: ${n} nodes`));
  // Twice the view per level: the node total grows by about one ring per level, not fourfold.
  const total = counts.map((c) => c.reduce((a, b) => a + b, 0));
  assert.ok(total[2] - total[1] <= 16 * 16 * 2 && total[1] - total[0] <= 16 * 16 * 2, `${total}`);
});

test('level 1 leaves the cells of loaded real chunks empty and fills them again when they unload', () => {
  const world = new VoxelWorld({ blocks: terrainBlocks() }),
    lod = new VoxelLod({ world, generate: solid, levels: 2, radius: 4, minY: 0, maxY: 63, budget: Infinity });
  lod.update([16, 16, 16]);
  const level1 = lod.levels[0].world;
  assert.equal(level1.getChunk(0, 0, 0).get(3, 3, 3), 1);
  world.addChunk(0, 0, 0);
  assert.equal(lod.stats.pending, 1); // one node to mask again
  lod.update([16, 16, 16]);
  const node = level1.getChunk(0, 0, 0);
  assert.equal(node.get(3, 3, 3), 0); // inside real chunk 0,0,0: empty
  assert.equal(node.get(16, 3, 3), 1); // real chunk 1,0,0 is not loaded
  assert.equal(owners(lod, world, 5, 5, 5), 1);
  assert.equal(owners(lod, world, 40, 5, 5), 1);
  // All eight chunks loaded: the node has no cells and leaves its level.
  for (let k = 1; k < 8; k++) world.addChunk(k & 1, (k >> 1) & 1, k >> 2);
  lod.update([16, 16, 16]);
  assert.equal(level1.getChunk(0, 0, 0), undefined);
  for (let k = 0; k < 8; k++) world.removeChunk(k & 1, (k >> 1) & 1, k >> 2);
  lod.update([16, 16, 16]);
  assert.equal(level1.getChunk(0, 0, 0).get(3, 3, 3), 1);
  lod.dispose();
  assert.equal(level1.getChunk(0, 0, 0), undefined);
});

// Regression (2026-11-07): VoxelLod had dispose() but no [Symbol.dispose](), so `using` did not work (api-conventions).
test('a VoxelLod declared with using drops its nodes at the end of the block', () => {
  const world = new VoxelWorld({ blocks: terrainBlocks() });
  let level1;
  {
    using lod = new VoxelLod({ world, generate: solid, levels: 2, radius: 4, minY: 0, maxY: 63, budget: Infinity });
    lod.update([16, 16, 16]);
    level1 = lod.levels[0].world;
    assert.equal(level1.getChunk(0, 0, 0).get(3, 3, 3), 1);
  }
  assert.equal(level1.getChunk(0, 0, 0), undefined);
});

test('moving the eye one node a frame never opens a hole, and settles to one node per point', () => {
  const world = new VoxelWorld({ blocks: terrainBlocks() }),
    lod = new VoxelLod({ world, generate: solid, levels: 3, radius: 3, minY: 0, maxY: 31, budget: 3 });
  const eye = [0, 10, 0];
  while (lod.update(eye));
  const reach = 3 * 32 * 8;
  // Fixed sample points: one covered before a step stays covered after it, while it is still in view (new ground at
  // the horizon comes in over a few frames; two nodes may overlap while a level changes).
  const points = Array.from({ length: 3000 }, () => [
    Math.floor((random() * 2 - 0.5) * 2 * reach),
    Math.floor(random() * 32),
    Math.floor((random() * 2 - 1.5) * 2 * reach),
  ]);
  for (let step = 0; step < 40; step++) {
    const before = points.map(([x, y, z]) => owners(lod, world, x, y, z) > 0);
    eye[0] += 37;
    eye[2] -= 11;
    lod.update(eye);
    points.forEach(([x, y, z], i) => {
      const inView = Math.max(Math.abs(x - eye[0]), Math.abs(z - eye[2])) < reach - 256;
      if (before[i] && inView) assert.ok(owners(lod, world, x, y, z) >= 1, `step ${step}: hole at ${x},${y},${z}`);
    });
  }
  while (lod.update(eye));
  for (let i = 0; i < 2000; i++) {
    const x = Math.floor(eye[0] + (random() * 2 - 1) * reach * 0.999),
      z = Math.floor(eye[2] + (random() * 2 - 1) * reach * 0.999);
    assert.equal(owners(lod, world, x, Math.floor(random() * 32), z), 1);
  }
});

test('noiseTerrainLod: each coarse column is the real ground rounded to the nearest cell', () => {
  const blocks = terrainBlocks(),
    table = blocks.table,
    options = { seed: 11, trees: 0, caves: 0, height: 20, amplitude: 24 },
    real = noiseTerrain(options),
    far = noiseTerrainLod(options),
    name = (state) => table[state].name;
  // Real ground heights of chunk column (cx, cz) = (3, -2), 0 <= y < 64.
  const heights = new Map();
  for (let cy = -1; cy < 2; cy++) {
    const chunk = new VoxelChunk();
    real(chunk, 3, cy, -2, { blocks: table });
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++)
        for (let y = 0; y < 32; y++) {
          const s = chunk.get(x, y, z);
          if (s && name(s) !== 'water')
            heights.set(`${x},${z}`, Math.max(heights.get(`${x},${z}`) ?? -1e9, cy * 32 + y));
        }
  }
  for (const s of [2, 4]) {
    // Node of scale s holding block (96, 0, -64): node x = 96 / (32 s).
    const nx = Math.floor(96 / (32 * s)),
      nz = Math.floor(-64 / (32 * s)),
      node = new VoxelChunk(),
      below = new VoxelChunk();
    far(node, nx, 0, nz, s, { blocks: table });
    far(below, nx, -1, nz, s, { blocks: table });
    let checked = 0;
    for (let k = 0; k < 32; k++)
      for (let i = 0; i < 32; i++) {
        const bx = (nx * 32 + i) * s + s / 2 - 96,
          bz = (nz * 32 + k) * s + s / 2 + 64;
        if (bx < 0 || bx >= 32 || bz < 0 || bz >= 32) continue;
        const h = heights.get(`${bx},${bz}`);
        let top = -1;
        for (let j = 31; j >= 0 && top < 0; j--) if (node.get(i, j, k) && name(node.get(i, j, k)) !== 'water') top = j;
        let topBlock = (top + 1) * s; // the coarse ground's top face, in blocks
        if (top < 0) {
          for (let j = 31; j >= 0 && top < 0; j--)
            if (below.get(i, j, k) && name(below.get(i, j, k)) !== 'water') top = j;
          topBlock = (top + 1 - 32) * s;
        }
        assert.ok(Math.abs(topBlock - (h + 1)) <= s / 2, `scale ${s}: column ${bx},${bz} top ${topBlock} vs ${h + 1}`);
        checked++;
      }
    assert.ok(checked >= 64 / s / s);
  }
  assert.throws(() => far(new VoxelChunk(), 0, 0, 0, 2, { blocks: new BlockTypes().table }), RangeError);
});

test('options are checked', () => {
  const world = new VoxelWorld({ blocks: terrainBlocks() });
  assert.throws(() => new VoxelLod({ world: {}, generate: solid }), TypeError);
  assert.throws(() => new VoxelLod({ world, generate: 1 }), TypeError);
  assert.throws(() => new VoxelLod({ world, generate: solid, levels: 13 }), RangeError);
  assert.throws(() => new VoxelLod({ world, generate: solid, radius: 1 }), RangeError);
  assert.throws(() => new VoxelLod({ world, generate: solid, minY: 10, maxY: 0 }), RangeError);
  assert.throws(() => new VoxelLod({ world, generate: solid }).update([0, Number.NaN, 0]), TypeError);
  assert.throws(() => noiseTerrainLod({ scale: 0 }), RangeError);
  // VoxelRenderer scale: a power of two from 1 to 4096 (checked before the engine is touched).
  const textures = new BlockTextures({ images: [{ width: 16, height: 16, data: new Uint8Array(1024) }] });
  for (const scale of [0, 3, 8192, 1.5])
    assert.throws(() => VoxelRenderer.attach({}, { world, textures, scale }), RangeError);
  assert.throws(() => VoxelRenderer.attach({}, { world, textures, scale: '2' }), TypeError);
});
