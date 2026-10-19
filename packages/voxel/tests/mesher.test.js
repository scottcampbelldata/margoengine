import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, VoxelChunk, VoxelWorld, blockState, chunkKey } from '../dist/index.js';
import { QUAD_WORDS, blockMaterials, decodeQuad, meshChunk, meshInput } from '../dist/mesher.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// One type of every layer and shape. Glass and tinted glass share a texture layer but are different blocks.
const blocks = new BlockTypes();
const STONE = blocks.define('stone', { textures: 1 }),
  GRASS = blocks.define('grass', { textures: [3, 3, 2, 4, 3, 3] }),
  LEAVES = blocks.define('leaves', { layer: 'cutout', textures: 5 }),
  GLASS = blocks.define('glass', { layer: 'translucent', textures: 6 }),
  TINTED = blocks.define('tinted', { layer: 'translucent', textures: 6, color: '#ff8080' }),
  WATER = blocks.define('water', { layer: 'translucent', shape: 'liquid', liquid: true, solid: false, textures: 7 }),
  LAVA = blocks.define('lava', { shape: 'liquid', liquid: true, textures: 8 }),
  FLOWER = blocks.define('flower', { layer: 'cutout', shape: 'cross', solid: false, textures: 9 }),
  BARRIER = blocks.define('barrier', { layer: 'invisible' });
const table = blocks.table,
  materials = blockMaterials(table),
  LAYER_NAMES = ['opaque', 'cutout', 'translucent'];

// The chunk and its shell as one dense 34^3 grid, local coordinates -1..32.
const idx = (x, y, z) => x + 1 + 34 * (z + 1) + 1156 * (y + 1);
const grid = () => ({ state: new Uint32Array(39304), light: new Uint8Array(39304) });
const inside = (x, y, z) => x >= 0 && x < 32 && y >= 0 && y < 32 && z >= 0 && z < 32;
function input(g, packed = false) {
  const chunk = new VoxelChunk(),
    shell = [],
    light = [];
  for (let y = -1; y <= 32; y++)
    for (let z = -1; z <= 32; z++)
      for (let x = -1; x <= 32; x++) {
        const i = idx(x, y, z);
        if (inside(x, y, z)) {
          chunk.set(x, y, z, g.state[i]);
          chunk.setLight(x, y, z, g.light[i]);
        } else {
          shell.push(g.state[i]);
          light.push(g.light[i]);
        }
      }
  return {
    chunk: packed ? chunk.pack() : chunk,
    shell: Uint32Array.from(shell),
    light: Uint8Array.from(light),
    blocks: table,
  };
}
const mesh = (cells, light = 0) => {
  const g = grid();
  g.light.fill(light);
  for (const [x, y, z, s] of cells) g.state[idx(x, y, z)] = s;
  return meshChunk(input(g));
};

// The quad layout written out from the design, independently of the mesher.
const UAXIS = [
    [0, 0, 1],
    [0, 0, 1],
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
  ],
  VAXIS = [
    [0, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 0, 1],
    [0, 1, 0],
    [0, 1, 0],
  ],
  NORMALS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
const word0 = (x, y, z, face, w, h, flip, drop) =>
  (x | (y << 5) | (z << 10) | (face << 15) | ((w - 1) << 18) | ((h - 1) << 23) | (flip << 28) | (drop << 29)) >>> 0;
const word1 = (material, ao, wave) =>
  (material | (ao[0] << 12) | (ao[1] << 14) | (ao[2] << 16) | (ao[3] << 18) | (wave << 20)) >>> 0;
const word2 = (sky, block) => sky.reduce((w, s, c) => w | ((s | (block[c] << 4)) << (8 * c)), 0) >>> 0;

