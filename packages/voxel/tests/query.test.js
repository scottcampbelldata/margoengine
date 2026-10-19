import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { VoxelCharacter, raycastVoxels, sweepBox } from '../dist/query.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const EPS = 1e-6; // the contact tolerance query.ts documents
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

const kit = (options) => {
  const blocks = new BlockTypes(),
    ids = {
      stone: blocks.define('stone'),
      glass: blocks.define('glass', { layer: 'translucent' }),
      water: blocks.define('water', { shape: 'liquid', layer: 'translucent', solid: false, liquid: true }),
      flower: blocks.define('flower', { shape: 'cross', layer: 'cutout', solid: false }),
      barrier: blocks.define('barrier', { layer: 'invisible' }), // solid but never drawn or picked
    };
  return { world: new VoxelWorld({ blocks, ...options }), blocks, ids };
};
const fill = (world, x0, x1, y0, y1, z0, z1, state) => {
  const edits = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) edits.push(x, y, z, state);
  world.setBlocks(edits);
};
// A seeded world over cells -16..15 on every axis (negative cells and four chunk borders per axis) with a dense oracle.
const LO = -16,
  SIZE = 32;
const randomWorld = (seed, density) => {
  const next = random(seed),
    k = kit(),
    { stone, glass, water, flower, barrier } = k.ids,
    mix = [stone, stone, glass, water, flower, barrier],
    dense = new Uint32Array(SIZE ** 3),
    edits = [];
  for (let i = 0; i < dense.length; i++)
    if (next() < density) {
      dense[i] = mix[Math.floor(next() * mix.length)];
      edits.push((i % SIZE) + LO, (Math.floor(i / SIZE) % SIZE) + LO, Math.floor(i / SIZE / SIZE) + LO, dense[i]);
    }
  k.world.setBlocks(edits);
  const inside = (c) => c >= LO && c < LO + SIZE,
    at = (x, y, z) => (inside(x) && inside(y) && inside(z) ? dense[x - LO + SIZE * (y - LO + SIZE * (z - LO))] : 0),
    solids = [];
  for (let i = 0; i < dense.length; i++)
    if (k.blocks.get(dense[i]).solid)
      solids.push([(i % SIZE) + LO, (Math.floor(i / SIZE) % SIZE) + LO, Math.floor(i / SIZE / SIZE) + LO]);
  return { ...k, at, solids };
};

// --- raycastVoxels

// Brute force: sample the ray at the midpoints of steps of h blocks; the first sample in an accepted cell.
const march = (at, accept, o, d, max, h) => {
  const length = Math.hypot(...d);
  let px = Number.NaN,
    py = 0,
    pz = 0;
  for (let k = 0; (k + 0.5) * h <= max; k++) {
    const t = ((k + 0.5) * h) / length,
      x = Math.floor(o[0] + d[0] * t),
      y = Math.floor(o[1] + d[1] * t),
      z = Math.floor(o[2] + d[2] * t);
    if (x === px && y === py && z === pz) continue;
    const state = at(x, y, z);
    if (state && accept(state))
      return { cell: [x, y, z], distance: (k + 0.5) * h, prev: Number.isNaN(px) ? null : [px, py, pz] };
    px = x;
    py = y;
    pz = z;
  }
  return null;
};
// Length of the ray inside the closed box of `cell` (slab method), for cells a marcher of step h can miss.
const clipLength = (o, d, cell) => {
  const length = Math.hypot(...d);
  let t0 = 0,
    t1 = Number.POSITIVE_INFINITY;
  for (let a = 0; a < 3; a++) {
    if (!d[a]) {
      if (o[a] < cell[a] || o[a] > cell[a] + 1) return 0;
      continue;
    }
    const u = (cell[a] - o[a]) / d[a],
      v = (cell[a] + 1 - o[a]) / d[a];
    t0 = Math.max(t0, Math.min(u, v));
    t1 = Math.min(t1, Math.max(u, v));
  }
  return Math.max(0, t1 - t0) * length;
};

