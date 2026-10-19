import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, VoxelChunk, VoxelWorld, chunkKey } from '../dist/index.js';
import { MAX_LIGHT, VoxelLighting } from '../dist/light.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const types = () => {
  const blocks = new BlockTypes();
  const b = {
    stone: blocks.define('stone'),
    glass: blocks.define('glass', { layer: 'translucent' }),
    leaves: blocks.define('leaves', { layer: 'cutout', opacity: 1 }),
    water: blocks.define('water', { layer: 'translucent', liquid: true, opacity: 2 }),
    torch: blocks.define('torch', { shape: 'cross', layer: 'cutout', solid: false, light: 14 }),
    glowstone: blocks.define('glowstone', { light: 15 }),
    lamp: blocks.define('lamp', { layer: 'translucent', light: 9, opacity: 3 }),
  };
  return { blocks, b };
};
const settle = (lighting) => {
  const budget = lighting.budget;
  lighting.budget = Infinity;
  while (lighting.update() > 0);
  lighting.budget = budget;
};
// Loaded chunk keys, kept from the world's own chunk events.
const tracked = (world) => {
  const keys = new Set();
  world.onChunk((cx, cy, cz, chunk) => (chunk ? keys.add(chunkKey(cx, cy, cz)) : keys.delete(chunkKey(cx, cy, cz))));
  return keys;
};