// Every quad of a layer cut back to unit faces: the merged mesh must equal one quad per face.
function unitFaces(words) {
  const out = [];
  for (let i = 0; i < words.length / QUAD_WORDS; i++) {
    const q = decodeQuad(words, i);
    if (q.face > 5) {
      assert.equal(q.w * q.h, 1);
      out.push(`${words[3 * i]},${words[3 * i + 1]},${words[3 * i + 2]}`);
      continue;
    }
    const [u, v] = [UAXIS[q.face], VAXIS[q.face]];
    for (let j = 0; j < q.h; j++)
      for (let k = 0; k < q.w; k++) {
        const w0 = word0(
          q.x + k * u[0] + j * v[0],
          q.y + k * u[1] + j * v[1],
          q.z + k * u[2] + j * v[2],
          q.face,
          1,
          1,
          +q.flip,
          q.liquidDrop,
        );
        out.push(`${w0},${words[3 * i + 1]},${words[3 * i + 2]}`);
      }
  }
  return out.sort();
}
const facesOf = (m) =>
  LAYER_NAMES.flatMap((layer) =>
    unitFaces(m[layer]).map((key) => {
      const [w0, w1, w2] = key.split(',').map(Number);
      return { layer, ...decodeQuad(Uint32Array.of(w0, w1, w2), 0) };
    }),
  );
const quads = (words) => Array.from({ length: words.length / QUAD_WORDS }, (_, i) => decodeQuad(words, i));
const has = (m, x, y, z, face) => facesOf(m).some((f) => f.x === x && f.y === y && f.z === z && f.face === face);

// Oracle: one quad per visible block face, the culling, AO, smooth-light and liquid rules written per cell.
function naive(g) {
  const out = { opaque: [], cutout: [], translucent: [] },
    type = (x, y, z) => table[g.state[idx(x, y, z)] & 0xffff],
    solid = (x, y, z) => (type(x, y, z).layer === 'opaque' && type(x, y, z).shape === 'cube' ? 1 : 0),
    id = (x, y, z) => g.state[idx(x, y, z)] & 0xffff,
    surfaceDrop = (x, y, z) => (id(x, y + 1, z) !== id(x, y, z) ? (g.state[idx(x, y, z)] >>> 16) & 7 : 0);
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const t = type(x, y, z),
          light = g.light[idx(x, y, z)];
        if (t.layer === 'invisible') continue;
        if (t.shape === 'cross') {
          const own = word2(
            [light >> 4, light >> 4, light >> 4, light >> 4],
            [light & 15, light & 15, light & 15, light & 15],
          );
          for (const face of [6, 7])
            out[t.layer].push(
              `${word0(x, y, z, face, 1, 1, 0, 0)},${word1(materials[t.id * 6], [3, 3, 3, 3], 0)},${own}`,
            );
          continue;
        }
        for (let face = 0; face < 6; face++) {
          const [fx, fy, fz] = [x + NORMALS[face][0], y + NORMALS[face][1], z + NORMALS[face][2]],
            liquid = t.shape === 'liquid',
            surface = liquid && face !== 3 && id(x, y + 1, z) !== t.id,
            drop = surface ? surfaceDrop(x, y, z) : 0;
          if (solid(fx, fy, fz)) {
            if (!(face === 2 && drop > 0)) continue;
          } else if (id(fx, fy, fz) === t.id) {
            if (!(liquid && face !== 2 && face !== 3 && drop < surfaceDrop(fx, fy, fz))) continue;
          }
          const [u, v] = [UAXIS[face], VAXIS[face]],
            at = (a, b) => [fx + a * u[0] + b * v[0], fy + a * u[1] + b * v[1], fz + a * u[2] + b * v[2]],
            ao = [],
            sky = [],
            block = [];
          for (const [a, b] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ]) {
            const s1 = solid(...at(a, 0)),
              s2 = solid(...at(0, b)),
              corner = solid(...at(a, b));
            ao.push(s1 && s2 ? 0 : 3 - s1 - s2 - corner);
            const open = [];
            if (!solid(fx, fy, fz)) open.push([fx, fy, fz]);
            if (!s1) open.push(at(a, 0));
            if (!s2) open.push(at(0, b));
            if (!(s1 && s2) && !corner) open.push(at(a, b));
            const bytes = open.length ? open.map((c) => g.light[idx(...c)]) : [light],
              mean = (f) => Math.floor(bytes.reduce((sum, l) => sum + f(l), 0) / bytes.length + 0.5);
            sky.push(mean((l) => l >> 4));
            block.push(mean((l) => l & 15));
          }
          const flip = ao[1] + ao[3] > ao[0] + ao[2] ? 1 : 0;
          out[t.layer].push(
            `${word0(x, y, z, face, 1, 1, flip, drop)},${word1(materials[t.id * 6 + face], ao, +surface)},${word2(sky, block)}`,
          );
        }
      }
  for (const layer of LAYER_NAMES) out[layer].sort();
  return out;
}

