// Slabs and stairs end to end: their state helpers and octants (corners, double slabs, waterlogging), the mesher
// (against a half-block oracle with liquids), picking, box sweeps and the character on stairs, light through their open
// part, and their states in the byte formats.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlockTypes,
  VoxelWorld,
  connectStairs,
  doubleSlabState,
  shapeOctants,
  slabState,
  stairState,
  waterlogState,
} from '../dist/index.js';
import { blockMaterials, decodeQuad, meshChunk, meshInput, quadCenters } from '../dist/mesher.js';
import { VoxelCharacter, raycastVoxels, sweepBox } from '../dist/query.js';
import { VoxelLighting } from '../dist/light.js';
import { decodeBlockChanges, decodeChunk, encodeBlockChanges, encodeChunk } from '../dist/codec.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const blocks = new BlockTypes();
const STONE = blocks.define('stone', { textures: 1 }),
  WATER = blocks.define('water', {
    layer: 'translucent',
    shape: 'liquid',
    liquid: true,
    solid: false,
    opacity: 2,
    textures: 7,
  }),
  SLAB = blocks.define('slab', { shape: 'slab', textures: 2, waterlog: WATER }),
  STAIR = blocks.define('stair', { shape: 'stair', textures: 3, waterlog: 'water' }),
  GLASS = blocks.define('glass', { layer: 'translucent', textures: 4 }),
  GLASS_SLAB = blocks.define('glass-slab', { layer: 'translucent', shape: 'slab', textures: 4 }),
  FLOWER = blocks.define('flower', { layer: 'cutout', shape: 'cross', solid: false, textures: 5 }),
  TORCH = blocks.define('torch', { layer: 'cutout', shape: 'cross', solid: false, light: 14, textures: 6 });
const table = blocks.table,
  FACINGS = ['+x', '-x', '+z', '-z'],
  ACROSS = { '+x': ['+z', '-z'], '-x': ['+z', '-z'], '+z': ['+x', '-x'], '-z': ['+x', '-x'] },
  // Every slab and stair shape: straight stairs, corners of both kinds toward both sides, a double slab.
  SHAPES = [
    slabState(SLAB),
    slabState(SLAB, true),
    doubleSlabState(SLAB),
    ...FACINGS.flatMap((f) =>
      [false, true].flatMap((down) => [
        stairState(STAIR, f, down),
        ...ACROSS[f].flatMap((side) => [
          stairState(STAIR, f, down, `inner${side}`),
          stairState(STAIR, f, down, `outer${side}`),
        ]),
      ]),
    ),
  ],
  // Each of them dry and waterlogged.
  SHAPED = SHAPES.flatMap((state) => [state, waterlogState(state)]);

test('slab and stair states and their octants', () => {
  assert.equal(slabState(SLAB), SLAB);
  assert.equal(slabState(SLAB, true), (SLAB | (4 << 16)) >>> 0);
  assert.equal(stairState(STAIR, '-z', true), (STAIR | (7 << 16)) >>> 0);
  const octants = (state) => shapeOctants(table[state & 0xffff], state);
  // Bit x + 2y + 4z: the lower half is bits 0, 1, 4, 5.
  assert.equal(octants(slabState(SLAB)), 0b00110011);
  assert.equal(octants(slabState(SLAB, true)), 0b11001100);
  // A stair is its slab plus the two octants of the other half on its back side.
  for (const [i, facing] of FACINGS.entries())
    for (const upsideDown of [false, true]) {
      const mask = octants(stairState(STAIR, facing, upsideDown)),
        slab = upsideDown ? 0b11001100 : 0b00110011,
        axis = i < 2 ? 1 : 4,
        high = i % 2 === 0;
      let back = 0;
      for (let k = 0; k < 8; k++) if (!((slab >> k) & 1) && !!(k & axis) === high) back |= 1 << k;
      assert.equal(mask, slab | back, `${facing} ${upsideDown}`);
    }
  assert.equal(octants(STONE), 255);
  assert.equal(octants(FLOWER), 0);
  assert.throws(() => stairState(STAIR, 'up'), TypeError);
  assert.throws(() => slabState(70000), RangeError);
  // Slabs and stairs default to letting light through (their faces decide), like any non-cube.
  assert.equal(table[SLAB].opacity, 0);
  assert.equal(table[STAIR].opacity, 0);
});