// Full recompute from scratch, independent of the incremental code: heights are the highest loaded cell with opacity
// > 0, cells above them start at 15 sky, emitters at their light, and Dial's bucket fill (brightest first) spreads
// both channels at a cost of 1 + opacity per step through loaded cells only.
function oracle(world, keys, heights = undefined) {
  const chunks = [...keys].map((k) => k.split(',').map(Number)),
    lo = [0, 1, 2].map((a) => Math.min(...chunks.map((c) => c[a]))),
    n = [0, 1, 2].map((a) => (Math.max(...chunks.map((c) => c[a])) - lo[a] + 1) * 32),
    [nx, ny, nz] = n,
    size = nx * ny * nz,
    at = (x, y, z) => x + nx * (z + nz * y),
    loaded = new Uint8Array(size),
    opacity = new Uint8Array(size),
    sky = new Uint8Array(size),
    block = new Uint8Array(size),
    table = world.blocks.table,
    top = new Int32Array(nx * nz).fill(-32768);
  for (const [cx, cy, cz] of chunks) {
    const chunk = world.getChunk(cx, cy, cz);
    for (let y = 0; y < 32; y++)
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) {
          const gx = (cx - lo[0]) * 32 + x,
            gy = (cy - lo[1]) * 32 + y,
            gz = (cz - lo[2]) * 32 + z,
            i = at(gx, gy, gz),
            type = table[chunk.get(x, y, z) & 0xffff];
          loaded[i] = 1;
          opacity[i] = type.opacity;
          block[i] = type.light;
          if (type.opacity) top[gx + nx * gz] = Math.max(top[gx + nx * gz], cy * 32 + y);
        }
  }
  for (let gz = 0; gz < nz; gz++)
    for (let gx = 0; gx < nx; gx++) {
      if (heights) top[gx + nx * gz] = heights(gx + lo[0] * 32, gz + lo[2] * 32);
      for (let gy = 0; gy < ny; gy++)
        if (gy + lo[1] * 32 > top[gx + nx * gz] && loaded[at(gx, gy, gz)]) sky[at(gx, gy, gz)] = 15;
    }
  for (const levels of [sky, block]) {
    const buckets = Array.from({ length: 16 }, () => []);
    for (let i = 0; i < size; i++) if (levels[i]) buckets[levels[i]].push(i);
    for (let level = 15; level > 1; level--)
      for (const i of buckets[level]) {
        if (levels[i] !== level) continue;
        const x = i % nx,
          z = Math.floor(i / nx) % nz,
          y = Math.floor(i / (nx * nz));
        for (const [dx, dy, dz] of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]) {
          const a = x + dx,
            b = y + dy,
            c = z + dz;
          if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
          const j = at(a, b, c),
            v = level - 1 - opacity[j];
          if (loaded[j] && v > levels[j]) buckets[(levels[j] = v)].push(j);
        }
      }
  }
  return { lo, chunks, at, sky, block, top, nx };
}
// '' when every loaded cell's light byte, and every column height, matches the oracle; else the first difference.
function compare(world, keys, options = {}) {
  const o = oracle(world, keys, options.heights);
  for (const [cx, cy, cz] of o.chunks) {
    const chunk = world.getChunk(cx, cy, cz),
      heights = world.heightmap(cx, cz);
    for (let y = 0; y < 32; y++)
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) {
          const gx = (cx - o.lo[0]) * 32 + x,
            gz = (cz - o.lo[2]) * 32 + z,
            i = o.at(gx, (cy - o.lo[1]) * 32 + y, gz),
            want = (o.sky[i] << 4) | o.block[i],
            got = chunk.getLight(x, y, z);
          if (got !== want)
            return `cell (${cx * 32 + x}, ${cy * 32 + y}, ${cz * 32 + z}): sky/block ${got >> 4}/${got & 15}, want ${o.sky[i]}/${o.block[i]}`;
          if (!options.heights && y === 0 && heights[x | (z << 5)] !== o.top[gx + o.nx * gz])
            return `column (${cx * 32 + x}, ${cz * 32 + z}): height ${heights[x | (z << 5)]}, want ${o.top[gx + o.nx * gz]}`;
        }
  }
  return '';
}
// Terrain over chunks x, z in -1..1 and y in 0..1: stone up to a rolling surface at y 36..50, caves, a few trees,
// glass, water, torches, lamps and glowstone.
function terrain(next, b) {
  const surface = (x, z) => 43 + Math.round(5 * Math.sin(x / 9) + 2 * Math.cos(z / 7));
  const caves = Array.from({ length: 10 }, () => [next() * 96 - 32, 8 + next() * 30, next() * 96 - 32, 3 + next() * 5]);
  const extras = Array.from({ length: 60 }, () => [
    Math.floor(next() * 96) - 32,
    Math.floor(next() * 60),
    Math.floor(next() * 96) - 32,
    [b.glass, b.leaves, b.water, b.torch, b.glowstone, b.lamp][Math.floor(next() * 6)],
  ]);
  return (x, y, z) => {
    for (const e of extras) if (e[0] === x && e[1] === y && e[2] === z) return e[3];
    if (y > surface(x, z)) return (x * 7 + z * 13) % 97 === 0 && y < surface(x, z) + 6 ? b.leaves : 0;
    for (const [a, c, d, r] of caves) if ((x - a) ** 2 + (y - c) ** 2 + (z - d) ** 2 < r * r) return 0;
    return b.stone;
  };
}
const fillChunk = (fn, cx, cy, cz) => {
  const chunk = new VoxelChunk();
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const s = fn(cx * 32 + x, cy * 32 + y, cz * 32 + z);
        if (s) chunk.set(x, y, z, s);
      }
  return chunk;
};
const world3 = (seed) => {
  const { blocks, b } = types(),
    world = new VoxelWorld({ blocks }),
    keys = tracked(world),
    fn = terrain(random(seed), b),
    chunks = [];
  for (let cx = -1; cx <= 1; cx++)
    for (let cy = 0; cy <= 1; cy++)
      for (let cz = -1; cz <= 1; cz++) chunks.push([cx, cy, cz, fillChunk(fn, cx, cy, cz)]);
  return { world, keys, b, chunks };
};

