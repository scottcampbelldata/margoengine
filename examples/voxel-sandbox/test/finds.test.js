import { speedBudget } from '../../../scripts/speed/budgets.mjs';
// What a Plaza world hides: the fields finds.ts evaluates match real terrain, the opals are exact, chunks come out the same
// in any order, and nothing touches the square, the sign or the spawn ring.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelChunk } from '@margoengine/voxel';
import { defineBlocks } from '../src/blocks.ts';
import { GEM_DEPTH, GEM_RADIUS, gemChunkKey, isFindsClear, plazaFinds, VEINS } from '../src/finds.ts';
import { sandboxGenerator } from '../src/plants.ts';
import {
  COUNTED_BLOCKS,
  GEM_TOTAL,
  onApron,
  onDisc,
  PLAZA_RING_CANDIDATES,
  plazaFloor,
  plazaGenerator,
  plazaRingColumn,
  plazaSpawnRing,
} from '../src/plaza.ts';
import { terrainOptions } from '../src/terrain.ts';

const { blocks } = defineBlocks(),
  context = { blocks: blocks.table },
  id = (name) => blocks.id(name),
  world = (seed) => plazaGenerator(sandboxGenerator(seed, terrainOptions(seed)), seed),
  plain = (seed) => sandboxGenerator(seed, terrainOptions(seed));

async function chunkOf(generate, cx, cy, cz) {
  const chunk = new VoxelChunk();
  await generate(chunk, cx, cy, cz, context);
  return chunk;
}

// Reads cells, generating each chunk once.
function reader(generate) {
  const chunks = new Map();
  return async (x, y, z) => {
    const key = `${x >> 5},${y >> 5},${z >> 5}`;
    if (!chunks.has(key)) chunks.set(key, await chunkOf(generate, x >> 5, y >> 5, z >> 5));
    return chunks.get(key).get(x & 31, y & 31, z & 31) & 0xffff;
  };
}

test('the terrain options the views and the Plaza use', () => {
  assert.deepEqual(terrainOptions(7), {
    seed: 7,
    seaLevel: 0,
    height: 8,
    amplitude: 32,
    scale: 192,
    caves: 0.3,
    trees: 0.012,
  });
});

test('the height and tunnel fields here are the ones noiseTerrain builds with', async () => {
  const seed = 5,
    finds = plazaFinds(seed),
    read = reader(plain(seed)),
    solid = new Set(blocks.table.filter((b) => b.solid && b.name !== 'log' && b.name !== 'leaves').map((b) => b.id));
  let tunnels = 0;
  for (let z = -40; z < 40; z += 7)
    for (let x = 200; x < 280; x += 7) {
      const top = finds.surface(x, z);
      assert.ok(
        solid.has(await read(x, top, z)) || (await read(x, top, z)) === id('water'),
        `${x},${z} ground at ${top}`,
      );
      for (let y = top + 1; y < top + 3; y++)
        assert.ok(!solid.has(await read(x, y, z)), `${x},${y},${z} over the ground`);
      if (top <= 2) continue;
      for (let y = top - 1; y > top - 30; y--) {
        const open = (await read(x, y, z)) === 0;
        // Rock beside the sea stays rock, so check above the sea only.
        if (y > 0) assert.equal(open, finds.isTunnel(x, y, z), `${x},${y},${z}`);
        if (open) tunnels++;
      }
    }
  assert.ok(tunnels > 50, `${tunnels} tunnel cells checked`);
});

test('exactly GEM_TOTAL opals, known from the seed, each generated where the list says', async () => {
  assert.equal(GEM_TOTAL, 1000);
  for (const seed of [1, 2, 3]) {
    const start = performance.now(),
      gems = plazaFinds(seed).gems,
      ms = performance.now() - start;
    const list = [...gems.values()].flat();
    assert.equal(list.length, GEM_TOTAL, `seed ${seed}`);
    assert.equal(new Set(list.map(String)).size, GEM_TOTAL, 'all different');
    speedBudget('sandbox-finds', { ms });
    for (const [x, y, z] of list) {
      assert.ok(Math.hypot(x, z) <= GEM_RADIUS + 1, 'inside the radius');
      assert.ok(isFindsClear(x, z), `${x},${z} clear of the square and ring`);
      const top = plazaFinds(seed).surface(x, z);
      assert.ok(top > 1, 'dry column');
      assert.ok(top - y >= GEM_DEPTH[0] && top - y <= GEM_DEPTH[1], `depth ${top - y}`);
    }
  }
  // Every opal of a stretch of world really is in its chunk, and no other cell is opal.
  const seed = 2,
    finds = plazaFinds(seed),
    generate = world(seed),
    opal = id('opal');
  let checked = 0,
    open = 0;
  const air = new Set([0, id('glow_cap')]);
  for (const [key, list] of [...finds.gems].slice(0, 60)) {
    const [cx, cy, cz] = key.split(',').map(Number),
      chunk = await chunkOf(generate, cx, cy, cz);
    let found = 0;
    for (let z = 0; z < 32; z++)
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if ((chunk.get(x, y, z) & 0xffff) === opal) found++;
    assert.equal(found, list.length, key);
    for (const [x, y, z] of list) {
      assert.equal(finds.isGem(x, y, z), true);
      assert.equal(
        finds.isGem(x + 1, y, z),
        list.some(([a, b, c]) => a === x + 1 && b === y && c === z),
      );
      checked++;
      const above = (y & 31) < 31 ? chunk.get(x & 31, (y & 31) + 1, z & 31) & 0xffff : -1;
      if (above === -1 || air.has(above)) open++;
    }
  }
  assert.ok(checked > 30);
  assert.ok(open / checked > 0.9, `${open} of ${checked} opals are open to a cave above them`);
  assert.equal(gemChunkKey(-1, 0, 2), '-1,0,2');
});

