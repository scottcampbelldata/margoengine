// A bevel across chunk seams: the mesher's border lists exactly the faces the neighbouring chunks chamfer, and chunks
// beveled with their borders as context form the same surface as one chunk holding the whole shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelWorld, blockState, chunkKey } from '../dist/index.js';
import { VoxelMesher, blockMaterials, decodeQuad, meshChunk, meshInput } from '../dist/mesher.js';
import { bevelQuads } from '../dist/bevel.js';
import { NodeWebWorker } from './worker-support.js';

const blocks = new BlockTypes();
const STONE = blocks.define('stone', { textures: 0 }),
  DIRT = blocks.define('dirt', { textures: 1 }),
  GLASS = blocks.define('glass', { layer: 'translucent', textures: 2 }),
  LEAVES = blocks.define('leaves', { layer: 'cutout', textures: 3 }),
  WATER = blocks.define('water', { layer: 'translucent', shape: 'liquid', liquid: true, solid: false, textures: 4 }),
  SLAB = blocks.define('slab', { shape: 'slab', textures: 5, waterlog: WATER }),
  STAIR = blocks.define('stair', { shape: 'stair', textures: 6 }),
  FLOWER = blocks.define('flower', { layer: 'cutout', shape: 'cross', solid: false, textures: 7 });

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const AXES = [
  [2, 1],
  [0, 2],
  [0, 1],
];
// The materials of liquid faces: they stay quads under a bevel.
const materials = blockMaterials(blocks.table),
  liquid = new Set(materials.slice(WATER * 6, WATER * 6 + 6));
const LAYERS = ['opaque', 'cutout', 'translucent'];

// The faces a bevel chamfers in each layer of a mesh, as the renderer splits them, in unit faces in world cells.
function beveled(mesh, origin) {
  return LAYERS.map((layer) => {
    const words = mesh[layer],
      out = [];
    for (let i = 0; i < words.length / 3; i++) {
      const q = decodeQuad(words, i);
      if (q.face > 5 || liquid.has(q.material) || q.inset || q.trim) continue;
      const [ua, va] = AXES[q.face >> 1];
      for (let u = 0; u < q.w; u++)
        for (let v = 0; v < q.h; v++) {
          const c = [q.x + origin[0], q.y + origin[1], q.z + origin[2]];
          c[ua] += u;
          c[va] += v;
          out.push({ x: c[0], y: c[1], z: c[2], face: q.face, material: q.material });
        }
    }
    return out;
  });
}
// The quads a bevel chamfers in each layer, kept merged, in chunk cells.
function quadsOf(mesh) {
  return LAYERS.map((layer) => {
    const words = mesh[layer],
      out = [];
    for (let i = 0; i < words.length / 3; i++) {
      const q = decodeQuad(words, i);
      if (!(q.face > 5 || liquid.has(q.material) || q.inset || q.trim)) out.push(q);
    }
    return out;
  });
}
const decodeBorder = (words) =>
  [...(words ?? [])].map((w) => ({
    x: (w & 63) - 1,
    y: ((w >>> 6) & 63) - 1,
    z: ((w >>> 12) & 63) - 1,
    face: (w >>> 18) & 7,
    layer: (w >>> 21) & 3,
    w: 1,
    h: 1,
  }));
const touches = (f, lo, hi) => {
  const c = [f.x, f.y, f.z],
    a = f.face >> 1,
    plane = c[a] + (f.face & 1 ? 0 : 1);
  return plane >= lo[a] && plane <= hi[a] && [0, 1, 2].every((b) => b === a || (c[b] + 1 >= lo[b] && c[b] <= hi[b]));
};

// Eight chunks around (32, 32, 32) with random blocks of every kind within 3 cells of their seams.
function seamWorld(seed) {
  const world = new VoxelWorld({ blocks }),
    next = random(seed),
    edits = [];
  for (let cx = 0; cx < 2; cx++)
    for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 2; cz++) world.addChunk(cx, cy, cz);
  for (let x = 28; x < 36; x++)
    for (let y = 28; y < 36; y++)
      for (let z = 28; z < 36; z++) {
        const r = next();
        const state =
          r < 0.3
            ? STONE
            : r < 0.4
              ? DIRT
              : r < 0.47
                ? GLASS
                : r < 0.54
                  ? LEAVES
                  : r < 0.58
                    ? blockState(WATER, (next() * 8) | 0)
                    : r < 0.62
                      ? blockState(SLAB, (next() * 16) | 0 | (next() < 0.3 ? 0x8000 : 0))
                      : r < 0.66
                        ? blockState(STAIR, (next() * 64) | 0)
                        : r < 0.68
                          ? FLOWER
                          : 0;
        if (state) edits.push(x, y, z, state);
      }
  world.setBlocks(edits);
  return world;
}