test('incremental light after seeded random edits equals a full recompute', () => {
  for (const seed of [1, 2]) {
    const { world, keys, b, chunks } = world3(seed),
      lighting = VoxelLighting.attach(world, { budget: 300 }),
      next = random(seed * 101),
      palette = [0, 0, 0, b.stone, b.stone, b.glass, b.leaves, b.water, b.torch, b.glowstone, b.lamp];
    for (const [cx, cy, cz, chunk] of chunks) world.addChunk(cx, cy, cz, chunk);
    settle(lighting);
    assert.equal(compare(world, keys), '', `seed ${seed}: after load`);
    for (let round = 0; round < 3; round++) {
      for (let n = 0; n < 400; n++) {
        const x = Math.floor(next() * 96) - 32,
          y = Math.floor(next() * 72), // y 64..71: setBlock adds chunks above
          z = Math.floor(next() * 96) - 32,
          state = palette[Math.floor(next() * palette.length)];
        if (n % 25 === 0) {
          // A slab, wall or roof: up to 12 x 4 x 12 cells of one state.
          const edits = [],
            [w, h, d] = [1 + next() * 12, 1 + next() * 4, 1 + next() * 12].map(Math.floor);
          for (let i = 0; i < w; i++)
            for (let j = 0; j < h; j++)
              for (let k = 0; k < d; k++)
                if (x + i < 64 && y + j < 72 && z + k < 64) edits.push(x + i, y + j, z + k, state);
          world.setBlocks(edits);
        } else world.setBlock(x, y, z, state);
        // Light partly caught up between edits: interleaved, budget-limited updates.
        if (next() < 0.3) lighting.update();
      }
      settle(lighting);
      assert.equal(compare(world, keys), '', `seed ${seed}, round ${round}`);
    }
    lighting.dispose();
  }
});

test('a torch lights 14 minus the steps to it, across a border, and its removal clears it', () => {
  const { blocks, b } = types(),
    world = new VoxelWorld({ blocks }),
    lighting = VoxelLighting.attach(world);
  // A stone lid over air chunks (0, 0, 0) and (1, 0, 0): no sky light reaches them.
  world.addChunk(0, 1, 0, new VoxelChunk(b.stone));
  world.addChunk(1, 1, 0, new VoxelChunk(b.stone));
  world.addChunk(0, 0, 0);
  world.addChunk(1, 0, 0);
  settle(lighting);
  assert.equal(lighting.skyLight(5, 5, 5), 0);
  world.dirty.clear();
  world.setBlock(28, 10, 12, b.torch);
  world.dirty.clear();
  settle(lighting);
  assert.deepEqual([...world.dirty].sort(), ['0,0,0', '1,0,0']);
  for (const [x, y, z] of [
    [28, 10, 12],
    [27, 10, 12],
    [31, 10, 12],
    [32, 10, 12],
    [35, 12, 10],
    [28, 0, 12],
    [20, 10, 12],
    [14, 10, 12],
  ])
    assert.equal(
      lighting.blockLight(x, y, z),
      Math.max(0, 14 - Math.abs(x - 28) - Math.abs(y - 10) - Math.abs(z - 12)),
    );
  assert.equal(lighting.blockLight(28, 32, 12), 0, 'the stone lid stays dark');
  const lantern = blocks.define('lantern', { light: 10 }); // defined after attach
  world.setBlock(28, 20, 12, lantern);
  settle(lighting);
  assert.equal(lighting.blockLight(28, 20, 12), 10);
  assert.equal(lighting.blockLight(28, 19, 12), 9, 'the brighter of the lantern (9) and the torch (5)');
  world.setBlock(28, 20, 12, 0);
  world.setBlock(28, 10, 12, 0);
  settle(lighting);
  for (let x = 0; x < 64; x++) for (let y = 0; y < 32; y++) assert.equal(lighting.blockLight(x, y, 12), 0);
});