// The chunk at 0,0,0 of a world, meshed; cells -1..32 may be set (the shell).
const world = () => new VoxelWorld({ blocks });
const mesh = (w) => meshChunk(meshInput(w, '0,0,0'));
const quads = (m) => {
  const out = [];
  for (const layer of ['opaque', 'cutout', 'translucent'])
    for (let i = 0; i < m[layer].length / 3; i++) out.push({ ...decodeQuad(m[layer], i), layer });
  return out;
};
// Axes (normal, u, v) per face direction, as ChunkMesh describes them.
const AXES = [
  [0, 2, 1],
  [0, 2, 1],
  [1, 0, 2],
  [1, 0, 2],
  [2, 0, 1],
  [2, 0, 1],
];
// The owner (block id) of each material id.
const owners = (() => {
  const ids = blockMaterials(table),
    out = [];
  for (let i = 0; i < ids.length; i++) if (ids[i] !== 0xffff) out[ids[i]] ??= Math.floor(i / 6);
  return out;
})();
// The half-block unit squares a quad covers, as `owner:face:hx,hy,hz` of the half cell behind each (the filled one).
function squares(q) {
  const [n, u, v] = AXES[q.face],
    cell = [q.x, q.y, q.z],
    plus = q.face % 2 === 0,
    plane = plus ? 2 * (cell[n] + 1) - +q.inset : 2 * cell[n] + +q.inset,
    u0 = 2 * cell[u] + (q.trim & 1),
    u1 = 2 * (cell[u] + q.w) - ((q.trim >> 1) & 1),
    v0 = 2 * cell[v] + ((q.trim >> 2) & 1),
    v1 = 2 * (cell[v] + q.h) - ((q.trim >> 3) & 1),
    out = [];
  for (let a = u0; a < u1; a++)
    for (let b = v0; b < v1; b++) {
      const h = [0, 0, 0];
      h[n] = plus ? plane - 1 : plane;
      h[u] = a;
      h[v] = b;
      out.push(`${owners[q.material]}:${q.face}:${h.join(',')}`);
    }
  return out;
}
// What fills half cell (hx, hy, hz): the block state whose box covers it, and the liquid there (a liquid cell's, or a
// waterlogged slab's or stair's in its open part).
function filler(w, hx, hy, hz) {
  const state = w.getBlock(hx >> 1, hy >> 1, hz >> 1),
    type = table[state & 0xffff],
    k = (hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2);
  if (type.shape === 'liquid') return { liquid: state & 0xffff };
  if (type.layer === 'invisible' || type.shape === 'cross') return {};
  if ((shapeOctants(type, state) >> k) & 1) return { block: state };
  return { liquid: type.waterlog && state >>> 31 ? type.waterlog : 0 };
}
// Oracle: every face of a filled half cell of a chunk block whose neighbouring half cell is neither an opaque block's
// nor the same block's, and every face of a liquid's half cell whose neighbour is neither an opaque block's nor the
// same liquid's (sources only: no lowered surfaces), read from the world (so the shell counts).
function exposed(w) {
  const out = new Set(),
    opaque = (state) => state !== undefined && table[state & 0xffff].layer === 'opaque';
  for (let hy = 0; hy < 64; hy++)
    for (let hz = 0; hz < 64; hz++)
      for (let hx = 0; hx < 64; hx++) {
        const here = filler(w, hx, hy, hz);
        if (here.block === undefined && !here.liquid) continue;
        for (let face = 0; face < 6; face++) {
          const h = [hx, hy, hz];
          h[face >> 1] += face % 2 ? -1 : 1;
          const other = filler(w, ...h);
          if (here.block !== undefined) {
            if (
              !(opaque(other.block) || (other.block !== undefined && (other.block & 0xffff) === (here.block & 0xffff)))
            )
              out.add(`${here.block & 0xffff}:${face}:${hx},${hy},${hz}`);
          } else if (!(opaque(other.block) || other.liquid === here.liquid))
            out.add(`${here.liquid}:${face}:${hx},${hy},${hz}`);
        }
      }
  return out;
}
const sameFaces = (w, label) => {
  const got = [];
  for (const q of quads(mesh(w))) if (q.face < 6) got.push(...squares(q));
  const want = exposed(w),
    set = new Set(got);
  assert.equal(set.size, got.length, `${label}: no half-block square is covered twice`);
  const missing = [...want].filter((k) => !set.has(k)),
    extra = got.filter((k) => !want.has(k));
  assert.deepEqual([missing.slice(0, 5), extra.slice(0, 5)], [[], []], `${label}: missing and hidden faces`);
};