test('raycastVoxels matches a fine-step marcher on seeded worlds, edges, corners and negative cells', (t) => {
  const H = 1e-4,
    MAX = 30;
  let rays = 0,
    hits = 0,
    tolerated = 0;
  for (const seed of [1, 2, 3]) {
    const { world, ids, at } = randomWorld(seed, 0.12),
      next = random(seed * 977),
      accept = (s) => s === ids.stone || s === ids.glass || s === ids.flower,
      cases = [];
    for (let i = 0; i < 100; i++) {
      const g = () => {
          const u = Math.max(next(), 1e-12);
          return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
        },
        o = [0, 1, 2].map(() => next() * 36 - 18);
      cases.push([o, [g(), g(), g()]]);
    }
    // Exact edges and corners: origins on the half-integer and integer lattice, axis, face- and body-diagonal rays.
    const dirs = [];
    for (let x = -2; x <= 2; x++)
      for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) if (x || y || z) dirs.push([x, y, z]);
    for (let i = 0; i < 160; i++)
      cases.push([[0, 1, 2].map(() => Math.round((next() * 36 - 18) * 2) / 2), dirs[Math.floor(next() * dirs.length)]]);
    for (const [o, d] of cases) {
      rays++;
      const r = raycastVoxels(world, o, d, MAX),
        m = march(at, accept, o, d, MAX, H);
      if (!m && !r) continue;
      assert.ok(r, `ray ${o} -> ${d}: the marcher hit ${m?.cell} at ${m?.distance}, raycastVoxels nothing`);
      hits++;
      assert.equal(r.state, at(...r.cell));
      assert.ok(accept(r.state));
      assert.deepEqual(
        r.adjacent,
        r.cell.map((c, a) => c + r.normal[a]),
      );
      const length = Math.hypot(...d);
      for (let a = 0; a < 3; a++) {
        near(r.point[a], o[a] + (d[a] * r.distance) / length, 1e-9, 'point on the ray');
        assert.ok(r.point[a] >= r.cell[a] - 1e-9 && r.point[a] <= r.cell[a] + 1 + 1e-9, 'point on the cell');
      }
      const axis = r.normal.findIndex((n) => n !== 0);
      if (r.distance > 0) {
        assert.equal(Math.abs(r.normal[axis]), 1);
        assert.equal(r.normal.filter((n) => n).length, 1);
        assert.equal(r.point[axis], r.normal[axis] < 0 ? r.cell[axis] : r.cell[axis] + 1, 'point exactly on the face');
      }
      if (m && String(m.cell) === String(r.cell)) {
        assert.ok(r.distance <= m.distance + 1e-9 && m.distance - r.distance <= H + 1e-9, `distance ${o} -> ${d}`);
        if (r.distance > 0 && m.prev) assert.equal(r.normal[axis], m.prev[axis] - r.cell[axis], `normal ${o} -> ${d}`);
      } else {
        // The ray clipped a cell for less than the marcher's step: allowed, and it must come first.
        assert.ok(!m || r.distance < m.distance, `ray ${o} -> ${d}: ${r.cell} at ${r.distance}, marcher ${m.cell}`);
        assert.ok(clipLength(o, d, r.cell) < 2 * H, `ray ${o} -> ${d}: ${r.cell} is not a sliver`);
        tolerated++;
      }
    }
  }
  t.diagnostic(`${rays} rays, ${hits} hits, ${tolerated} slivers shorter than the marcher's step`);
  assert.ok(hits > rays / 2, `${hits} of ${rays} rays hit`);
  assert.ok(tolerated <= rays * 0.02, `${tolerated} sliver hits of ${rays}`);
});