test('one block meshes to 6 unit quads, a 2 x 2 x 2 cube to 6 merged 2 x 2 quads', () => {
  const one = mesh([[5, 6, 7, STONE]]);
  assert.equal(one.opaque.length, 6 * QUAD_WORDS);
  assert.equal(one.cutout.length + one.translucent.length, 0);
  const q = quads(one.opaque);
  assert.deepEqual(q.map((f) => f.face).sort(), [0, 1, 2, 3, 4, 5]);
  for (const f of q) {
    assert.deepEqual([f.x, f.y, f.z, f.w, f.h, f.flip, f.material], [5, 6, 7, 1, 1, false, materials[STONE * 6]]);
    assert.deepEqual(f.ao, [3, 3, 3, 3]);
  }
  const cells = [];
  for (let i = 0; i < 8; i++) cells.push([10 + (i & 1), 10 + ((i >> 1) & 1), 10 + (i >> 2), STONE]);
  const cube = quads(mesh(cells, 0xf0).opaque);
  assert.equal(cube.length, 6);
  for (const f of cube) {
    assert.deepEqual([f.w, f.h, f.sky, f.block], [2, 2, [15, 15, 15, 15], [0, 0, 0, 0]]);
    assert.equal(f[['x', 'x', 'y', 'y', 'z', 'z'][f.face]], f.face & 1 ? 10 : 11);
  }
});

test('an L shape and a full-chunk 3D checkerboard match hand counts', () => {
  // L in the y = 0 plane: 14 unit faces; top and bottom need 2 rectangles each, the long sides 1, the short sides 2.
  const l = mesh([
    [0, 0, 0, STONE],
    [1, 0, 0, STONE],
    [0, 0, 1, STONE],
  ]);
  const byFace = [0, 0, 0, 0, 0, 0];
  for (const f of quads(l.opaque)) byFace[f.face]++;
  assert.deepEqual(byFace, [2, 1, 2, 2, 2, 1]);
  assert.equal(facesOf(l).length, 14);
  // Every block of a checkerboard shows 6 faces and no two faces touch in a plane: 16,384 x 6 unit quads.
  const g = grid();
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) if (!((x + y + z) & 1)) g.state[idx(x, y, z)] = STONE;
  const board = meshChunk(input(g, true));
  assert.equal(board.opaque.length, 16384 * 6 * QUAD_WORDS);
  assert.ok(quads(board.opaque).every((f) => f.w === 1 && f.h === 1));
  // Two different glasses alternating: every face of every cell shows, 32,768 x 6 in one layer.
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) g.state[idx(x, y, z)] = (x + y + z) & 1 ? TINTED : GLASS;
  assert.equal(meshChunk(input(g, true)).translucent.length, 32768 * 6 * QUAD_WORDS);
});