test('mesher: one slab and one stair of every state show exactly their outer faces', () => {
  for (const state of SHAPED) {
    const w = world();
    w.setBlock(5, 5, 5, state);
    sameFaces(w, `state ${state.toString(16)}`);
    // A lone bottom slab: a whole bottom face, an inset top face and four half-height sides.
    if (state === SLAB) {
      const q = quads(mesh(w)).sort((a, b) => a.face - b.face);
      assert.deepEqual(
        q.map((x) => [x.face, x.inset, x.trim]),
        [
          [0, false, 8],
          [1, false, 8],
          [2, true, 0],
          [3, false, 0],
          [4, false, 8],
          [5, false, 8],
        ],
      );
    }
  }
});

test('mesher: random mixes of cubes, slabs, stairs and glass match the half-block oracle (culling, merging)', () => {
  const choices = [
    0,
    0,
    0,
    0,
    STONE,
    WATER,
    GLASS,
    slabState(GLASS_SLAB),
    slabState(GLASS_SLAB, true),
    FLOWER,
    ...SHAPED,
  ];
  for (let seed = 1; seed <= 6; seed++) {
    const next = random(seed),
      w = world(),
      edits = [],
      dense = seed % 2 ? 0.9 : 0.35;
    // The chunk and its shell, denser near the floor.
    for (let x = -1; x <= 32; x++)
      for (let y = -1; y <= 32; y++)
        for (let z = -1; z <= 32; z++)
          if (next() < dense * (1 - y / 40)) edits.push(x, y, z, choices[Math.floor(next() * choices.length)]);
    w.setBlocks(edits);
    sameFaces(w, `seed ${seed}`);
  }
});

test('mesher: slabs beside, under and over cubes hide exactly the covered part of each face', () => {
  const w = world();
  w.setBlock(4, 4, 4, STONE);
  w.setBlock(5, 4, 4, slabState(SLAB)); // beside: the cube's +x face keeps its upper half
  w.setBlock(4, 3, 4, slabState(SLAB, true)); // under, as a top slab: the cube's bottom is hidden
  w.setBlock(4, 5, 4, slabState(SLAB)); // over, as a bottom slab: the cube's top is hidden
  sameFaces(w, 'neighbours');
  const cube = quads(mesh(w)).filter((q) => q.x === 4 && q.y === 4 && q.z === 4);
  assert.deepEqual(
    cube.map((q) => [q.face, q.trim]).sort((a, b) => a[0] - b[0]),
    [
      [0, 4], // +x: only the upper half (v starts half a block up)
      [1, 0],
      [4, 0],
      [5, 0],
    ],
  );
});

test('mesher: slab floors merge into one top, one bottom and one quad per side', () => {
  const w = world(),
    edits = [];
  for (let x = 2; x < 10; x++) for (let z = 3; z < 9; z++) edits.push(x, 7, z, slabState(SLAB));
  w.setBlocks(edits);
  const q = quads(mesh(w));
  assert.equal(q.length, 6);
  const top = q.find((x) => x.face === 2);
  assert.deepEqual([top.inset, top.w, top.h, top.x, top.z], [true, 8, 6, 2, 3]);
  // Its centre for translucent sorting is half a block below the cell top.
  const centers = quadCenters(Uint32Array.of(...[0, 1, 2].map((k) => mesh(w).opaque[q.indexOf(top) * 3 + k])));
  assert.deepEqual([...centers], [6, 7.5, 6]);
});