test('a chunk is the same in any order, and from a fresh world', async () => {
  const seed = 9,
    coords = [];
  for (let cx = -1; cx <= 1; cx++)
    for (let cz = 2; cz <= 3; cz++) for (let cy = -1; cy <= 1; cy++) coords.push([cx, cy, cz]);
  const pack = async (generate, list) => {
    const out = new Map();
    for (const c of list) {
      const chunk = await chunkOf(generate, ...c);
      out.set(c.join(), [...chunk.pack().words]);
    }
    return out;
  };
  const a = await pack(world(seed), coords),
    // A worker that only ever sees the same chunks backwards, after another world asked for its finds.
    other = plazaFinds(seed + 1).gems.size,
    b = await pack(world(seed), [...coords].reverse());
  assert.ok(other > 0);
  for (const key of a.keys()) assert.deepEqual(a.get(key), b.get(key), key);
});

test('glow caps per area stay in their band, and veins fall in their depth bands', async () => {
  const cap = id('glow_cap'),
    veinIds = new Map(VEINS.map(([name, min, max]) => [id(name), [name, min, max]])),
    counts = new Map();
  for (const seed of [11, 12]) {
    const finds = plazaFinds(seed),
      generate = world(seed);
    let caps = 0;
    for (let cx = -2; cx < 2; cx++)
      for (let cz = -2; cz < 2; cz++) {
        for (let cy = -2; cy <= 1; cy++) {
          const chunk = await chunkOf(generate, cx, cy, cz);
          for (let z = 0; z < 32; z++)
            for (let x = 0; x < 32; x++)
              for (let y = 0; y < 32; y++) {
                const state = chunk.get(x, y, z) & 0xffff;
                if (state === cap) caps++;
                const vein = veinIds.get(state);
                if (!vein) continue;
                counts.set(vein[0], (counts.get(vein[0]) ?? 0) + 1);
                const depth = finds.surface(cx * 32 + x, cz * 32 + z) - (cy * 32 + y);
                assert.ok(depth >= vein[1] && depth <= vein[2], `${vein[0]} at depth ${depth}`);
              }
        }
      }
    assert.ok(caps >= 500 && caps <= 12_000, `seed ${seed}: ${caps} glow caps per 128 x 128`);
  }
  for (const [name] of VEINS) assert.ok(counts.get(name) > 50, `${name}: ${counts.get(name)} cells`);
  for (const name of COUNTED_BLOCKS) assert.doesNotThrow(() => id(name));
});

test('nothing under or on the square, the sign or the ring columns', async () => {
  for (const seed of [1, 2, 3, 4]) {
    const finds = plazaFinds(seed),
      read = reader(world(seed)),
      bare = reader(plain(seed)),
      floor = plazaFloor(seed, blocks.table),
      columns = [];
    for (let i = 0; i < PLAZA_RING_CANDIDATES; i++) columns.push(plazaRingColumn(i));
    for (const [x, z] of plazaSpawnRing(seed, blocks.table)) assert.ok(!isFindsClear(x, z), `ring ${x},${z}`);
    for (let z = -60; z <= 60; z += 3) for (let x = -60; x <= 60; x += 3) if (!isFindsClear(x, z)) columns.push([x, z]);
    for (const [x, z] of columns) {
      const square = onDisc(x, z) || onApron(x, z);
      for (let y = -64; y < floor + 40; y += 1) {
        const near = await read(x, y, z);
        // On the square the foundation and sign replace what was there; below them and elsewhere it is plain terrain.
        if (square && y >= floor - 32) continue;
        assert.equal(near, await bare(x, y, z), `seed ${seed}: ${x},${y},${z}`);
      }
    }
    for (const list of finds.gems.values()) for (const [x, , z] of list) assert.ok(isFindsClear(x, z));
  }
});