test('AO of a corner for all 8 configurations of its two edge cells and diagonal cell', () => {
  // The top face of (8, 8, 8): corner 0 is at its low x, low z; its edge cells (7, 9, 8), (8, 9, 7), diagonal (7, 9, 7).
  for (let config = 0; config < 8; config++) {
    const cells = [[8, 8, 8, STONE]];
    if (config & 1) cells.push([7, 9, 8, STONE]);
    if (config & 2) cells.push([8, 9, 7, STONE]);
    if (config & 4) cells.push([7, 9, 7, STONE]);
    const top = quads(mesh(cells).opaque).find((f) => f.face === 2 && f.x === 8 && f.y === 8 && f.z === 8);
    const [e1, e2, d] = [config & 1, (config >> 1) & 1, (config >> 2) & 1];
    assert.equal(top.ao[0], e1 && e2 ? 0 : 3 - e1 - e2 - d, `config ${config}`);
    assert.equal(top.ao[2], 3);
  }
  // Only the diagonal: AO 2, 3, 3, 3; the 1-3 diagonal joins the brighter pair, so the quad flips.
  const lone = quads(
    mesh([
      [8, 8, 8, STONE],
      [7, 9, 7, STONE],
    ]).opaque,
  ).find((f) => f.face === 2 && f.y === 8);
  assert.deepEqual([lone.ao, lone.flip], [[2, 3, 3, 3], true]);
  const far = quads(
    mesh([
      [8, 8, 8, STONE],
      [9, 9, 7, STONE],
    ]).opaque,
  ).find((f) => f.face === 2 && f.y === 8);
  assert.deepEqual([far.ao, far.flip], [[3, 2, 3, 3], false]);
});

test('smooth light averages the open cells around each vertex', () => {
  const g = grid();
  g.state[idx(8, 8, 8)] = STONE;
  g.light[idx(8, 9, 8)] = 0xf0;
  g.light[idx(7, 9, 8)] = 0x30;
  g.light[idx(7, 9, 7)] = 0x0c;
  const top = (m) => quads(m.opaque).find((f) => f.face === 2 && f.y === 8 && f.x === 8);
  let f = top(meshChunk(input(g)));
  assert.deepEqual([f.sky[0], f.block[0]], [5, 3]); // (15 + 3 + 0 + 0) / 4 = 4.5 rounds up; 12 / 4
  g.state[idx(7, 9, 8)] = STONE; // an opaque edge drops out of the mean
  f = top(meshChunk(input(g)));
  assert.deepEqual([f.sky[0], f.block[0]], [5, 4]);
  g.state[idx(8, 9, 7)] = STONE; // both edges opaque: the diagonal is hidden too
  f = top(meshChunk(input(g)));
  assert.deepEqual([f.sky[0], f.block[0], f.ao[0]], [15, 0, 0]);
});

test('culling between layers: opaque hides all, identical blocks hide each other, others keep both', () => {
  // [a, b, a's face toward b kept, b's face toward a kept]
  const cases = [
    [STONE, STONE, false, false],
    [STONE, GRASS, false, false],
    [STONE, GLASS, true, false],
    [STONE, LEAVES, true, false],
    [STONE, FLOWER, true, false],
    [STONE, BARRIER, true, false],
    [STONE, WATER, true, false],
    [LEAVES, LEAVES, false, false],
    [LEAVES, GLASS, true, true],
    [GLASS, GLASS, false, false],
    [GLASS, blockState(GLASS, 5), false, false],
    [GLASS, TINTED, true, true],
    [GLASS, WATER, true, true],
    [WATER, WATER, false, false],
    [LAVA, LAVA, false, false],
    [LAVA, STONE, false, true],
  ];
  for (const [a, b, keepA, keepB] of cases) {
    const m = mesh([
      [8, 8, 8, a],
      [9, 8, 8, b],
    ]);
    assert.deepEqual(
      [has(m, 8, 8, 8, 0), has(m, 9, 8, 8, 1)],
      [keepA, keepB],
      `${table[a & 0xffff].name}|${table[b & 0xffff].name}`,
    );
  }
  assert.equal(facesOf(mesh([[3, 3, 3, BARRIER]])).length, 0);
  // Chunk borders cull against the shell.
  const border = mesh([
    [31, 4, 4, STONE],
    [32, 4, 4, STONE],
    [0, 4, 4, GLASS],
    [-1, 4, 4, GLASS],
  ]);
  assert.deepEqual([has(border, 31, 4, 4, 0), has(border, 0, 4, 4, 1), has(border, 31, 4, 4, 1)], [false, false, true]);
});