test('raycastVoxels is exact in face planes, through edges and corners, and from inside or on a face', () => {
  const { world, ids } = kit();
  fill(world, -2, 20, 4, 4, -2, 2, ids.stone); // a floor whose top face is the plane y = 5
  world.setBlock(10, 5, 0, ids.stone);
  // In the plane y = 5 the ray runs in the cells above the face: it misses the floor and hits the wall.
  let r = raycastVoxels(world, [0.5, 5, 0.5], [1, 0, 0], 50);
  assert.deepEqual(r, {
    cell: [10, 5, 0],
    normal: [-1, 0, 0],
    adjacent: [9, 5, 0],
    point: [10, 5, 0.5],
    distance: 9.5,
    state: ids.stone,
  });
  assert.equal(raycastVoxels(world, [11.5, 5, 0.5], [1, 0, 0], 50), null);
  // A ray in the plane y = 5 that starts in the wall cell's row is inside it (zero normal, adjacent is the cell).
  r = raycastVoxels(world, [10.5, 5, 0.5], [0, 0, 1], 5);
  assert.deepEqual(
    [r.cell, r.normal, r.adjacent, r.point, r.distance],
    [[10, 5, 0], [0, 0, 0], [10, 5, 0], [10.5, 5, 0.5], 0],
  );
  // Straight down onto the floor: zero x and z components.
  r = raycastVoxels(world, [3.25, 9.5, -1.75], [0, -10, 0], 50);
  assert.deepEqual([r.cell, r.normal, r.point, r.distance], [[3, 4, -2], [0, 1, 0], [3.25, 5, -1.75], 4.5]);
  // max is inclusive.
  assert.ok(raycastVoxels(world, [3.25, 9.5, -1.75], [0, -1, 0], 4.5));
  assert.equal(raycastVoxels(world, [3.25, 9.5, -1.75], [0, -1, 0], 4.4999), null);

  const c = kit(),
    w = c.world,
    s = c.ids.stone;
  // Through an edge: the two cells it only touches are skipped.
  w.setBlocks([1, 0, 0, s, 0, 1, 0, s, 2, 2, 0, s]);
  r = raycastVoxels(w, [0.5, 0.5, 0.5], [1, 1, 0], 10);
  assert.deepEqual(
    [r.cell, r.normal, r.point],
    [
      [2, 2, 0],
      [-1, 0, 0],
      [2, 2, 0.5],
    ],
  );
  near(r.distance, 1.5 * Math.SQRT2, 1e-12, 'edge distance');
  // Through a corner: the six cells around it are touched, not entered.
  for (const [x, y, z] of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 0],
    [1, 0, 1],
    [0, 1, 1],
  ])
    w.setBlock(x + 10, y + 10, z + 10, s);
  w.setBlock(11, 11, 11, s);
  r = raycastVoxels(w, [10.5, 10.5, 10.5], [2, 2, 2], 10);
  assert.deepEqual(
    [r.cell, r.normal, r.point],
    [
      [11, 11, 11],
      [-1, 0, 0],
      [11, 11, 11],
    ],
  );
  near(r.distance, 0.5 * Math.sqrt(3), 1e-12, 'corner distance');
  // Negative cells, leaving an integer coordinate downwards: the cell above the origin's face is not entered.
  w.setBlocks([-3, 0, 0, s, -6, 0, 0, s]);
  r = raycastVoxels(w, [-3, 0.5, 0.5], [-1, 0, 0], 10);
  assert.deepEqual(
    [r.cell, r.normal, r.adjacent, r.point, r.distance],
    [[-6, 0, 0], [1, 0, 0], [-5, 0, 0], [-5, 0.5, 0.5], 2],
  );
  // On a face pointing in: entered through that face at distance 0.
  r = raycastVoxels(w, [-3, 0.5, 0.5], [1, 0, 0], 10);
  assert.deepEqual(
    [r.cell, r.normal, r.adjacent, r.point, r.distance],
    [[-3, 0, 0], [-1, 0, 0], [-4, 0, 0], [-3, 0.5, 0.5], 0],
  );
  // Inside.
  r = raycastVoxels(w, [-2.5, 0.25, 0.75], [0, 1, 0], 10);
  assert.deepEqual([r.cell, r.normal, r.adjacent, r.distance], [[-3, 0, 0], [0, 0, 0], [-3, 0, 0], 0]);
});

test('raycastVoxels skips air, liquids and invisible blocks by default, hits cross blocks as cells, takes a filter', () => {
  const { world, ids } = kit();
  world.setBlocks([2, 0, 0, ids.water, 3, 0, 0, ids.barrier, 4, 0, 0, ids.flower, 6, 0, 0, ids.stone]);
  const ray = (filter) => raycastVoxels(world, [0.5, 0.5, 0.5], [1, 0, 0], 20, filter);
  assert.deepEqual([ray().cell, ray().point, ray().state], [[4, 0, 0], [4, 0.5, 0.5], ids.flower]);
  assert.deepEqual(ray((s, type) => type.liquid).cell, [2, 0, 0]);
  assert.deepEqual(ray((s, type) => type.solid).cell, [3, 0, 0]);
  assert.deepEqual(ray((s) => s === ids.stone).cell, [6, 0, 0]);
  assert.equal(
    ray(() => false),
    null,
  );
  // A world clipped to y 0..15: a ray that leaves the range never returns.
  const clipped = kit({ minY: 0, maxY: 15 });
  assert.equal(raycastVoxels(clipped.world, [0.5, 8, 0.5], [0, 1, 0], 1e9), null);
  assert.equal(raycastVoxels(clipped.world, [0.5, 8, 0.5], [0, -1, 0], 1e9), null);
});

