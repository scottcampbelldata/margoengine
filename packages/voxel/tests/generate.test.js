// The built-in generator: deterministic per seed, the same chunks in any generation order, trees whole across chunk
// borders (checked against their shape in an assembled region), terrain layers, block types by name, option errors,
// and the built terrain worker (a classic script without eval) giving noiseTerrain's chunks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BlockTypes, VoxelChunk, VoxelWorld } from '../dist/index.js';
import { noiseTerrain, serveVoxelGenerator } from '../dist/generate.js';

const NAMES = ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves'];
function terrainBlocks(order = NAMES, prefix = '') {
  const blocks = new BlockTypes();
  blocks.define('glass');
  for (const name of order) blocks.define(prefix + name);
  return blocks;
}
const blocks = terrainBlocks(),
  id = Object.fromEntries(NAMES.map((name) => [name, blocks.id(name)]));
const generate = (fn, cx, cy, cz, table = blocks.table) => {
  const chunk = new VoxelChunk();
  fn(chunk, cx, cy, cz, { blocks: table });
  return chunk;
};
const cells = (chunk) => {
  const out = new Uint32Array(32768);
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) out[x | (z << 5) | (y << 10)] = chunk.get(x, y, z);
  return out;
};
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// A 4 x 3 x 4 region of chunks around the ground.
const region = [];
for (let cy = -1; cy <= 1; cy++)
  for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) region.push([cx, cy, cz]);

test('noiseTerrain: same seed and options give the same chunks in any order and from any instance', () => {
  // Also a coast full of caves, where the rock kept beside the sea and the trees kept off slopes depend on neighbours.
  for (const options of [
    { seed: 42, trees: 0.05 },
    { seed: 2, caves: 1, trees: 0.05, seaLevel: 12 },
  ])
    sameInAnyOrder(options);
});
function sameInAnyOrder(options) {
  const a = noiseTerrain(options),
    first = new Map(region.map(([cx, cy, cz]) => [`${cx},${cy},${cz}`, cells(generate(a, cx, cy, cz))])),
    next = random(9),
    shuffled = region.slice().sort(() => next() - 0.5),
    b = noiseTerrain({ ...options });
  for (const [cx, cy, cz] of [...shuffled, ...shuffled.reverse()]) {
    const key = `${cx},${cy},${cz}`;
    assert.deepEqual(cells(generate(a, cx, cy, cz)), first.get(key), `${key} again from the same generator`);
    assert.deepEqual(cells(generate(b, cx, cy, cz)), first.get(key), `${key} from a new generator`);
  }
  const other = noiseTerrain({ ...options, seed: 43 });
  assert.ok(
    region.some(([cx, cy, cz]) =>
      cells(generate(other, cx, cy, cz)).some((s, i) => s !== first.get(`${cx},${cy},${cz}`)[i]),
    ),
    'another seed gives another world',
  );
}

test('noiseTerrain trees are whole across chunk borders: every trunk has its full crown, every leaf a trunk', () => {
  const fn = noiseTerrain({ seed: 7, trees: 0.06 }),
    world = new VoxelWorld({ blocks });
  for (const [cx, cy, cz] of region) world.addChunk(cx, cy, cz, generate(fn, cx, cy, cz));
  const at = (x, y, z) => world.getBlock(x, y, z),
    trunks = [];
  for (let z = 2; z < 126; z++)
    for (let x = 2; x < 126; x++)
      for (let y = -30; y < 90; y++)
        if (at(x, y, z) === id.log && at(x, y - 1, z) === id.grass) {
          let top = y;
          while (at(x, top + 1, z) === id.log) top++;
          trunks.push([x, y, z, top]);
        }
  // Crown cells of a trunk topped at (x, top, z): two 5 x 5 layers without corners, then two plus-shaped layers.
  const crown = (x, top, z) => {
    const out = [];
    for (let dy = -2; dy <= 1; dy++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++)
          if (Math.abs(dx) + Math.abs(dz) < (dy < 0 ? 4 : 2)) out.push([x + dx, top + dy, z + dz]);
    return out;
  };
  let crossing = 0;
  const leafy = new Set();
  for (const [x, y, z, top] of trunks) {
    assert.ok(top - y + 1 >= 4 && top - y + 1 <= 6, `trunk at ${x},${z} is 4-6 logs`);
    const cellsOf = crown(x, top, z);
    if (cellsOf.some(([cx, , cz]) => cx >> 5 !== x >> 5 || cz >> 5 !== z >> 5)) crossing++;
    for (const [cx, cy, cz] of cellsOf) {
      leafy.add(`${cx},${cy},${cz}`);
      assert.notEqual(at(cx, cy, cz), 0, `crown cell ${cx},${cy},${cz} of the tree at ${x},${z} is not air`);
    }
  }
  assert.ok(trunks.length > 100, `${trunks.length} trees`);
  assert.ok(crossing > 20, `${crossing} crowns cross a chunk border`);
  for (let z = 4; z < 124; z++)
    for (let x = 4; x < 124; x++)
      for (let y = -30; y < 90; y++)
        if (at(x, y, z) === id.leaves) assert.ok(leafy.has(`${x},${y},${z}`), `leaf ${x},${y},${z} belongs to a tree`);
});