test('cross blocks emit two unshaded diagonal quads lit by their own cell', () => {
  const g = grid();
  g.state[idx(4, 5, 6)] = FLOWER;
  g.state[idx(5, 5, 6)] = STONE;
  g.light[idx(4, 5, 6)] = 0xa3;
  const m = meshChunk(input(g)),
    cross = quads(m.cutout);
  assert.deepEqual(
    cross.map((f) => f.face),
    [6, 7],
  );
  for (const f of cross) {
    assert.deepEqual([f.x, f.y, f.z, f.w, f.h, f.material], [4, 5, 6, 1, 1, materials[FLOWER * 6]]);
    assert.deepEqual(
      [f.ao, f.sky, f.block],
      [
        [3, 3, 3, 3],
        [10, 10, 10, 10],
        [3, 3, 3, 3],
      ],
    );
  }
  assert.ok(has(m, 5, 5, 6, 1)); // the stone's face toward the flower stays
});

test('liquids: surface drop and wave, columns, solid lids and stepped surfaces', () => {
  const alone = quads(mesh([[8, 8, 8, blockState(WATER, 0xfff3)]]).translucent);
  assert.equal(alone.length, 6);
  for (const f of alone)
    assert.deepEqual([f.liquidDrop, f.wave], f.face === 3 ? [0, false] : [3, true], `face ${f.face}`);
  // A column: the inner faces go, the lower cell is full height and still, the upper one drops by its data.
  const column = facesOf(
    mesh([
      [8, 8, 8, blockState(WATER, 5)],
      [8, 9, 8, blockState(WATER, 2)],
    ]),
  );
  assert.equal(column.length, 10);
  for (const f of column) assert.deepEqual([f.liquidDrop, f.wave], f.y === 9 && f.face !== 3 ? [2, true] : [0, false]);
  // A lowered top under stone stays (it does not reach the stone); a full one goes.
  assert.ok(
    has(
      mesh([
        [8, 8, 8, blockState(WATER, 1)],
        [8, 9, 8, STONE],
      ]),
      8,
      8,
      8,
      2,
    ),
  );
  assert.ok(
    !has(
      mesh([
        [8, 8, 8, WATER],
        [8, 9, 8, STONE],
      ]),
      8,
      8,
      8,
      2,
    ),
  );
  // Next to a lower surface of the same liquid the higher cell keeps its side; the lower one does not.
  const step = mesh([
    [8, 8, 8, WATER],
    [9, 8, 8, blockState(WATER, 4)],
  ]);
  assert.deepEqual([has(step, 8, 8, 8, 0), has(step, 9, 8, 8, 1)], [true, false]);
});