test('raycastVoxels validates its arguments', () => {
  const { world } = kit();
  assert.throws(() => raycastVoxels({}, [0, 0, 0], [1, 0, 0], 5), TypeError);
  assert.throws(() => raycastVoxels(world, [0, 0], [1, 0, 0], 5), TypeError);
  assert.throws(() => raycastVoxels(world, [0, 0, 'a'], [1, 0, 0], 5), TypeError);
  assert.throws(() => raycastVoxels(world, [0, Number.NaN, 0], [1, 0, 0], 5), RangeError);
  assert.throws(() => raycastVoxels(world, [0, 0, 0], [0, 0, 0], 5), RangeError);
  assert.throws(() => raycastVoxels(world, [0, 0, 0], [1, 0, 0], -1), RangeError);
  assert.throws(() => raycastVoxels(world, [0, 0, 0], [1, 0, 0], Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => raycastVoxels(world, [0, 0, 0], [1, 0, 0], '5'), TypeError);
  assert.throws(() => raycastVoxels(world, [2 ** 31, 0, 0], [1, 0, 0], 5), RangeError);
  assert.throws(() => raycastVoxels(world, [0, 0, 0], [1, 0, 0], 5, 'stone'), TypeError);
});

// --- sweepBox

const overlap = (lo, hi, c) => Math.min(hi, c + 1) - Math.max(lo, c);
const insideSolid = (solids, min, max) =>
  solids.find((c) => [0, 1, 2].every((a) => overlap(min[a], max[a], c[a]) > EPS + 1e-9));
// Brute force over every solid cell: per axis (y, x, z), the nearest solid ahead overlapping the cross-section.
const sweepOracle = (solids, box, motion) => {
  const lo = [...box.min],
    hi = [...box.max],
    hit = [false, false, false];
  let onGround = false;
  for (const a of [1, 0, 2]) {
    const m = motion[a],
      [u, v] = [0, 1, 2].filter((i) => i !== a);
    if (!m && a !== 1) continue;
    let allowed = m;
    for (const c of solids) {
      if (!(c[u] < hi[u] - EPS && c[u] + 1 > lo[u] + EPS && c[v] < hi[v] - EPS && c[v] + 1 > lo[v] + EPS)) continue;
      if (m > 0 && c[a] >= hi[a] - EPS && c[a] <= hi[a] + m + EPS) {
        hit[a] = true;
        allowed = Math.min(allowed, c[a] - hi[a]);
      } else if (m < 0 && c[a] + 1 <= lo[a] + EPS && c[a] + 1 >= lo[a] + m - EPS) {
        hit[a] = true;
        allowed = Math.max(allowed, c[a] + 1 - lo[a]);
      } else if (!m && Math.abs(c[a] + 1 - lo[a]) <= EPS) onGround = true;
    }
    lo[a] += allowed;
    hi[a] += allowed;
    if (a === 1 && m) onGround = hit[1] && m < 0;
  }
  return { position: lo, hit, onGround, max: hi };
};

test('sweepBox matches a brute-force sweep and never ends inside a solid cell, at any speed (seeded fuzz)', () => {
  let cases = 0,
    stopped = 0;
  for (const seed of [11, 12, 13, 14]) {
    const { world, solids } = randomWorld(seed, 0.2),
      next = random(seed * 31);
    for (let n = 0; n < 600; n++) {
      const size = [0.1 + next() * 2.4, 0.1 + next() * 2.9, 0.1 + next() * 2.4],
        // Every fourth start sits on the integer lattice, touching faces exactly.
        snap = n % 4 === 0,
        min = [0, 1, 2].map((a) => {
          const p = next() * 34 - 17;
          return snap ? Math.round(p) : p;
        }),
        max = min.map((p, a) => p + size[a]);
      if (insideSolid(solids, min, max)) continue;
      const speed = 10 ** (next() * 5.5 - 3), // 0.001 .. 300 blocks in one call
        motion = [0, 1, 2].map(() => (next() < 0.2 ? 0 : (next() * 2 - 1) * speed)),
        box = { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } },
        r = sweepBox(world, box, motion),
        o = sweepOracle(solids, { min, max }, motion);
      cases++;
      if (r.hit.some(Boolean)) stopped++;
      for (let a = 0; a < 3; a++) near(r.position[a], o.position[a], 1e-12, `case ${seed}/${n} axis ${a}`);
      assert.deepEqual(r.hit, o.hit, `case ${seed}/${n} hit`);
      assert.equal(r.onGround, o.onGround, `case ${seed}/${n} onGround`);
      const end = r.position.map((p, a) => p + size[a]),
        bad = insideSolid(solids, r.position, end);
      assert.equal(bad, undefined, `case ${seed}/${n} ends inside solid cell ${bad}`);
    }
  }
  assert.ok(cases > 800 && stopped > cases / 4, `${cases} cases, ${stopped} stopped`);
});