test('overhangs and caves: light bends under the overhang, a cave opens and closes', () => {
  const { blocks, b } = types(),
    world = new VoxelWorld({ blocks }),
    keys = tracked(world),
    lighting = VoxelLighting.attach(world);
  const fill = (x0, x1, y0, y1, z0, z1, state) => {
    const edits = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) edits.push(x, y, z, state);
    world.setBlocks(edits);
  };
  fill(0, 31, 0, 10, 0, 31, b.stone); // ground, top at y 10
  fill(0, 15, 20, 20, 0, 31, b.stone); // overhang over x 0..15 at y 20
  fill(4, 8, 2, 5, 4, 8, 0); // a sealed cave in the ground
  settle(lighting);
  assert.equal(lighting.skyLight(16, 15, 9), MAX_LIGHT);
  assert.equal(lighting.skyLight(15, 15, 9), 14);
  assert.equal(lighting.skyLight(10, 11, 9), 9);
  assert.equal(lighting.skyLight(0, 19, 9), 0);
  assert.equal(lighting.skyLight(6, 3, 6), 0, 'the cave is sealed');
  assert.equal(world.heightmap(0, 0)[6 | (6 << 5)], 20);
  fill(6, 6, 6, 10, 6, 6, 0); // a shaft down into the cave, under the overhang
  fill(6, 6, 20, 20, 6, 6, 0); // and a hole in the overhang above it
  settle(lighting);
  assert.equal(lighting.skyLight(6, 2, 6), MAX_LIGHT, 'open sky down the shaft to the cave floor');
  assert.equal(lighting.skyLight(4, 2, 6), 13);
  assert.equal(world.heightmap(0, 0)[6 | (6 << 5)], 1);
  assert.equal(compare(world, keys), '');
  world.setBlock(6, 20, 6, b.stone);
  settle(lighting);
  assert.equal(compare(world, keys), '');
  world.setBlock(6, 10, 6, b.stone);
  settle(lighting);
  assert.equal(lighting.skyLight(6, 3, 6), 0, 'closed again');
  assert.equal(compare(world, keys), '');
});

test('glass passes full sky light; leaves and water dim it by their opacity', () => {
  const { blocks, b } = types(),
    world = new VoxelWorld({ blocks }),
    lighting = VoxelLighting.attach(world),
    layer = (y, state) => {
      const edits = [];
      for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) edits.push(x, y, z, state);
      world.setBlocks(edits);
    };
  layer(0, b.stone);
  layer(20, b.glass);
  settle(lighting);
  assert.equal(lighting.skyLight(5, 10, 5), MAX_LIGHT);
  assert.equal(lighting.skyLight(5, 20, 5), MAX_LIGHT);
  assert.equal(world.heightmap(0, 0)[5 | (5 << 5)], 0, 'glass does not block the heightmap');
  layer(20, b.leaves); // opacity 1 over the whole (only) chunk column: no light from the sides
  settle(lighting);
  assert.equal(world.heightmap(0, 0)[5 | (5 << 5)], 20);
  assert.equal(lighting.skyLight(5, 21, 5), 15);
  assert.equal(lighting.skyLight(5, 20, 5), 13);
  assert.equal(lighting.skyLight(5, 19, 5), 12);
  assert.equal(lighting.skyLight(5, 10, 5), 3);
  // An opaque emitter goes: its cell takes block light down and sky light in at once.
  world.setBlock(5, 10, 5, b.glowstone);
  settle(lighting);
  assert.deepEqual(
    [lighting.skyLight(5, 10, 5), lighting.blockLight(5, 10, 5), lighting.blockLight(5, 12, 5)],
    [0, 15, 13],
  );
  world.setBlock(5, 10, 5, 0);
  settle(lighting);
  assert.deepEqual(
    [lighting.skyLight(5, 10, 5), lighting.blockLight(5, 10, 5), lighting.blockLight(5, 12, 5)],
    [3, 0, 0],
  );
  layer(19, b.water); // opacity 2 under the leaves
  settle(lighting);
  assert.equal(lighting.skyLight(5, 19, 5), 10);
  assert.equal(lighting.skyLight(5, 18, 5), 9);
  layer(20, b.glass);
  layer(19, 0);
  settle(lighting);
  assert.equal(lighting.skyLight(5, 1, 5), MAX_LIGHT);
});