test('mesher: AO darkens a stair step where it meets its riser; light comes from the open part', () => {
  const w = world();
  w.setBlock(6, 6, 6, stairState(STAIR, '+x'));
  const step = quads(mesh(w)).find((q) => q.face === 2 && q.inset);
  // The step covers x 6..6.5: its corners at x 6.5 (1 and 2) touch the riser.
  assert.deepEqual([step.trim, step.ao], [2, [3, 2, 2, 3]]);
  // Lit: a stair in open sky gets full sky light, and its step reads it.
  const lit = world(),
    lighting = VoxelLighting.attach(lit, { budget: Infinity });
  for (let x = -1; x <= 32; x++) for (let z = -1; z <= 32; z++) lit.setBlock(x, 0, z, STONE);
  lit.setBlock(6, 1, 6, stairState(STAIR, '+x'));
  lighting.update();
  assert.equal(lighting.skyLight(6, 1, 6), 15);
  const litStep = quads(mesh(lit)).find((q) => q.face === 2 && q.inset);
  assert.deepEqual(litStep.sky, [15, 15, 15, 15]);
  lighting.dispose();
});

test('raycast: slabs and stairs are hit on their boxes, with the face and point there', () => {
  const w = world();
  w.setBlock(3, 2, 3, slabState(SLAB));
  w.setBlock(6, 2, 3, stairState(STAIR, '+x'));
  w.setBlock(9, 2, 3, slabState(SLAB, true));
  // Down onto the bottom slab: its top, half a block into the cell.
  let hit = raycastVoxels(w, [3.5, 10, 3.5], [0, -1, 0], 20);
  assert.deepEqual([hit.cell, hit.normal, hit.point, hit.distance], [[3, 2, 3], [0, 1, 0], [3.5, 2.5, 3.5], 7.5]);
  assert.deepEqual(hit.adjacent, [3, 3, 3]);
  // Sideways through the slab's open upper half: missed, the next block is hit.
  w.setBlock(5, 2, 3, STONE);
  hit = raycastVoxels(w, [0, 2.75, 3.5], [1, 0, 0], 20);
  assert.deepEqual(
    [hit.cell, hit.normal],
    [
      [5, 2, 3],
      [-1, 0, 0],
    ],
  );
  // Along the stair from -x at riser height: its riser, at x 6.5.
  w.setBlock(5, 2, 3, 0);
  hit = raycastVoxels(w, [4, 2.75, 3.5], [1, 0, 0], 20);
  assert.deepEqual(
    [hit.cell, hit.normal, hit.point],
    [
      [6, 2, 3],
      [-1, 0, 0],
      [6.5, 2.75, 3.5],
    ],
  );
  // Its step from above, then up into the top slab's underside.
  hit = raycastVoxels(w, [6.25, 9, 3.5], [0, -1, 0], 20);
  assert.deepEqual(
    [hit.normal, hit.point],
    [
      [0, 1, 0],
      [6.25, 2.5, 3.5],
    ],
  );
  hit = raycastVoxels(w, [9.5, 0, 3.5], [0, 1, 0], 20);
  assert.deepEqual(
    [hit.cell, hit.normal, hit.point],
    [
      [9, 2, 3],
      [0, -1, 0],
      [9.5, 2.5, 3.5],
    ],
  );
  // A diagonal ray crossing the cell over the slab's top misses it.
  assert.equal(raycastVoxels(w, [2.9, 2.9, 3.5], [1, -0.2, 0], 1.1), null);
});