test('sweepBox lands, rests, reports hit axes and lets a box out of a block placed inside it', () => {
  const { world, ids } = kit();
  fill(world, -3, 3, -1, -1, -3, 3, ids.stone);
  const box = (x, y, z) => ({ min: { x, y, z }, max: { x: x + 0.6, y: y + 1.8, z: z + 0.6 } });
  let r = sweepBox(world, box(0.2, 5, 0.2), [0, -1e4, 0]);
  assert.deepEqual(r, { position: [0.2, 0, 0.2], hit: [false, true, false], onGround: true });
  r = sweepBox(world, box(0.2, 0, 0.2), [0.5, 0, 0]);
  assert.deepEqual(r, { position: [0.7, 0, 0.2], hit: [false, false, false], onGround: true });
  r = sweepBox(world, box(0.2, 0.5, 0.2), [0, 0, 0]);
  assert.equal(r.onGround, false);
  r = sweepBox(world, box(0.2, 0, 0.2), [0, 0.25, 0]);
  assert.deepEqual([r.hit, r.onGround], [[false, false, false], false]);
  world.setBlock(2, 0, 0, ids.stone);
  r = sweepBox(world, box(0.2, 0, 0.2), [5, -1, 0]);
  assert.deepEqual(r, { position: [1.4, 0, 0.2], hit: [true, true, false], onGround: true });
  // Out of a block placed inside the box, and not back into it.
  r = sweepBox(world, box(1.8, 0, 0.2), [2, 0, 0]);
  assert.deepEqual(r.position, [3.8, 0, 0.2]);
  r = sweepBox(world, box(1.8, 0, 0.2), [-2, 0, 0]);
  near(r.position[0], -0.2, 1e-12, 'moved out to the left');
  r = sweepBox(world, box(3.5, 0, 0.2), [-2, 0, 0]);
  assert.deepEqual(
    [r.position, r.hit],
    [
      [3, 0, 0.2],
      [true, false, false],
    ],
  );
  // Non-solid blocks (water, flowers) do not stop it; invisible solid ones (barriers) do.
  world.setBlocks([0, 0, 2, ids.water, 0, 0, 3, ids.flower, 0, 0, 5, ids.barrier]);
  r = sweepBox(world, box(0.2, 0, 0.2), [0, 0, 10]);
  assert.deepEqual(
    [r.position, r.hit],
    [
      [0.2, 0, 4.4],
      [false, false, true],
    ],
  );
});

test('sweepBox validates its arguments', () => {
  const { world } = kit(),
    box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  assert.throws(() => sweepBox(null, box, [0, 0, 0]), TypeError);
  assert.throws(() => sweepBox(world, { min: [0, 0, 0] }, [0, 0, 0]), TypeError);
  assert.throws(
    () => sweepBox(world, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 'a', z: 1 } }, [0, 0, 0]),
    TypeError,
  );
  assert.throws(() => sweepBox(world, { min: { x: 2, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, [0, 0, 0]), RangeError);
  assert.throws(() => sweepBox(world, box, [0, Number.POSITIVE_INFINITY, 0]), RangeError);
  assert.throws(() => sweepBox(world, box, [0, 0]), TypeError);
});

// --- VoxelCharacter

// Runs `character` for `seconds` at `hz`, asserting after every frame that its box overlaps no solid cell.
const run = (character, seconds, intent = {}, hz = 60) => {
  const frames = Math.round(seconds * hz);
  for (let i = 0; i < frames; i++) {
    character.update(1 / hz, typeof intent === 'function' ? intent(i / hz) : intent);
    assert.equal(stuck(character), undefined, `inside a solid cell at ${character.position}`);
  }
};
const stuck = (c) => {
  const [x, y, z] = c.position,
    [w, h, d] = c.size,
    lo = [x - w / 2, y, z - d / 2],
    hi = [x + w / 2, y + h, z + d / 2];
  for (let i = Math.floor(lo[0]); i < hi[0]; i++)
    for (let j = Math.floor(lo[1]); j < hi[1]; j++)
      for (let k = Math.floor(lo[2]); k < hi[2]; k++)
        if (
          c.world.blocks.get(c.world.getBlock(i, j, k) & 0xffff).solid &&
          [
            [0, i],
            [1, j],
            [2, k],
          ].every(([a, cell]) => overlap(lo[a], hi[a], cell) > EPS + 1e-9)
        )
          return [i, j, k];
  return undefined;
};
const ground = () => {
  const k = kit();
  fill(k.world, -8, 16, -1, -1, -8, 8, k.ids.stone);
  return k;
};
const EAST = { direction: [1, 0, 0] };