test('merged quads expand to exactly the naive mesh: seeded random chunks with borders and mixed layers', () => {
  const pool = [STONE, GRASS, LEAVES, GLASS, TINTED, WATER, LAVA, FLOWER, BARRIER, 0],
    lights = [0x00, 0xf0, 0x7a, 0xff, 0x3c];
  let merged = 0,
    unit = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const next = random(seed),
      pick = (list) => list[Math.floor(next() * list.length)],
      state = () => {
        const id = pick(pool);
        return id === WATER || id === LAVA ? blockState(id, Math.floor(next() * 65536)) : id;
      },
      g = grid(),
      mode = seed % 3; // 0: one light, 1: light per box, 2: light per cell
    g.light.fill(0xf0);
    // Boxes (so faces merge) anywhere in the 34^3 grid, shell included, then scattered single cells.
    for (let b = 0; b < 30; b++) {
      const lo = [0, 0, 0].map(() => Math.floor(next() * 34) - 1),
        size = [0, 0, 0].map(() => 1 + Math.floor(next() * 12)),
        s = state(),
        l = pick(lights);
      for (let y = lo[1]; y < Math.min(33, lo[1] + size[1]); y++)
        for (let z = lo[2]; z < Math.min(33, lo[2] + size[2]); z++)
          for (let x = lo[0]; x < Math.min(33, lo[0] + size[0]); x++) {
            g.state[idx(x, y, z)] = s;
            if (mode === 1) g.light[idx(x, y, z)] = l;
          }
    }
    for (let n = 0; n < 2000 * (seed % 4); n++) g.state[Math.floor(next() * 39304)] = state();
    if (mode === 2) for (let i = 0; i < 39304; i++) g.light[i] = pick(lights);
    const m = meshChunk(input(g, seed & 1)),
      oracle = naive(g);
    for (const layer of LAYER_NAMES) {
      const got = unitFaces(m[layer]);
      assert.equal(got.length, oracle[layer].length, `seed ${seed} ${layer} face count`);
      assert.deepEqual(got, oracle[layer], `seed ${seed} ${layer}`);
      // Seeds 4 and 12 scatter no single cells and light per box or not at all: their opaque faces must merge.
      if (layer === 'opaque' && seed % 4 === 0 && mode !== 2) {
        merged += m[layer].length / QUAD_WORDS;
        unit += got.length;
      }
    }
  }
  assert.ok(merged < unit * 0.2, `greedy kept ${merged} of ${unit} opaque faces`);
});

test('uniform chunks (boundary-only and empty fast paths) match the oracle and merge to whole sides', () => {
  const next = random(5);
  for (const s of [STONE, GLASS, LEAVES, blockState(WATER, 2), LAVA, FLOWER, BARRIER, 0]) {
    for (const scattered of [false, true]) {
      const g = grid();
      g.light.fill(0xf0);
      for (let y = -1; y <= 32; y++)
        for (let z = -1; z <= 32; z++)
          for (let x = -1; x <= 32; x++)
            if (inside(x, y, z)) g.state[idx(x, y, z)] = s;
            else if (scattered && next() < 0.3) g.state[idx(x, y, z)] = [STONE, GLASS, s][Math.floor(next() * 3)];
      const m = meshChunk(input(g, true)),
        oracle = naive(g);
      for (const layer of LAYER_NAMES) assert.deepEqual(unitFaces(m[layer]), oracle[layer], `${s} ${layer}`);
      if (!scattered && (s === STONE || s === GLASS))
        assert.deepEqual(
          quads(m[s === STONE ? 'opaque' : 'translucent']).map((f) => f.w * f.h),
          [1024, 1024, 1024, 1024, 1024, 1024],
        );
    }
  }
});

// Oracle for visibility: union-find over open cells, then the chunk faces each component touches.
function connectivity(open) {
  const parent = Int32Array.from({ length: 32768 }, (_, i) => i),
    find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
  for (let i = 0; i < 32768; i++) {
    if (!open[i]) continue;
    if ((i & 31) < 31 && open[i + 1]) parent[find(i)] = find(i + 1);
    if (((i >> 5) & 31) < 31 && open[i + 32]) parent[find(i)] = find(i + 32);
    if (i >> 10 < 31 && open[i + 1024]) parent[find(i)] = find(i + 1024);
  }
  const touched = new Map();
  for (let i = 0; i < 32768; i++) {
    if (!open[i]) continue;
    const [x, z, y] = [i & 31, (i >> 5) & 31, i >> 10],
      f = (x === 31) | ((x === 0) << 1) | ((y === 31) << 2) | ((y === 0) << 3) | ((z === 31) << 4) | ((z === 0) << 5),
      r = find(i);
    touched.set(r, (touched.get(r) ?? 0) | f);
  }
  let bits = 0;
  for (const f of touched.values())
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) if ((f >> a) & (f >> b) & 1) bits |= 1 << (a * 6 + b);
  return bits;
}