test('bevel seams: a chunk mesh border lists exactly the faces its neighbours chamfer that touch the chunk', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = NodeWebWorker;
  const mesher = new VoxelMesher({ workers: 2 });
  try {
    for (const seed of [1, 2, 3]) {
      const world = seamWorld(seed),
        keys = [];
      for (let cx = 0; cx < 2; cx++)
        for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 2; cz++) keys.push(chunkKey(cx, cy, cz));
      const meshes = new Map(keys.map((key) => [key, meshChunk(meshInput(world, key))])),
        bordered = await Promise.all(keys.map((key) => mesher.mesh(world, key, 0, undefined, true)));
      keys.forEach((key, k) => {
        const origin = key.split(',').map((v) => Number(v) * 32),
          lo = origin,
          hi = origin.map((v) => v + 32),
          expected = [],
          inside = (f) => [f.x, f.y, f.z].every((v, a) => v >= lo[a] && v < hi[a]);
        for (const [other, mesh] of meshes) {
          if (other === key) continue;
          beveled(
            mesh,
            other.split(',').map((v) => Number(v) * 32),
          ).forEach((faces, layer) => {
            for (const f of faces)
              if (!inside(f) && touches(f, lo, hi))
                expected.push(`${f.x - origin[0]},${f.y - origin[1]},${f.z - origin[2]},${f.face},${layer}`);
          });
        }
        const actual = decodeBorder(bordered[k].border).map((f) => `${f.x},${f.y},${f.z},${f.face},${f.layer}`);
        assert.ok(expected.length > 20, `seed ${seed} chunk ${key}: the scene puts faces on the seams`);
        assert.deepEqual(actual.sort(), expected.sort(), `seed ${seed} chunk ${key} border`);
        const plain = meshes.get(key);
        for (const layer of LAYERS)
          assert.deepEqual([...bordered[k][layer]], [...plain[layer]], 'the quads stay as meshed');
      });
    }
    const unasked = await mesher.mesh(seamWorld(1), '0,0,0');
    assert.equal(unasked.border, undefined, 'no border unless asked');
  } finally {
    mesher.dispose();
    globalThis.Worker = previous;
  }
});

// Surface measures of triangle meshes (each moved by its origin) with corners welded: the directed edges no opposite
// edge closes, area and signed volume. A layer's surface is open where it meets another layer's opaque cells.
function measure(meshes) {
  const edges = new Map(),
    weld = (p) => p.map((v) => Math.round(v * 4096)).join();
  let area = 0,
    volume = 0,
    triangles = 0;
  for (const { positions: p, indices, origin } of meshes)
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((ax) => p[indices[t + k] * 3 + ax] + origin[ax])),
        u = [0, 1, 2].map((k) => b[k] - a[k]),
        w = [0, 1, 2].map((k) => c[k] - a[k]),
        n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      area += Math.hypot(...n) / 2;
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
      triangles++;
      for (const [from, to] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const k = `${weld(from)}>${weld(to)}`;
        if (weld(from) !== weld(to)) edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
  // The open edges as runs along their lines: an edge a seam splits in two is the same run as one edge.
  const lines = new Map(),
    gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
  for (const [edge, count] of edges) {
    const [from, to] = edge.split('>').map((v) => v.split(',').map(Number));
    let d = [0, 1, 2].map((k) => to[k] - from[k]);
    const g = d.reduce(gcd, 0),
      flip = d.find(Boolean) < 0;
    d = d.map((v) => (flip ? -v : v) / g);
    const cross = [from[1] * d[2] - from[2] * d[1], from[2] * d[0] - from[0] * d[2], from[0] * d[1] - from[1] * d[0]],
      at = (p) => p[0] * d[0] + p[1] * d[1] + p[2] * d[2],
      key = `${d}|${cross}|${flip}`,
      list = lines.get(key) ?? [];
    for (let k = count - (edges.get(`${to}>${from}`) ?? 0); k > 0; k--)
      list.push([Math.min(at(from), at(to)), Math.max(at(from), at(to))]);
    lines.set(key, list);
  }
  const open = [];
  for (const [key, list] of lines) {
    list.sort((a, b) => a[0] - b[0]);
    let run;
    for (const [lo, hi] of list)
      if (run && lo === run[1]) run[1] = hi;
      else {
        if (run) open.push(`${key}|${run}`);
        run = [lo, hi];
      }
    if (run) open.push(`${key}|${run}`);
  }
  return { open: open.sort(), area, volume, triangles };
}