test('chunks loaded after their neighbours pull light in and push it out; removal takes it away', () => {
  for (const seed of [3, 4]) {
    const { world, keys, chunks } = world3(seed),
      next = random(seed),
      lighting = VoxelLighting.attach(world, { budget: 2000 });
    // Random load order, light only partly caught up between loads.
    for (const i of chunks.map((_, i) => i).sort(() => next() - 0.5)) {
      const [cx, cy, cz, chunk] = chunks[i];
      world.addChunk(cx, cy, cz, chunk);
      if (next() < 0.5) lighting.update();
      if (next() < 0.2) {
        settle(lighting);
        assert.equal(compare(world, keys), '', `seed ${seed}: loaded ${keys.size}`);
      }
    }
    settle(lighting);
    assert.equal(compare(world, keys), '', `seed ${seed}: all loaded`);
    // Unload chunks (a removed chunk's cells keep their heights) and load them back.
    for (const [cx, cy, cz] of chunks.filter(() => next() < 0.4)) {
      world.removeChunk(cx, cy, cz);
      if (next() < 0.5) lighting.update();
    }
    settle(lighting);
    const remembered = (x, z) => world.heightmap(x >> 5, z >> 5)?.[(x & 31) | ((z & 31) << 5)] ?? -32768;
    assert.equal(compare(world, keys, { heights: remembered }), '', `seed ${seed}: after removals`);
    for (const [cx, cy, cz, chunk] of chunks) if (!world.getChunk(cx, cy, cz)) world.addChunk(cx, cy, cz, chunk);
    settle(lighting);
    assert.equal(compare(world, keys), '', `seed ${seed}: reloaded`);
    lighting.dispose();
  }
});

test('a removed chunk keeps its heights, so the cave under it stays dark; its torch light goes', () => {
  const { blocks, b } = types(),
    world = new VoxelWorld({ blocks }),
    keys = tracked(world);
  world.addChunk(0, 1, 0, new VoxelChunk(b.stone));
  world.addChunk(0, 0, 0);
  world.addChunk(1, 0, 0);
  world.setBlock(30, 10, 10, b.torch);
  // Attached after loading: the world reports the chunks already there.
  const lighting = VoxelLighting.attach(world);
  settle(lighting);
  assert.equal(lighting.blockLight(33, 10, 10), 11);
  world.removeChunk(0, 1, 0);
  world.removeChunk(0, 0, 0);
  settle(lighting);
  assert.equal(world.heightmap(1, 0)[0], -32768);
  assert.equal(lighting.blockLight(33, 10, 10), 0, 'the torch went with its chunk');
  assert.equal(compare(world, keys), '');
  world.addChunk(0, 1, 0, new VoxelChunk(b.stone));
  world.addChunk(0, 0, 0);
  settle(lighting);
  world.removeChunk(0, 1, 0);
  settle(lighting);
  assert.equal(world.heightmap(0, 0)[5], 63, 'the removed lid still shades the column');
  assert.equal(lighting.skyLight(5, 10, 0), 0);
  assert.equal(lighting.skyLight(5, 40, 0), 0, 'unloaded cells under a remembered height read dark');
  assert.equal(lighting.skyLight(5, 64, 0), MAX_LIGHT);
  assert.equal(
    compare(world, keys, { heights: (x, z) => world.heightmap(x >> 5, z >> 5)[(x & 31) | ((z & 31) << 5)] }),
    '',
  );
  // Loaded again as air, the chunk decides its own range: the column opens down to the floor below.
  world.setBlock(5, 3, 0, b.stone);
  world.addChunk(0, 1, 0);
  settle(lighting);
  assert.equal(world.heightmap(0, 0)[5], 3);
  assert.equal(world.heightmap(0, 0)[6], -32768);
  assert.equal(lighting.skyLight(5, 4, 0), MAX_LIGHT);
  assert.equal(lighting.skyLight(5, 2, 0), 14);
  assert.equal(compare(world, keys), '');
});

test('budgeted updates converge to the same light as unbounded ones', () => {
  const run = (budget) => {
    const { world, keys, b, chunks } = world3(5),
      lighting = VoxelLighting.attach(world, { budget }),
      next = random(77);
    for (const [cx, cy, cz, chunk] of chunks) world.addChunk(cx, cy, cz, chunk);
    let calls = 0;
    for (let n = 0; n < 300; n++) {
      const x = Math.floor(next() * 96) - 32,
        y = 30 + Math.floor(next() * 30),
        z = Math.floor(next() * 96) - 32;
      world.setBlock(x, y, z, [0, b.stone, b.torch, b.leaves][Math.floor(next() * 4)]);
      if (n % 10 === 0) {
        lighting.update();
        calls++;
      }
    }
    while (lighting.update() > 0) calls++;
    const bytes = ({ light }) => (typeof light === 'number' ? new Uint8Array(32768).fill(light) : light);
    return { world, keys, calls, light: chunks.map(([cx, cy, cz]) => bytes(world.getChunk(cx, cy, cz).pack())) };
  };
  const small = run(64),
    big = run(Infinity);
  assert.ok(small.calls > 100, `${small.calls} small-budget calls`);
  assert.deepEqual(small.light, big.light);
  assert.equal(compare(small.world, small.keys), '');
});