test('sweepBox and VoxelCharacter: boxes land on slab tops and walk up stairs', () => {
  const w = world(),
    edits = [];
  for (let x = 0; x < 16; x++) for (let z = 0; z < 8; z++) edits.push(x, 0, z, STONE);
  w.setBlocks(edits);
  w.setBlock(2, 1, 2, slabState(SLAB));
  // A box falling onto the slab stops on its top at y 1.5.
  let r = sweepBox(w, { min: { x: 2.2, y: 4, z: 2.2 }, max: { x: 2.8, y: 5, z: 2.8 } }, [0, -10, 0]);
  assert.deepEqual([r.position[1], r.hit[1], r.onGround], [1.5, true, true]);
  // Resting on it: grounded with no motion.
  r = sweepBox(w, { min: { x: 2.2, y: 1.5, z: 2.2 }, max: { x: 2.8, y: 2.5, z: 2.8 } }, [0, 0, 0]);
  assert.equal(r.onGround, true);
  // A box inside the slab's open upper half moves sideways out of it freely; one at slab height is stopped.
  r = sweepBox(w, { min: { x: 1.2, y: 1.6, z: 2.2 }, max: { x: 1.8, y: 2.6, z: 2.8 } }, [2, 0, 0]);
  assert.deepEqual([r.position[0], r.hit[0]], [3.2, false]);
  r = sweepBox(w, { min: { x: 1.2, y: 1.1, z: 2.2 }, max: { x: 1.8, y: 1.4, z: 2.8 } }, [2, 0, 0]);
  assert.deepEqual([r.position[0], r.hit[0]], [1.4, true]);
  // A box placed inside a cube can still leave it.
  w.setBlock(2, 1, 2, STONE);
  r = sweepBox(w, { min: { x: 2.2, y: 1.2, z: 2.2 }, max: { x: 2.8, y: 1.8, z: 2.8 } }, [0, 2, 0]);
  assert.deepEqual([r.position[1], r.hit[1]], [3.2, false]);
  // A staircase of stairs, each a block higher: the character walks to the top.
  const stairs = world(),
    cells = [];
  for (let x = 0; x < 20; x++) for (let z = 0; z < 6; z++) cells.push(x, 0, z, STONE);
  for (let i = 0; i < 4; i++)
    for (let z = 0; z < 6; z++) {
      for (let y = 1; y < 1 + i; y++) cells.push(4 + i, y, z, STONE);
      cells.push(4 + i, 1 + i, z, stairState(STAIR, '+x'));
    }
  for (let x = 8; x < 20; x++) for (let z = 0; z < 6; z++) for (let y = 1; y <= 4; y++) cells.push(x, y, z, STONE);
  stairs.setBlocks(cells);
  const player = new VoxelCharacter(stairs, { stepHeight: 0.6 });
  player.position = [1.5, 1, 3];
  for (let i = 0; i < 180; i++) player.update(1 / 60, { direction: [1, 0, 0] });
  assert.ok(player.position[0] > 9 && Math.abs(player.position[1] - 5) < 1e-9, `climbed to (${player.position})`);
  // A full-block step of 1 is too tall for the same character.
  const wall = world();
  wall.setBlocks(cells.map((v, i) => (i % 4 === 3 && v === stairState(STAIR, '+x') ? STONE : v)));
  const blocked = new VoxelCharacter(wall, { stepHeight: 0.6 });
  blocked.position = [1.5, 1, 3];
  for (let i = 0; i < 180; i++) blocked.update(1 / 60, { direction: [1, 0, 0] });
  assert.ok(blocked.position[0] < 4, `stopped at the first full step (${blocked.position})`);
});

