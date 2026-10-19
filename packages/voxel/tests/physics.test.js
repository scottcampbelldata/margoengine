// VoxelPhysics against the real Rapier (the monorepo installs it for the physics package's tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Physics } from '@margoengine/physics';
import { BlockTypes, VoxelChunk, VoxelWorld } from '../dist/index.js';
import { VoxelPhysics } from '../dist/physics.js';

const rapierDir = process.env.MARGOENGINE_RAPIER
  ? resolve(process.env.MARGOENGINE_RAPIER)
  : fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d-compat/', import.meta.url));
const rapierEntry = resolve(rapierDir, 'dist/rapier.mjs');
let RAPIER = null;
if (existsSync(rapierEntry)) {
  RAPIER = (await import(pathToFileURL(rapierEntry).href)).default;
  const warn = console.warn;
  console.warn = () => {}; // the wasm-bindgen init() deprecation notice
  await RAPIER.init();
  console.warn = warn;
}
const skip = RAPIER ? false : 'Rapier not found: set MARGOENGINE_RAPIER to a @dimforge/rapier3d-compat folder';
const rtest = (name, fn) => test(name, { skip }, fn);

// Rapier calls counted, to tell in-place updates (setVoxel) from rebuilds (ColliderDesc.voxels).
const calls = { builds: 0, setVoxel: 0, propagate: 0, combine: 0 };
if (RAPIER) {
  const count = (owner, name, counter) => {
    const original = owner[name];
    owner[name] = function (...args) {
      calls[counter]++;
      return original.apply(this, args);
    };
  };
  count(RAPIER.ColliderDesc, 'voxels', 'builds');
  count(RAPIER.Collider.prototype, 'setVoxel', 'setVoxel');
  count(RAPIER.Collider.prototype, 'propagateVoxelChange', 'propagate');
  count(RAPIER.Collider.prototype, 'combineVoxelStates', 'combine');
}
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const blocks = new BlockTypes(),
  stone = blocks.define('stone'),
  dirt = blocks.define('dirt'),
  flower = blocks.define('flower', { shape: 'cross', layer: 'cutout', solid: false });
const setup = (options, gravity = [0, -9.81, 0]) => {
  const physics = new Physics(null, { rapier: RAPIER, gravity }),
    world = new VoxelWorld({ blocks }),
    voxels = new VoxelPhysics(physics, world, options);
  return { physics, world, voxels };
};
// Sets every cell of the box [x0, x1) x [y0, y1) x [z0, z1).
const fill = (world, x0, x1, y0, y1, z0, z1, state) => {
  const edits = [];
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) edits.push(x, y, z, state);
  world.setBlocks(edits);
};
const keys = (voxels) => [...voxels.colliders.keys()].sort();
const steps = (physics, n) => {
  for (let i = 0; i < n; i++) physics.step();
};
// A frictionless cube: it slides at constant speed unless a seam catches it.
const cube = (physics, half, position, velocity) =>
  physics.addBody(null, {
    position,
    linearVelocity: velocity,
    canSleep: false,
    colliders: { shape: 'box', halfExtents: [half, half, half], friction: 0, frictionCombine: 'min' },
  });

rtest('a ball rests on a voxel floor, keeps it while asleep and falls once the block under it is removed', () => {
  const { physics, world, voxels } = setup();
  fill(world, 0, 8, 0, 1, 0, 8, stone);
  const ball = physics.addBody(null, { position: [4.5, 3, 4.5], colliders: { shape: 'sphere', radius: 0.4 } });
  steps(physics, 240);
  assert.ok(Math.abs(ball.position[1] - 1.4) < 0.01, `rests on the floor top (y ${ball.position[1]})`);
  assert.ok(ball.sleeping, 'falls asleep on the floor');
  steps(physics, 10);
  assert.deepEqual(keys(voxels), ['0,0,0'], 'a sleeping body keeps its chunk collider');
  const builds = calls.builds;
  world.setBlock(4, 0, 4, 0);
  steps(physics, 60);
  assert.ok(ball.position[1] < -1, `falls through the hole (y ${ball.position[1]})`);
  assert.equal(calls.builds, builds, 'the edit changed the collider in place');
  physics.dispose();
});