test('visibility joins the chunk faces that see each other through open cells', () => {
  const all = connectivity(new Uint8Array(32768).fill(1));
  assert.equal(all.toString(2).split('1').length - 1, 15);
  assert.equal(mesh([]).visibility, all);
  const solid = grid();
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) solid.state[idx(x, y, z)] = STONE;
  assert.equal(meshChunk(input(solid)).visibility, 0);
  const wall = [];
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) wall.push([16, y, z, STONE]);
  assert.equal(mesh(wall).visibility, all & ~(1 << 1)); // everything but +x with -x
  for (let x = 0; x < 32; x++) solid.state[idx(x, 5, 5)] = x === 9 ? GLASS : 0; // a glass-plugged tunnel
  assert.equal(meshChunk(input(solid)).visibility, 1 << 1);
  for (let seed = 1; seed <= 6; seed++) {
    const next = random(seed),
      g = grid(),
      open = new Uint8Array(32768),
      density = 0.5 + seed * 0.05;
    for (let i = 0; i < 32768; i++) {
      const [x, z, y] = [i & 31, (i >> 5) & 31, i >> 10],
        s = next() < density ? STONE : next() < 0.5 ? LEAVES : 0;
      g.state[idx(x, y, z)] = s;
      open[i] = s !== STONE;
    }
    assert.equal(meshChunk(input(g)).visibility, connectivity(open), `seed ${seed}`);
  }
});

test('meshInput builds the shell from loaded neighbours and meshes across chunk borders', () => {
  const world = new VoxelWorld({ blocks }),
    next = random(3);
  for (let n = 0; n < 4000; n++) {
    const [x, y, z] = [0, 0, 0].map(() => Math.floor(next() * 36) - 2);
    world.setBlock(x, y, z, [STONE, GLASS, WATER, FLOWER][n & 3]);
  }
  world.removeChunk(-1, 0, 0); // an unloaded neighbour reads as air with light 0
  world.getChunk(0, 1, 0).setLight(4, 0, 9, 0x5b);
  const m = meshInput(world, chunkKey(0, 0, 0));
  let k = 0;
  for (let y = -1; y <= 32; y++)
    for (let z = -1; z <= 32; z++)
      for (let x = -1; x <= 32; x++) {
        if (inside(x, y, z)) continue;
        assert.equal(m.shell[k], world.getBlock(x, y, z), `shell ${x},${y},${z}`);
        const n = world.getChunk(x >> 5, y >> 5, z >> 5);
        assert.equal(m.light[k++], n ? n.getLight(x & 31, y & 31, z & 31) : 0);
      }
  assert.equal(k, 6536);
  assert.equal(m.light[6536 - 34 * 34 + (9 + 1) * 34 + 4 + 1], 0x5b); // shell cell (4, 32, 9): in the last layer
  assert.equal(m.blocks, table);
  assert.equal(meshInput(world, chunkKey(5, 5, 5)), undefined);
  // The same chunk meshed from the world and from a hand-built grid of the world's cells agree.
  const g = grid();
  for (let y = -1; y <= 32; y++)
    for (let z = -1; z <= 32; z++) for (let x = -1; x <= 32; x++) g.state[idx(x, y, z)] = world.getBlock(x, y, z);
  g.light[idx(4, 32, 9)] = 0x5b;
  const fromWorld = meshChunk(m),
    fromGrid = meshChunk(input(g));
  for (const layer of LAYER_NAMES) assert.deepEqual(fromWorld[layer], fromGrid[layer]);
  const seam = new VoxelWorld({ blocks });
  seam.setBlock(31, 0, 0, STONE);
  seam.setBlock(32, 0, 0, STONE);
  const left = meshChunk(meshInput(seam, '0,0,0'));
  assert.deepEqual([has(left, 31, 0, 0, 0), has(left, 31, 0, 0, 1)], [false, true]);
});