test('light passes through the open part of slabs and stairs, not through faces they cover', () => {
  // A sealed stone room with a one-cell opening in its roof; the opening holds a slab or stair.
  const room = (state) => {
    const w = new VoxelWorld({ blocks }),
      edits = [];
    for (let x = 0; x < 12; x++)
      for (let y = 0; y < 8; y++)
        for (let z = 0; z < 12; z++) {
          const wall = x === 0 || x === 11 || y === 0 || y === 7 || z === 0 || z === 11;
          if (wall) edits.push(x, y, z, STONE);
        }
    w.setBlocks(edits);
    w.setBlock(5, 7, 5, state);
    const lighting = VoxelLighting.attach(w, { budget: Infinity });
    lighting.update();
    return { w, lighting };
  };
  // An open hole lets sky light in.
  let { lighting, w } = room(0);
  assert.equal(lighting.skyLight(5, 6, 5), 15);
  lighting.dispose();
  // A bottom slab closes it: its bottom is covered whole. The slab itself is lit as open sky.
  ({ lighting, w } = room(slabState(SLAB)));
  assert.equal(lighting.skyLight(5, 6, 5), 0);
  assert.equal(lighting.skyLight(5, 7, 5), 15);
  // A top slab keeps the room dark, and its covered top keeps the sky out of the slab itself.
  w.setBlock(5, 7, 5, slabState(SLAB, true));
  lighting.update();
  assert.equal(lighting.skyLight(5, 6, 5), 0);
  assert.equal(lighting.skyLight(5, 7, 5), 0);
  // Removing it opens the room again.
  w.setBlock(5, 7, 5, 0);
  lighting.update();
  assert.equal(lighting.skyLight(5, 6, 5), 15);
  lighting.dispose();
  // Sideways: a torch beside a slab wall shines over it (through its open upper half) but a stair's back blocks it.
  const side = (state) => {
    const v = new VoxelWorld({ blocks }),
      edits = [];
    for (let x = 0; x < 9; x++) for (let z = 0; z < 3; z++) for (let y = 0; y < 4; y++) edits.push(x, y, z, STONE);
    for (let x = 1; x < 8; x++) edits.push(x, 1, 1, 0); // a one-cell tunnel along x at y 1
    v.setBlocks(edits);
    v.setBlock(1, 1, 1, TORCH);
    v.setBlock(4, 1, 1, state);
    const l = VoxelLighting.attach(v, { budget: Infinity });
    l.update();
    const beyond = l.blockLight(5, 1, 1);
    l.dispose();
    return beyond;
  };
  assert.equal(side(0), 10); // 14 at the torch, 4 steps
  assert.equal(side(slabState(SLAB)), 10); // through the slab's open upper half
  assert.equal(side(stairState(STAIR, '+x')), 0); // the stair's back faces +x: covered whole
  assert.equal(side(stairState(STAIR, '-x')), 0); // its back faces the torch
  assert.equal(side(stairState(STAIR, '+z')), 10); // sideways: the L-shaped side leaves a quarter open
  assert.equal(side(STONE), 0);
});

test('formats: slab and stair states survive the chunk and block-change codecs', async () => {
  const w = world();
  for (const [i, state] of SHAPED.entries()) w.setBlock(i & 31, 3 + (i >> 5), 7, state);
  const chunk = w.getChunk(0, 0, 0),
    back = await decodeChunk(await encodeChunk(chunk));
  for (const [i, state] of SHAPED.entries()) assert.equal(back.get(i & 31, 3 + (i >> 5), 7), state);
  const changes = SHAPED.flatMap((state, i) => [i, 1, 2, state]),
    decoded = decodeBlockChanges(encodeBlockChanges(changes));
  assert.deepEqual(
    [...decoded].map((v, i) => (i % 4 === 3 ? v >>> 0 : v)),
    changes,
  );
});

test('stair corners: octants of inner and outer corners, explicit corners and their errors', () => {
  const octants = (state) => shapeOctants(table[state & 0xffff], state);
  // Facing +x: the back's upper octants are bits 3 and 7 (x high); the lower slab 0x33.
  assert.equal(octants(stairState(STAIR, '+x')), 0x33 | 0x88);
  // Inner +z: the whole back and the front quarter on +z (x low, y high, z high: bit 6).
  assert.equal(octants(stairState(STAIR, '+x', false, 'inner+z')), 0x33 | 0x88 | 0x40);
  // Outer +z: only the back quarter on +z (bit 7); outer -z: only bit 3.
  assert.equal(octants(stairState(STAIR, '+x', false, 'outer+z')), 0x33 | 0x80);
  assert.equal(octants(stairState(STAIR, '+x', false, 'outer-z')), 0x33 | 0x08);
  // Upside down: the slab on top, the corner below.
  assert.equal(octants(stairState(STAIR, '-z', true, 'outer-x')), 0xcc | 0x01);
  // A straight corner given by hand is a different state (kept by connectStairs) with the same octants.
  assert.notEqual(stairState(STAIR, '+x', false, 'straight'), stairState(STAIR, '+x'));
  assert.equal(octants(stairState(STAIR, '+x', false, 'straight')), octants(stairState(STAIR, '+x')));
  assert.throws(() => stairState(STAIR, '+x', false, 'inner+x'), TypeError);
  assert.throws(() => stairState(STAIR, '+z', false, 'outer+z'), TypeError);
  assert.throws(() => stairState(STAIR, '+z', false, 'sideways'), TypeError);
  // Double slabs fill the cell; waterlogging changes no octants.
  assert.equal(octants(doubleSlabState(SLAB)), 255);
  assert.equal(octants(waterlogState(stairState(STAIR, '-x'))), octants(stairState(STAIR, '-x')));
  assert.equal(waterlogState(waterlogState(SLAB), false), SLAB);
  assert.throws(() => waterlogState(-1), RangeError);
  assert.throws(() => blocks.define('wet-stone', { waterlog: WATER }), TypeError);
  assert.throws(() => blocks.define('wet-slab', { shape: 'slab', waterlog: STONE }), RangeError);
  assert.throws(() => blocks.define('wet-slab2', { shape: 'slab', waterlog: 'lava' }), RangeError);
});