rtest('cubes slide across chunk borders without snagging (seeded)', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const next = random(seed),
      { physics, world } = setup();
    // A 3-cell thick floor over chunks x 0..1 and z -1..0 (and y -1..0: its top layer is y 0).
    fill(world, 0, 64, -2, 1, -16, 16, stone);
    const half = 0.3 + next() * 0.2,
      v = [3 + next() * 6, 0, (next() - 0.5) * 3],
      body = cube(physics, half, [27, 1 + half + 0.002, (next() - 0.5) * 6], v);
    let bump = 0,
      spin = 0;
    for (let i = 0; i < 150 && body.position[0] < 40; i++) {
      physics.step();
      if (i > 3) {
        bump = Math.max(bump, Math.abs(body.linearVelocity[1]));
        spin = Math.max(spin, Math.hypot(...body.angularVelocity));
      }
    }
    assert.ok(body.position[0] > 34, `seed ${seed}: crossed the border (x ${body.position[0]})`);
    assert.ok(bump < 0.05, `seed ${seed}: no vertical kick at the seam (|vy| ${bump})`);
    assert.ok(spin < 0.05, `seed ${seed}: no tumble at the seam (|w| ${spin})`);
    assert.ok(Math.abs(body.linearVelocity[0] - v[0]) < 0.01 * v[0], `seed ${seed}: kept its speed`);
    physics.dispose();
  }
});

rtest('an edit on a chunk border keeps the seam smooth (propagateVoxelChange)', () => {
  const { physics, world } = setup();
  fill(world, 0, 64, 0, 1, 0, 16, stone);
  fill(world, 31, 32, 0, 1, 0, 16, 0); // a gap in the last column of chunk 0
  const anchor = physics.addBody(null, { type: 'kinematicPosition', position: [32, 8, 8], colliders: [] });
  physics.step();
  const builds = calls.builds,
    propagated = calls.propagate;
  fill(world, 31, 32, 0, 1, 0, 16, stone); // filled again: chunk 0's border cells next to chunk 1's
  assert.ok(calls.propagate >= propagated + 16, 'border edits propagate to the neighbour chunk');
  const body = cube(physics, 0.4, [26, 1.402, 8.3], [6, 0, 0]);
  let bump = 0;
  for (let i = 0; i < 120 && body.position[0] < 38; i++) {
    physics.step();
    if (i > 3) bump = Math.max(bump, Math.abs(body.linearVelocity[1]), Math.hypot(...body.angularVelocity));
  }
  assert.ok(body.position[0] > 36 && bump < 0.05, `slid over the edited seam (x ${body.position[0]}, bump ${bump})`);
  assert.equal(calls.builds, builds, 'no collider was rebuilt');
  anchor.remove();
  physics.dispose();
});