test('decodeQuad reads every field of the bit layout, maxima included', () => {
  const next = random(9);
  for (let n = 0; n < 500; n++) {
    const r = (max) => Math.floor(next() * (max + 1)),
      q = {
        x: r(31),
        y: r(31),
        z: r(31),
        face: r(7),
        w: 1 + r(31),
        h: 1 + r(31),
        flip: next() < 0.5,
        liquidDrop: r(7),
        material: r(4095),
        ao: [r(3), r(3), r(3), r(3)],
        wave: next() < 0.5,
        sky: [r(15), r(15), r(15), r(15)],
        block: [r(15), r(15), r(15), r(15)],
      };
    if (n === 0)
      Object.assign(q, { x: 31, y: 31, z: 31, face: 7, w: 32, h: 32, flip: true, liquidDrop: 7, material: 4095 });
    if (n === 0) Object.assign(q, { ao: [3, 3, 3, 3], wave: true, sky: [15, 15, 15, 15], block: [15, 15, 15, 15] });
    const words = Uint32Array.of(
      0,
      0,
      0,
      word0(q.x, q.y, q.z, q.face, q.w, q.h, +q.flip, q.liquidDrop),
      word1(q.material, q.ao, +q.wave),
      word2(q.sky, q.block),
    );
    assert.deepEqual(decodeQuad(words, 1), q);
    if (n === 0) assert.deepEqual([...words.slice(3)], [0xffffffff, 0x1fffff, 0xffffffff]);
  }
  assert.equal(QUAD_WORDS, 3);
});

test('blockMaterials numbers each distinct texture layer per block, in id order', () => {
  const m = blockMaterials(table);
  assert.equal(m.length, table.length * 6);
  assert.deepEqual([...m.slice(0, 6)], [0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff]); // air
  assert.deepEqual([...m.slice(STONE * 6, STONE * 6 + 6)], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...m.slice(GRASS * 6, GRASS * 6 + 6)], [1, 1, 2, 3, 1, 1]); // layers 3, 3, 2, 4, 3, 3
  assert.equal(m[GLASS * 6], 5);
  assert.equal(m[TINTED * 6], 6); // same texture layer as glass, own material (its tint differs)
  const many = new BlockTypes();
  for (let i = 0; i < 683; i++) many.define(`b${i}`, { textures: [0, 1, 2, 3, 4, 5] });
  assert.throws(() => blockMaterials(many.table), RangeError);
});

test('invalid mesh input throws per the conventions', () => {
  const ok = input(grid());
  assert.throws(() => meshChunk(null), TypeError);
  assert.throws(() => meshChunk({ ...ok, chunk: {} }), TypeError);
  assert.throws(() => meshChunk({ ...ok, shell: new Uint8Array(6536) }), TypeError);
  assert.throws(() => meshChunk({ ...ok, shell: new Uint32Array(6535) }), RangeError);
  assert.throws(() => meshChunk({ ...ok, blocks: [] }), TypeError);
  assert.throws(() => meshChunk({ ...ok, chunk: { ...new VoxelChunk().pack(), bits: 3 } }), RangeError);
  const bad = new VoxelChunk().pack();
  bad.palette = Uint32Array.of(9999);
  assert.throws(() => meshChunk({ ...ok, chunk: bad }), RangeError);
  const shell = ok.shell.slice();
  shell[100] = 777;
  assert.throws(() => meshChunk({ ...ok, shell }), RangeError);
  const world = new VoxelWorld({ blocks });
  assert.throws(() => meshInput({}, '0,0,0'), TypeError);
  assert.throws(() => meshInput(world, 7), TypeError);
  assert.throws(() => meshInput(world, '1,2'), RangeError);
  assert.throws(() => meshInput(world, '0,99999999999,0'), RangeError);
  assert.throws(() => decodeQuad([1, 2, 3], 0), TypeError);
  assert.throws(() => decodeQuad(new Uint32Array(6), 2), RangeError);
});