test('VoxelCharacter: landing sets onGround and stops on the floor', () => {
  const { world } = ground(),
    c = new VoxelCharacter(world);
  c.position = [0.5, 3, 0.5];
  c.update(0.05);
  assert.equal(c.onGround, false);
  assert.ok(c.velocity[1] < 0);
  run(c, 1.5);
  assert.equal(c.onGround, true);
  assert.equal(c.position[1], 0);
  assert.equal(c.velocity[1], 0);
  near(c.renderPosition[1], 0, 1e-12, 'drawn on the floor');
});

test('VoxelCharacter: step-up climbs 0.5 ledges and stops at 1.0 ledges with the 0.6 default', () => {
  // A 1.0 ledge from the ground: too tall for 0.6, climbed with stepHeight 1.
  let { world, ids } = ground();
  fill(world, 3, 8, 0, 0, -8, 8, ids.stone);
  let c = new VoxelCharacter(world);
  c.position = [0.5, 0, 0.5];
  run(c, 2, EAST);
  near(c.position[0], 2.7, 1e-9, 'stopped at the 1.0 ledge');
  assert.equal(c.position[1], 0);
  c = new VoxelCharacter(world, { stepHeight: 1 });
  c.position = [0.5, 0, 0.5];
  run(c, 2, EAST);
  assert.equal(c.position[1], 1);
  assert.ok(c.position[0] > 4 && c.onGround);
  // A 0.5 ledge: swimming at the edge of a pool whose bank stands 0.5 above the feet.
  ({ world, ids } = kit());
  fill(world, -8, 2, -5, 0, -8, 8, ids.water);
  fill(world, -8, 8, -6, -6, -8, 8, ids.stone);
  fill(world, 3, 8, -5, 0, -8, 8, ids.stone);
  c = new VoxelCharacter(world);
  c.position = [2.6, 0.5, 0.5];
  c.update(1 / 60, EAST);
  assert.equal(c.inLiquid, true);
  run(c, 1, EAST);
  assert.equal(c.position[1], 1);
  assert.ok(c.position[0] > 3.5 && c.onGround && !c.inLiquid);
  // 1.0 below the bank top it stays in the water, until it jumps against the bank.
  c = new VoxelCharacter(world);
  c.position = [2.6, 0, 0.5];
  run(c, 1, EAST);
  assert.ok(c.position[1] < 0.5 && c.position[0] <= 2.7 + 1e-9);
  run(c, 1, { ...EAST, jump: true });
  run(c, 1); // let go and settle on the bank
  assert.equal(c.position[1], 1);
  assert.ok(c.position[0] > 3 && c.onGround && !c.inLiquid);
});

test('VoxelCharacter: step-up never clips a ceiling', () => {
  // Stepping onto the 1.0 ledge would put the head into a ceiling 1.0 above the ledge.
  let { world, ids } = ground();
  fill(world, 3, 8, 0, 0, -8, 8, ids.stone);
  fill(world, 3, 8, 2, 2, -8, 8, ids.stone);
  let c = new VoxelCharacter(world, { stepHeight: 1 });
  c.position = [0.5, 0, 0.5];
  run(c, 2, EAST);
  near(c.position[0], 2.7, 1e-9, 'blocked by the low ceiling over the ledge');
  assert.equal(c.position[1], 0);
  // A ceiling 0.2 above the head: there is no room to rise 1.0.
  ({ world, ids } = ground());
  fill(world, 3, 8, 0, 0, -8, 8, ids.stone);
  fill(world, -8, 2, 2, 2, -8, 8, ids.stone);
  c = new VoxelCharacter(world, { stepHeight: 1 });
  c.position = [0.5, 0, 0.5];
  run(c, 2, EAST);
  near(c.position[0], 2.7, 1e-9, 'blocked by the ceiling over the start');
  assert.equal(c.position[1], 0);
});