test('noiseTerrain layers: grass or sand on dirt on stone, water to sea level, caves under the top block only', () => {
  const fn = noiseTerrain({ seed: 3, seaLevel: 2, caves: 0.5, trees: 0 }),
    world = new VoxelWorld({ blocks });
  for (const [cx, cy, cz] of region) world.addChunk(cx, cy, cz, generate(fn, cx, cy, cz));
  world.addChunk(0, -2, 0, generate(fn, 0, -2, 0));
  let water = 0,
    sand = 0,
    carved = 0;
  for (let z = 0; z < 128; z++)
    for (let x = 0; x < 128; x++) {
      let h = 63;
      while (h > -32 && ![id.grass, id.sand].includes(world.getBlock(x, h, z))) h--;
      assert.ok(h > -32, `column ${x},${z} has a top block`);
      const top = world.getBlock(x, h, z);
      assert.equal(top, h <= 3 ? id.sand : id.grass, `top of ${x},${z} at ${h}`);
      if (top === id.sand) sand++;
      for (let y = h + 1; y <= 2; y++)
        assert.equal(world.getBlock(x, y, z), id.water, `sea at ${x},${y},${z}`), water++;
      for (let y = Math.max(h + 1, 3); y < 64; y++)
        assert.equal(world.getBlock(x, y, z), 0, `air above ${x},${y},${z}`);
      for (let y = h - 1; y >= -32; y--) {
        const s = world.getBlock(x, y, z);
        if (s === 0) carved++;
        else assert.equal(s, y >= h - 3 ? id.dirt : id.stone, `layer at ${x},${y},${z}`);
      }
    }
  assert.ok(water > 1000 && sand > 100 && carved > 1000, `${water} water, ${sand} sand, ${carved} carved cells`);
  const stone = generate(fn, 0, -2, 0);
  assert.equal(cells(stone).filter((s) => s === id.stone).length + cells(stone).filter((s) => !s).length, 32768);
  const solid = generate(noiseTerrain({ seed: 3, caves: 0 }), 0, -9, 0);
  assert.equal(solid.pack().bits, 0, 'deep rock without caves is one uniform chunk');
  assert.equal(solid.get(0, 0, 0), id.stone);
});

// The chunks of an nx x ny x nz region from chunk c0, each generated on its own, in one array (cell x + X (z + Z y)),
// with each column's ground: the highest stone, dirt, grass or sand cell (caves never carve the top block).
function assemble(fn, [cx0, cy0, cz0], [nx, ny, nz]) {
  const X = 32 * nx,
    Y = 32 * ny,
    Z = 32 * nz,
    data = new Uint8Array(X * Y * Z);
  for (let cy = 0; cy < ny; cy++)
    for (let cz = 0; cz < nz; cz++)
      for (let cx = 0; cx < nx; cx++) {
        const chunk = generate(fn, cx0 + cx, cy0 + cy, cz0 + cz);
        for (let y = 0; y < 32; y++)
          for (let z = 0; z < 32; z++)
            for (let x = 0; x < 32; x++) data[32 * cx + x + X * (32 * cz + z + Z * (32 * cy + y))] = chunk.get(x, y, z);
      }
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < X && y < Y && z < Z,
    at = (x, y, z) => (inside(x, y, z) ? data[x + X * (z + Z * y)] : -1),
    ground = new Int32Array(X * Z).fill(-1),
    terrain = [id.stone, id.dirt, id.grass, id.sand];
  for (let z = 0; z < Z; z++)
    for (let x = 0; x < X; x++)
      for (let y = Y - 1; y >= 0; y--)
        if (terrain.includes(at(x, y, z))) {
          ground[x + X * z] = y;
          break;
        }
  return { X, Y, Z, at, ground: (x, z) => ground[x + X * z] };
}