// A solid lump of stone and dirt (opaque) with a glass and a leaves lump beside it, cells at `at` + offsets.
function lumps(at, seed) {
  const next = random(seed),
    edits = [];
  for (let x = -4; x < 4; x++)
    for (let y = -4; y < 4; y++)
      for (let z = -4; z < 4; z++) {
        const d = Math.hypot(x + 0.5, y + 0.5, z + 0.5);
        if (d > 3.6 + next() * 0.8) continue;
        const r = next();
        edits.push(at[0] + x, at[1] + y, at[2] + z, x + y > 2 ? GLASS : x - z > 3 ? LEAVES : r < 0.5 ? STONE : DIRT);
      }
  return edits;
}

test('bevel seams: eight chunks beveled with their borders as context form the same surface as one chunk', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = NodeWebWorker;
  const mesher = new VoxelMesher({ workers: 2 });
  try {
    for (const seed of [4, 5, 6]) {
      // The same lumps around the corner of eight chunks, and inside one chunk.
      const split = new VoxelWorld({ blocks }),
        whole = new VoxelWorld({ blocks });
      for (let cx = 0; cx < 2; cx++)
        for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 2; cz++) split.addChunk(cx, cy, cz);
      whole.addChunk(0, 0, 0);
      split.setBlocks(lumps([32, 32, 32], seed));
      whole.setBlocks(lumps([16, 16, 16], seed));
      for (const [label, context] of [
        ['with borders', true],
        ['without borders', false],
      ]) {
        const parts = LAYERS.map(() => []);
        for (const key of split.chunks.keys()) {
          const mesh = await mesher.mesh(split, key, 0, undefined, true),
            origin = key.split(',').map((v) => Number(v) * 32),
            border = decodeBorder(mesh.border);
          quadsOf(mesh).forEach((quads, layer) => {
            if (!quads.length) return;
            const built = bevelQuads(quads, 0.15, context ? border.filter((f) => f.layer === layer) : []);
            parts[layer].push({ ...built, origin });
          });
        }
        // The whole chunk's lumps sit at 16; moved by 16 they lie where the split ones do.
        const reference = quadsOf(meshChunk(meshInput(whole, '0,0,0'))).map((quads) => [
          { ...bevelQuads(quads, 0.15), origin: [16, 16, 16] },
        ]);
        let differ = 0;
        LAYERS.forEach((layer, l) => {
          const a = measure(parts[l]),
            b = measure(reference[l]);
          assert.ok(b.triangles > 50, `seed ${seed} ${layer}: the lumps have this layer`);
          if (!context) {
            differ += +(a.open.join() !== b.open.join() || Math.abs(a.area - b.area) > 1e-4);
            return;
          }
          assert.deepEqual(a.open, b.open, `seed ${seed} ${layer} ${label}: the seams open edges one chunk does not`);
          assert.ok(Math.abs(a.area - b.area) < 1e-4, `seed ${seed} ${layer} ${label}: area ${a.area} != ${b.area}`);
          assert.ok(
            Math.abs(a.volume - b.volume) < 1e-3,
            `seed ${seed} ${layer} ${label}: volume ${a.volume} != ${b.volume}`,
          );
        });
        // The same check without the borders fails, so it does see the seams.
        if (!context) assert.ok(differ > 0, `seed ${seed}: without borders the seams match one chunk`);
      }
    }
  } finally {
    mesher.dispose();
    globalThis.Worker = previous;
  }
});