test('VoxelCharacter: jumping bumps its head on a ceiling and comes back down', () => {
  // Highest feet over one second after a jump, and the frames spent there.
  const jump = (world) => {
    const c = new VoxelCharacter(world);
    c.position = [0.5, 0, 0.5];
    c.update(1 / 60, { jump: true });
    const feet = [];
    for (let i = 0; i < 60; i++) {
      c.update(1 / 60);
      assert.equal(stuck(c), undefined);
      feet.push(c.position[1]);
    }
    const top = Math.max(...feet);
    return { c, top, frames: feet.filter((y) => y > top - 1e-9).length };
  };
  assert.ok(Math.abs(jump(ground().world).top - 1.27) < 0.05, 'an open jump rises about 1.27');
  const { world, ids } = ground();
  fill(world, -8, 8, 2, 2, -8, 8, ids.stone);
  const { c, top, frames } = jump(world);
  near(top, 0.2, 1e-9, 'feet when the head (1.8) meets the ceiling (2)');
  assert.equal(frames, 1, 'the bump cuts the upward speed: it falls at once instead of pressing on the ceiling');
  assert.equal(c.onGround, true);
  assert.equal(c.position[1], 0);
});

test('VoxelCharacter: swims slower than it walks, sinks slowly, flies without gravity', () => {
  let c = new VoxelCharacter(ground().world);
  c.position = [-6, 0, 0.5];
  run(c, 1.5, EAST);
  near(c.velocity[0], 4.317, 1e-3, 'walk speed');
  run(c, 1, { ...EAST, sprint: true });
  near(c.velocity[0], 5.612, 1e-3, 'sprint speed');
  const { world, ids } = kit();
  fill(world, -30, 30, -40, 0, -4, 4, ids.water);
  c = new VoxelCharacter(world);
  c.position = [-20, -20, 0.5];
  run(c, 2, EAST);
  assert.equal(c.inLiquid, true);
  near(c.velocity[0], 2, 0.02, 'swim speed');
  assert.ok(c.velocity[1] < 0 && c.velocity[1] > -1.5, `sinks slowly (${c.velocity[1]})`);
  run(c, 1, { jump: true });
  assert.ok(c.velocity[1] > 0.5, 'swims up');
  // Dry, the same second of falling reaches 30 blocks/s.
  c = new VoxelCharacter(kit().world);
  c.position = [0, 100, 0];
  run(c, 1);
  assert.ok(c.velocity[1] < -30);
  c = new VoxelCharacter(kit().world);
  c.flying = true;
  c.position = [0, 10, 0];
  run(c, 1);
  assert.equal(c.position[1], 10);
  run(c, 1, { jump: true });
  near(c.velocity[1], 11, 0.01, 'fly speed');
  run(c, 1, { descend: true, direction: [0, 0, 5] });
  near(Math.hypot(...c.velocity), 11, 0.01, 'fly speed with a long direction');
});

test('VoxelCharacter: 60, 144 and 30 Hz updates give the same path', () => {
  const { world, ids } = ground();
  fill(world, 3, 4, 0, 0, -8, 8, ids.stone);
  fill(world, 5, 6, 0, 1, -8, 8, ids.stone);
  fill(world, -8, 16, 4, 4, 4, 8, ids.stone);
  fill(world, 8, 12, -1, -1, -8, 8, ids.water);
  // Switches at times every rate has a frame starting on, each taking effect from that frame (t >= switch time).
  const script = (t) =>
    t < 1
      ? EAST
      : t < 2
        ? { ...EAST, jump: true, sprint: true }
        : t < 3
          ? { direction: [0.6, 0, 0.8], jump: t >= 2.5 }
          : t < 3.5
            ? {}
            : { direction: [-1, 0, 0.2] };
  const path = (hz) => {
    const c = new VoxelCharacter(world, { stepHeight: 0.6 }),
      samples = [];
    c.position = [0.5, 0, 0.5];
    for (let frame = 0; frame < 4 * hz; frame++) {
      c.update(1 / hz, script(frame / hz));
      if ((frame + 1) % (hz / 2) === 0) samples.push([...c.position, ...c.renderPosition]);
    }
    return samples;
  };
  const a = path(60),
    b = path(144),
    c = path(30);
  assert.ok(a[7][0] > 3, 'it went somewhere');
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < 6; j++) {
      near(b[i][j], a[i][j], 1e-9, `144 Hz sample ${i}`);
      near(c[i][j], a[i][j], 1e-9, `30 Hz sample ${i}`);
    }
});