test('connectStairs: outer corners toward a stair behind, inner toward one in front; hand-set corners stay', () => {
  const w = world(),
    corner = (x, z) => (w.getBlock(x, 4, z) >>> 16) & 0x7f;
  // An L: a stair facing +x with, behind it (+x), a stair facing +z. The first becomes an outer corner toward +z.
  w.setBlock(5, 4, 5, stairState(STAIR, '+x'));
  w.setBlock(6, 4, 5, stairState(STAIR, '+z'));
  connectStairs(w, 6, 4, 5); // from the second stair's cell: its neighbours are reconnected too
  assert.equal(corner(5, 5), (2 << 3) | 32);
  assert.equal(
    shapeOctants(table[STAIR], w.getBlock(5, 4, 5)),
    shapeOctants(table[STAIR], stairState(STAIR, '+x', false, 'outer+z')),
  );
  assert.equal(corner(6, 5), 2); // the +z stair stays straight
  // A stair whose front (-x) meets a stair facing -z becomes an inner corner toward -z.
  w.setBlock(10, 4, 5, stairState(STAIR, '+x'));
  w.setBlock(9, 4, 5, stairState(STAIR, '-z'));
  connectStairs(w, 9, 4, 5);
  assert.equal(corner(10, 5), 1 << 3);
  // Different halves do not connect.
  w.setBlock(9, 4, 5, stairState(STAIR, '-z', true));
  connectStairs(w, 9, 4, 5);
  assert.equal(corner(10, 5), 0);
  // A corner set by hand is kept.
  w.setBlock(5, 4, 5, stairState(STAIR, '+x', false, 'straight'));
  connectStairs(w, 5, 4, 5);
  assert.equal(corner(5, 5), 64);
  // A ring of stairs round a column, backs inward, with stairs in the corner cells: those become corners, meshed and
  // picked as their boxes.
  const ring = world(),
    corners = [
      [19, 19],
      [21, 19],
      [19, 21],
      [21, 21],
    ];
  ring.setBlock(20, 4, 20, STONE);
  ring.setBlocks([19, 4, 20, stairState(STAIR, '+x'), 21, 4, 20, stairState(STAIR, '-x')]);
  ring.setBlocks([20, 4, 19, stairState(STAIR, '+z'), 20, 4, 21, stairState(STAIR, '-z')]);
  for (const [x, z] of corners) ring.setBlock(x, 4, z, stairState(STAIR, z < 20 ? '+z' : '-z'));
  for (let x = 19; x <= 21; x++) for (let z = 19; z <= 21; z++) connectStairs(ring, x, 4, z);
  sameFaces(ring, 'stair ring');
  assert.ok(
    corners.every(([x, z]) => (ring.getBlock(x, 4, z) >>> 19) & 3),
    'the corner cells are corners',
  );
  const hit = raycastVoxels(ring, [19.25, 9, 19.25], [0, -1, 0], 20);
  assert.ok(hit.point[1] === 4.5 || hit.point[1] === 5, `hit at ${hit.point}`);
});