test('noiseTerrain: no water beside cave air, no leaves in the ground, whole crowns in open air (scanned across chunk borders)', () => {
  const near = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  // Seeds and sea levels where the generator before this rule put water beside caves and leaves in caves.
  for (const options of [
    { seed: 1, caves: 1, trees: 0.05 },
    { seed: 2, caves: 1, trees: 0.05, seaLevel: 12 },
    { seed: 4, caves: 0.6, trees: 0.08, seaLevel: 6 },
  ]) {
    const { X, Y, Z, at, ground } = assemble(noiseTerrain(options), [-3, -2, -3], [6, 4, 6]),
      // Air below its column's ground is cave air; air above it is sky.
      cave = (x, y, z) => at(x, y, z) === 0 && y < ground(x, z);
    let water = 0,
      caves = 0,
      wet = 0,
      buried = 0,
      trees = 0,
      cut = 0;
    for (let y = 0; y < Y; y++)
      for (let z = 0; z < Z; z++)
        for (let x = 0; x < X; x++) {
          const s = at(x, y, z);
          if (cave(x, y, z)) caves++;
          if (s === id.water) {
            water++;
            if (near.some(([dx, dy, dz]) => cave(x + dx, y + dy, z + dz))) wet++;
          } else if ((s === id.leaves || s === id.log) && y <= ground(x, z)) buried++;
          // A trunk's foot: its crown (two 5 x 5 layers without corners, two plus layers) is all leaves and logs.
          if (s === id.log && at(x, y - 1, z) === id.grass && y - 1 === ground(x, z)) {
            let top = y;
            while (at(x, top + 1, z) === id.log) top++;
            for (let dy = -2; dy <= 1; dy++)
              for (let dz = -2; dz <= 2; dz++)
                for (let dx = -2; dx <= 2; dx++) {
                  const c = at(x + dx, top + dy, z + dz);
                  if (c >= 0 && Math.abs(dx) + Math.abs(dz) < (dy < 0 ? 4 : 2) && c !== id.leaves && c !== id.log)
                    cut++;
                }
            trees++;
          }
        }
    const what = `${JSON.stringify(options)}: ${water} water, ${caves} cave cells, ${trees} trees`;
    assert.equal(wet, 0, `${what}: water cells beside cave air`);
    assert.equal(buried, 0, `${what}: leaves or logs at or below their column's ground`);
    assert.equal(cut, 0, `${what}: crown cells that are not leaves or logs`);
    assert.ok(water > 20000 && caves > 100000 && trees > 100, what);
  }
});

test('noiseTerrain finds block types by name in any BlockTypes; errors name the problem', () => {
  const shifted = terrainBlocks([...NAMES].reverse(), 'my:'),
    names = Object.fromEntries(NAMES.map((name) => [name, `my:${name}`])),
    a = cells(generate(noiseTerrain({ seed: 5, trees: 0.05 }), 1, 0, 1)),
    b = cells(generate(noiseTerrain({ seed: 5, trees: 0.05, blocks: names }), 1, 0, 1, shifted.table)),
    map = new Map(NAMES.map((name) => [id[name], shifted.id(`my:${name}`)]));
  map.set(0, 0);
  assert.deepEqual(
    b,
    a.map((s) => map.get(s)),
  );
  assert.throws(() => generate(noiseTerrain({ trees: 0.1 }), 0, 0, 0, terrainBlocks(NAMES.slice(0, 5)).table), {
    name: 'RangeError',
    message: /block "log" is not defined/,
  });
  generate(noiseTerrain({ trees: 0 }), 0, 0, 0, terrainBlocks(NAMES.slice(0, 5)).table); // no trees: no log needed
  assert.throws(() => noiseTerrain({ seed: 1.5 }), RangeError);
  assert.throws(() => noiseTerrain({ seed: 2 ** 31 }), RangeError);
  assert.throws(() => noiseTerrain({ caves: 2 }), RangeError);
  assert.throws(() => noiseTerrain({ scale: 0 }), RangeError);
  assert.throws(() => noiseTerrain({ amplitude: -1 }), RangeError);
  assert.throws(() => noiseTerrain({ height: Number.NaN }), RangeError);
  assert.throws(() => noiseTerrain({ trees: '0.1' }), TypeError);
  assert.throws(() => noiseTerrain({ blocks: { stone: 5 } }), TypeError);
  assert.throws(() => noiseTerrain(null), TypeError);
  assert.throws(() => noiseTerrain()(new VoxelChunk(), 0, 0, 0, {}), TypeError);
  assert.throws(() => serveVoxelGenerator('generate'), TypeError);
});

test('the built terrain worker is a classic script without eval and serves noiseTerrain chunks with eval disabled', async () => {
  const code = readFileSync(new URL('../dist/workers/terrain.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\beval\s*\(|new Function|\bFunction\s*\(/);
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, 'a classic script');
  assert.doesNotMatch(code, /import\.meta|document|new Worker/, 'the streamer is not bundled into the worker');
  const posted = [],
    scope = { postMessage: (data, transfer) => posted.push({ data, transfer }) };
  scope.self = scope;
  vm.runInContext(code, vm.createContext(scope, { codeGeneration: { strings: false, wasm: false } }));
  const terrain = { seed: 11, trees: 0.05 },
    clone = (value) => structuredClone(value);
  for (const [i, [cx, cy, cz]] of [
    [0, 0, 0],
    [3, -1, 2],
    [1, 1, 1],
  ].entries()) {
    await scope.onmessage({ data: clone({ cx, cy, cz, blocks: blocks.table, terrain }) });
    const { data, transfer } = posted[i];
    assert.equal(data.error, undefined, data.error?.message);
    // structuredClone brings the worker realm's typed arrays into this one, as a real message would.
    const chunk = VoxelChunk.unpack(structuredClone(data.result));
    assert.deepEqual(cells(chunk), cells(generate(noiseTerrain(terrain), cx, cy, cz)));
    assert.ok(transfer.includes(data.result.palette.buffer), 'the packed arrays move back');
  }
  await scope.onmessage({ data: clone({ cx: 0, cy: 0, cz: 0, blocks: [], terrain }) });
  assert.equal(posted.at(-1).data.error.name, 'RangeError', 'a world without the block types gets an error reply');
});