test('VoxelCharacter: random walks on random worlds never end a frame inside a solid cell', () => {
  for (const seed of [21, 22]) {
    const { world } = randomWorld(seed, 0.18),
      next = random(seed),
      c = new VoxelCharacter(world);
    c.position = [0.5, 17, 0.5];
    let intent = {};
    for (let frame = 0; frame < 1200; frame++) {
      if (frame % 15 === 0)
        intent = {
          direction: [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1],
          jump: next() < 0.4,
          descend: next() < 0.2,
          sprint: next() < 0.5,
        };
      if (frame % 300 === 0) c.flying = !c.flying;
      c.update(next() / 20, intent);
      assert.equal(stuck(c), undefined, `seed ${seed} frame ${frame} at ${c.position}`);
    }
  }
});

test('VoxelCharacter: teleports, carries the remainder and validates', () => {
  const { world } = ground(),
    c = new VoxelCharacter(world, { size: [0.8, 1.5, 0.8], speeds: { walk: 3 } });
  assert.deepEqual(c.speeds, { walk: 3, sprint: 5.612, swim: 2, fly: 11, jump: 9 });
  c.position = [5, 0, 5];
  c.update(0.001);
  assert.deepEqual(c.renderPosition, [5, 0, 5]);
  c.position[0] = -2;
  c.update(0);
  assert.deepEqual(c.renderPosition, [-2, 0, 5]);
  run(c, 1, EAST);
  near(c.velocity[0], 3, 1e-3, 'custom walk speed');
  assert.throws(() => new VoxelCharacter({}), TypeError);
  assert.throws(() => new VoxelCharacter(world, { size: [0.6, 0, 0.6] }), RangeError);
  assert.throws(() => new VoxelCharacter(world, { stepHeight: -1 }), RangeError);
  assert.throws(() => new VoxelCharacter(world, { gravity: 'down' }), TypeError);
  assert.throws(() => new VoxelCharacter(world, { speeds: { fly: Number.NaN } }), RangeError);
  assert.throws(() => c.update(-1), RangeError);
  assert.throws(() => c.update(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => c.update(1 / 60, null), TypeError);
  assert.throws(() => c.update(1 / 60, { direction: [1, 0] }), TypeError);
  c.position = [0, Number.NaN, 0];
  assert.throws(() => c.update(1 / 60), RangeError);
});

test('benchmark: ray casts, sweeps and character updates (printed)', (t) => {
  const { world, ids } = kit(),
    edits = [];
  // Rolling terrain over 128 x 128 columns (16 chunks), stone under grass-level glass and flowers.
  for (let x = -64; x < 64; x++)
    for (let z = -64; z < 64; z++) {
      const h = Math.floor(8 * Math.sin(x / 9) + 6 * Math.cos(z / 7));
      for (let y = -24; y <= h; y++) edits.push(x, y, z, ids.stone);
      if ((x * 7 + z * 13) % 11 === 0) edits.push(x, h + 1, z, ids.flower);
    }
  world.setBlocks(edits);
  const next = random(5),
    n = 20000,
    rays = Array.from({ length: n }, () => [
      [next() * 100 - 50, 20 + next() * 10, next() * 100 - 50],
      [next() * 2 - 1, -next(), next() * 2 - 1],
    ]);
  let found = 0;
  for (const [o, d] of rays) if (raycastVoxels(world, o, d, 64)) found++; // warm-up
  let start = performance.now();
  for (const [o, d] of rays) raycastVoxels(world, o, d, 64);
  const rayMs = performance.now() - start;
  start = performance.now();
  for (const [o, d] of rays)
    sweepBox(
      world,
      { min: { x: o[0], y: o[1] - 10, z: o[2] }, max: { x: o[0] + 0.6, y: o[1] - 8.2, z: o[2] + 0.6 } },
      d,
    );
  const sweepMs = performance.now() - start;
  const c = new VoxelCharacter(world);
  c.position = [0.5, 30, 0.5];
  let intent = {};
  start = performance.now();
  for (let i = 0; i < n; i++) {
    if (i % 30 === 0) intent = { direction: [next() * 2 - 1, 0, next() * 2 - 1], jump: next() < 0.3 };
    c.update(1 / 60, intent);
  }
  const updateMs = performance.now() - start;
  t.diagnostic(`raycastVoxels, 64-block rays over terrain: ${(n / rayMs).toFixed(0)} rays/ms (${found} hit)`);
  t.diagnostic(`sweepBox, player box, 1-block motions: ${(n / sweepMs).toFixed(0)} sweeps/ms`);
  t.diagnostic(`VoxelCharacter.update(1/60) (2 fixed steps): ${(n / updateMs).toFixed(0)} updates/ms`);
});