test('double slabs act as whole blocks for meshing, picking and sweeps', () => {
  const w = world();
  w.setBlock(3, 2, 3, doubleSlabState(SLAB));
  const hit = raycastVoxels(w, [3.5, 10, 3.5], [0, -1, 0], 20);
  assert.deepEqual([hit.normal, hit.point[1]], [[0, 1, 0], 3]);
  const r = sweepBox(w, { min: { x: 3.2, y: 6, z: 3.2 }, max: { x: 3.8, y: 7, z: 3.8 } }, [0, -10, 0]);
  assert.equal(r.position[1], 3);
  sameFaces(w, 'double slab');
  assert.equal(quads(mesh(w)).length, 6);
});

test('waterlogging: the liquid fills the open part for meshing, light and swimming; the block still collides', () => {
  // A waterlogged bottom slab in a pool: no water faces in it but the surface; its inset top shows under the water.
  const w = world(),
    edits = [];
  for (let x = 2; x < 7; x++) for (let z = 2; z < 7; z++) edits.push(x, 3, z, WATER);
  w.setBlocks(edits);
  w.setBlock(4, 3, 4, waterlogState(slabState(SLAB)));
  sameFaces(w, 'pool');
  const q = quads(mesh(w)),
    inCell = q.filter((x) => x.x === 4 && x.y === 3 && x.z === 4);
  assert.ok(inCell.some((x) => owners[x.material] === SLAB && x.face === 2 && x.inset));
  assert.ok(!inCell.some((x) => owners[x.material] === WATER && x.face !== 2 && x.face !== 3));
  // The surface: the pool's water on its cell side, the slab cell's water too (one wave quad kind, merged per row).
  const surface = q.filter((x) => owners[x.material] === WATER && x.face === 2);
  assert.ok(surface.every((x) => x.wave && !x.inset));
  assert.equal(
    surface.reduce((n, x) => n + x.w * x.h, 0),
    25,
  );
  // Lowered water beside a top slab shows only its side under the slab (the shader cuts it at the water line).
  const low = world();
  low.setBlock(4, 3, 4, (WATER | (5 << 16)) >>> 0);
  low.setBlock(5, 3, 4, slabState(SLAB, true));
  const side = quads(mesh(low)).find((x) => owners[x.material] === WATER && x.face === 0);
  assert.deepEqual([side.trim, side.liquidDrop], [8, 5]);
  // Light: a waterlogged slab costs the water's opacity (2) on top of the step.
  const tunnel = (state) => {
    const v = new VoxelWorld({ blocks }),
      cells = [];
    for (let x = 0; x < 9; x++) for (let z = 0; z < 3; z++) for (let y = 0; y < 4; y++) cells.push(x, y, z, STONE);
    for (let x = 1; x < 8; x++) cells.push(x, 1, 1, 0);
    v.setBlocks(cells);
    v.setBlock(1, 1, 1, TORCH);
    v.setBlock(4, 1, 1, state);
    const l = VoxelLighting.attach(v, { budget: Infinity });
    l.update();
    const before = l.blockLight(5, 1, 1);
    v.setBlock(4, 1, 1, waterlogState(state));
    l.update();
    const after = l.blockLight(5, 1, 1);
    l.dispose();
    return [before, after];
  };
  assert.deepEqual(tunnel(slabState(SLAB)), [10, 8]);
  // A character in a waterlogged cell swims; the slab still holds it up.
  const pool = world(),
    floor = [];
  for (let x = 0; x < 8; x++)
    for (let z = 0; z < 8; z++) floor.push(x, 0, z, STONE, x, 1, z, waterlogState(slabState(SLAB)));
  pool.setBlocks(floor);
  const swimmer = new VoxelCharacter(pool);
  swimmer.position = [4, 1.5, 4];
  swimmer.update(1 / 60);
  assert.equal(swimmer.inLiquid, true);
  for (let i = 0; i < 60; i++) swimmer.update(1 / 60);
  assert.ok(swimmer.position[1] >= 1.5 - 1e-9, `stands on the slab (${swimmer.position[1]})`);
});