test('a chunk under open sky keeps one light byte', () => {
  const { blocks, b } = types(),
    world = new VoxelWorld({ blocks }),
    lighting = VoxelLighting.attach(world);
  for (let cx = -1; cx <= 1; cx++)
    for (let cz = -1; cz <= 1; cz++) {
      world.addChunk(cx, 0, cz, new VoxelChunk(b.stone));
      world.addChunk(cx, 1, cz);
      world.addChunk(cx, 2, cz);
    }
  settle(lighting);
  assert.equal(world.getChunk(0, 1, 0).pack().light, 0xf0);
  assert.equal(world.getChunk(0, 2, 0).pack().light, 0xf0);
  assert.equal(world.getChunk(0, 0, 0).pack().light, 0, 'solid stone is dark');
  world.setBlock(40, 50, 40, b.torch);
  settle(lighting);
  assert.ok(world.getChunk(1, 1, 1).pack().light instanceof Uint8Array, 'a torch makes cells differ');
  assert.equal(world.getChunk(0, 2, 0).pack().light, 0xf0);
});

test('options, attach and dispose errors', () => {
  const { blocks } = types(),
    world = new VoxelWorld({ blocks });
  assert.throws(() => VoxelLighting.attach({}), TypeError);
  assert.throws(() => VoxelLighting.attach(world, { budget: '9' }), TypeError);
  assert.throws(() => VoxelLighting.attach(world, { budget: 0 }), RangeError);
  assert.throws(() => VoxelLighting.attach(world, { budget: 2.5 }), RangeError);
  const lighting = VoxelLighting.attach(world);
  assert.equal(lighting.budget, 4096);
  assert.throws(() => VoxelLighting.attach(world), { name: 'MargoError', code: 'attached' });
  assert.throws(() => {
    lighting.budget = -1;
  }, RangeError);
  assert.throws(() => lighting.skyLight(0.5, 0, 0), RangeError);
  assert.throws(() => lighting.blockLight('0', 0, 0), TypeError);
  assert.equal(lighting.skyLight(0, 0, 0), MAX_LIGHT, 'nothing loaded: open sky');
  assert.equal(lighting.update(), 0);
  lighting.dispose();
  assert.throws(() => lighting.update(), { name: 'MargoError', code: 'disposed' });
  VoxelLighting.attach(world).dispose();
});

test('world.onChunk replays loaded chunks, then reports adds before their edit and removals; fillLight', () => {
  const { blocks, b } = types(),
    world = new VoxelWorld({ blocks }),
    events = [],
    first = world.addChunk(1, 2, 3);
  const off = world.onChunk((cx, cy, cz, chunk) => events.push([cx, cy, cz, chunk === undefined ? 'removed' : chunk]));
  world.onChange((x, y, z) => events.push(['edit', x, y, z]));
  world.setBlock(-1, 0, 0, b.stone);
  world.removeChunk(1, 2, 3);
  off();
  world.addChunk(5, 0, 0);
  assert.deepEqual(events, [
    [1, 2, 3, first],
    [-1, 0, 0, world.getChunk(-1, 0, 0)],
    ['edit', -1, 0, 0],
    [1, 2, 3, 'removed'],
  ]);
  assert.throws(() => world.onChunk(1), TypeError);
  const chunk = new VoxelChunk();
  chunk.setLight(1, 2, 3, 9);
  chunk.fillLight(0xf0);
  assert.equal(chunk.pack().light, 0xf0);
  assert.equal(chunk.getLight(1, 2, 3), 0xf0);
  assert.throws(() => chunk.fillLight(256), RangeError);
  assert.throws(() => chunk.fillLight('1'), TypeError);
});