rtest('colliders follow the radius rule: near moving bodies, loaded chunks only', () => {
  const { physics, world, voxels } = setup({}, [0, 0, 0]);
  for (let cx = -3; cx <= 3; cx++) fill(world, cx * 32, cx * 32 + 32, 0, 1, 0, 32, stone);
  const body = physics.addBody(null, {
    position: [16, 16, 16],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  physics.step();
  assert.deepEqual(keys(voxels), ['-1,0,0', '0,0,0', '1,0,0'], 'the body chunk and its loaded neighbours');
  assert.equal(physics.world.colliders.len(), 4, 'three chunk colliders and the body');
  body.setPosition([3 * 32 + 16, 16, 16]);
  physics.step();
  assert.deepEqual(keys(voxels), ['2,0,0', '3,0,0'], 'moved with the body; chunk 4 is not loaded');
  const other = physics.addBody(null, { type: 'kinematicPosition', position: [-3 * 32 + 5, 5, 5], colliders: [] });
  physics.step();
  assert.deepEqual(keys(voxels), ['-2,0,0', '-3,0,0', '2,0,0', '3,0,0'], 'kinematic bodies count too');
  world.removeChunk(3, 0, 0);
  physics.step();
  assert.deepEqual(keys(voxels), ['-2,0,0', '-3,0,0', '2,0,0'], 'an unloaded chunk loses its collider');
  const builds = calls.builds;
  fill(world, 96, 128, 0, 1, 0, 32, dirt); // loads it again
  physics.step();
  assert.ok(voxels.colliders.has('3,0,0') && calls.builds === builds + 1, 'a reloaded chunk gets one again');
  body.remove();
  other.remove();
  physics.addBody(null, { type: 'fixed', position: [16, 16, 16], colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  physics.step();
  assert.equal(voxels.colliders.size, 0, 'fixed bodies do not count; no moving body, no colliders');
  assert.equal(physics.world.colliders.len(), 1);
  physics.dispose();
  const wide = setup({ radius: 2 }, [0, 0, 0]);
  for (let cx = -3; cx <= 3; cx++) fill(wide.world, cx * 32, cx * 32 + 32, 0, 1, 0, 32, stone);
  wide.physics.addBody(null, { position: [16, 16, 16], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  wide.physics.step();
  assert.deepEqual(keys(wide.voxels), ['-1,0,0', '-2,0,0', '0,0,0', '1,0,0', '2,0,0'], 'radius 2');
  wide.physics.dispose();
});

rtest('a chunk that comes back after edits made out of range leaves no stale seam', () => {
  const { physics, world, voxels } = setup();
  fill(world, 0, 96, -1, 0, 0, 16, stone); // floor, top at y 0
  fill(world, 30, 34, 0, 1, 0, 16, stone); // a wall across the chunk border x 32
  const body = cube(physics, 0.4, [20, 0.402, 8.3], [0, 0, 0]);
  physics.step();
  body.setPosition([2 * 32 + 16, 0.402, 8.3]); // away: chunk 0 drops out of range, chunk 1 stays
  physics.step();
  assert.deepEqual(keys(voxels), ['1,-1,0', '1,0,0', '2,-1,0']);
  fill(world, 30, 32, 0, 1, 0, 16, 0); // chunk 0's half of the wall goes while it has no collider
  const builds = calls.builds;
  body.setPosition([20, 0.402, 8.3]);
  body.setLinearVelocity([6, 0, 0]);
  physics.step();
  assert.ok(calls.builds >= builds + 3, 'chunk 0 is built and chunk 1 rebuilt beside it');
  let reach = 0,
    lift = 0;
  for (let i = 0; i < 150; i++) {
    physics.step();
    reach = Math.max(reach, body.position[0]);
    lift = Math.max(lift, Math.abs(body.position[1] - 0.4));
  }
  assert.ok(
    reach > 31.5 && reach < 31.62 && lift < 0.02,
    `stopped by the wall face x 32 (reach ${reach}, lift ${lift})`,
  );
  physics.dispose();
});

rtest('edits update colliders in place and match the world (ray oracle, seeded)', () => {
  const next = random(7),
    { physics, world, voxels } = setup({}, [0, 0, 0]);
  const height = (x, z) => 6 + Math.floor(8 + 7 * Math.sin(x * 0.21) * Math.cos(z * 0.17));
  const edits = [];
  for (let x = -32; x < 64; x++)
    for (let z = -32; z < 64; z++)
      for (let y = 0; y < height(x, z); y++) edits.push(x, y, z, y > 9 && (x + z) % 3 ? dirt : stone);
  world.setBlocks(edits);
  physics.addBody(null, { type: 'kinematicPosition', position: [16, 16, 16], colliders: [] });
  const builds = calls.builds;
  physics.step();
  assert.equal(voxels.colliders.size, 9);
  assert.equal(calls.builds, builds + 9, 'one build per chunk');
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    solid = (x, y, z) => blocks.get(world.getBlock(x, y, z) & 0xffff).solid;
  // Every ray from outside the 3 x 1 x 3 chunks must hit the first solid cell the world has on its line.
  const check = (label) => {
    physics.step();
    let rays = 0;
    const cast = (origin, dir, expected) => {
      ray.origin = { x: origin[0], y: origin[1], z: origin[2] };
      ray.dir = { x: dir[0], y: dir[1], z: dir[2] };
      const hit = physics.world.castRay(ray, 200, true),
        got = hit ? hit.timeOfImpact : null;
      rays++;
      if (expected === null ? got !== null : got === null || Math.abs(got - expected) > 1e-3)
        assert.fail(`${label}: ray from ${origin} along ${dir} hit ${got}, expected ${expected}`);
    };
    for (let x = -32; x < 64; x++)
      for (let z = -32; z < 64; z++) {
        let y = 31;
        while (y >= 0 && !solid(x, y, z)) y--;
        cast([x + 0.5, 40, z + 0.5], [0, -1, 0], y < 0 ? null : 40 - (y + 1));
      }
    for (let y = 0; y < 32; y += 3)
      for (let z = -32; z < 64; z += 5) {
        let x = -32;
        while (x < 64 && !solid(x, y, z)) x++;
        cast([-40, y + 0.5, z + 0.5], [1, 0, 0], x === 64 ? null : x + 40);
        x = 63;
        while (x >= -32 && !solid(x, y, z)) x--;
        cast([70, y + 0.5, z + 0.5], [-1, 0, 0], x < -32 ? null : 70 - (x + 1));
      }
    return rays;
  };
  check('before edits');
  const before = { ...calls };
  let flips = 0;
  for (let i = 0; i < 600; i++) {
    const cell = [-32 + Math.floor(next() * 96), Math.floor(next() * 24), -32 + Math.floor(next() * 96)];
    if (next() < 0.5) cell[next() < 0.5 ? 0 : 2] = [-1, 0, 31, 32][Math.floor(next() * 4)]; // chunk borders
    const state = [0, stone, dirt, flower][Math.floor(next() * 4)],
      was = world.getBlock(...cell);
    if (blocks.get(state).solid !== blocks.get(was & 0xffff).solid) flips++;
    world.setBlock(...cell, state);
  }
  const rays = check('after 600 edits'),
    updates = calls.setVoxel - before.setVoxel;
  assert.equal(calls.builds, before.builds, 'no rebuilds');
  assert.ok(flips > 200 && updates >= flips, `${updates} setVoxel calls for ${flips} solidity flips`);
  world.setBlock(-30, 0, -30, 0);
  const kept = calls.setVoxel;
  world.setBlock(-30, 0, -30, stone); // air -> stone: one setVoxel
  world.setBlock(-30, 0, -30, dirt); // stone -> dirt: still solid
  world.setBlock(-30, 30, -30, flower); // air -> flower: still not solid
  assert.equal(calls.setVoxel, kept + 1, 'only the solidity change touched the collider');
  assert.ok(rays > 9000);
  physics.dispose();
});

rtest('dispose removes every collider and stops following edits and steps', () => {
  const { physics, world, voxels } = setup();
  fill(world, -40, 40, 0, 1, -8, 8, stone);
  physics.addBody(null, { position: [0.5, 1.6, 0.5], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  physics.step();
  assert.equal(physics.world.colliders.len(), 1 + voxels.colliders.size);
  voxels.dispose();
  assert.equal(voxels.colliders.size, 0);
  assert.equal(physics.world.colliders.len(), 1, 'only the body collider is left');
  const before = { ...calls };
  world.setBlock(3, 0, 3, 0);
  physics.step();
  assert.deepEqual(calls, before, 'no setVoxel, no rebuild after dispose');
  voxels.dispose();
  // Physics disposed first: later edits must not touch the freed colliders.
  const second = setup();
  fill(second.world, 0, 8, 0, 1, 0, 8, stone);
  second.physics.addBody(null, { position: [4, 2, 4], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  second.physics.step();
  second.physics.dispose();
  second.world.setBlock(4, 0, 4, 0);
  second.voxels[Symbol.dispose]();
  physics.dispose();
});

rtest('arguments and an old Rapier are rejected with clear errors', () => {
  const physics = new Physics(null, { rapier: RAPIER }),
    world = new VoxelWorld({ blocks });
  assert.throws(() => new VoxelPhysics({}, world), TypeError);
  assert.throws(() => new VoxelPhysics(physics, {}), TypeError);
  assert.throws(() => new VoxelPhysics(physics, world, { radius: 0 }), RangeError);
  assert.throws(() => new VoxelPhysics(physics, world, { radius: 1.5 }), RangeError);
  assert.throws(() => new VoxelPhysics(physics, world, { radius: '1' }), TypeError);
  const old = new Physics(null, { rapier: { ...RAPIER, ColliderDesc: { cuboid: RAPIER.ColliderDesc.cuboid } } });
  assert.throws(() => new VoxelPhysics(old, world), { name: 'MargoError', code: 'unsupported' });
  old.dispose();
  physics.dispose();
  assert.throws(() => new VoxelPhysics(physics, world), { name: 'MargoError', code: 'disposed' });
});

rtest('benchmark: collider builds and edit updates (printed)', (t) => {
  // One chunk alone in its world, built by the first step (Rapier's ColliderDesc.voxels included); best of 3.
  const single = (make) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const { physics, world } = setup({}, [0, 0, 0]);
      world.addChunk(0, 0, 0, make());
      physics.addBody(null, { type: 'kinematicPosition', position: [16, 16, 16], colliders: [] });
      const start = performance.now();
      physics.step();
      best = Math.min(best, performance.now() - start);
      physics.dispose();
    }
    return best.toFixed(2);
  };
  const next = random(3),
    surface = () => {
      const chunk = new VoxelChunk();
      for (let x = 0; x < 32; x++)
        for (let z = 0; z < 32; z++)
          for (let y = 0; y < 16 + Math.floor(8 * Math.sin(x * 0.3) * Math.cos(z * 0.2)); y++)
            chunk.set(x, y, z, stone);
      return chunk;
    },
    caves = () => {
      const chunk = new VoxelChunk();
      for (let i = 0; i < 32768; i++) if (next() < 0.5) chunk.set(i & 31, i >> 10, (i >> 5) & 31, stone);
      return chunk;
    };
  t.diagnostic(
    `one chunk build: terrain surface ${single(surface)} ms, solid with open faces ${single(() => new VoxelChunk(stone))} ms, ` +
      `50% random ${single(caves)} ms, air ${single(() => new VoxelChunk())} ms`,
  );
  // Terrain over 8 x 8 chunk columns: uniform stone at chunk y -2..0, the surface in chunk y 1, nothing above.
  const world = new VoxelWorld({ blocks }),
    height = (x, z) => 42 + Math.floor(8 * Math.sin(x * 0.13) * Math.cos(z * 0.11));
  for (let cx = -4; cx < 4; cx++)
    for (let cz = -4; cz < 4; cz++) {
      for (let cy = -2; cy < 1; cy++) world.addChunk(cx, cy, cz, new VoxelChunk(stone));
      const edits = [];
      for (let x = cx * 32; x < cx * 32 + 32; x++)
        for (let z = cz * 32; z < cz * 32 + 32; z++) for (let y = 32; y < height(x, z); y++) edits.push(x, y, z, stone);
      world.setBlocks(edits);
    }
  const physics = new Physics(null, { rapier: RAPIER, gravity: [0, 0, 0] }),
    voxels = new VoxelPhysics(physics, world),
    body = physics.addBody(null, { type: 'kinematicPosition', position: [-80, 40, -80], colliders: [] });
  let builds = calls.builds,
    start = performance.now();
  physics.step();
  const spawn = performance.now() - start,
    spawned = calls.builds - builds;
  let crossing = 0;
  builds = calls.builds;
  for (let i = 1; i <= 4; i++) {
    body.setPosition([-80 + i * 32, 40, -80]);
    start = performance.now();
    physics.step();
    crossing += performance.now() - start;
  }
  const crossed = (calls.builds - builds) / 4,
    cells = [];
  for (const [key] of voxels.colliders) {
    const [cx, cy, cz] = key.split(',').map(Number);
    if (cy !== 1) continue;
    for (let i = 0; i < 100; i++) {
      const x = cx * 32 + Math.floor(next() * 32),
        z = cz * 32 + Math.floor(next() * 32);
      cells.push(x, height(x, z) - 1, z);
    }
  }
  const edit = (target) => {
    const begin = performance.now();
    for (let i = 0; i < cells.length; i += 3) target.setBlock(cells[i], cells[i + 1], cells[i + 2], 0);
    for (let i = 0; i < cells.length; i += 3) target.setBlock(cells[i], cells[i + 1], cells[i + 2], stone);
    return ((performance.now() - begin) * 1e3) / ((cells.length / 3) * 2);
  };
  const plain = new VoxelWorld({ blocks });
  for (let i = 0; i < cells.length; i += 3) plain.setBlock(cells[i], cells[i + 1], cells[i + 2], stone);
  const without = edit(plain),
    updates = calls.setVoxel,
    withColliders = edit(world);
  t.diagnostic(`spawn on terrain: ${spawned} chunk colliders in ${spawn.toFixed(1)} ms, coupling included`);
  t.diagnostic(`a body crossing a chunk border: ${crossed} new colliders, ${(crossing / 4).toFixed(1)} ms`);
  t.diagnostic(
    `dig + place at the surface: ${withColliders.toFixed(1)} us per edit with colliders (` +
      `${((calls.setVoxel - updates) / (cells.length / 3) / 2).toFixed(1)} setVoxel each), ${without.toFixed(1)} us without`,
  );
  physics.dispose();
});
