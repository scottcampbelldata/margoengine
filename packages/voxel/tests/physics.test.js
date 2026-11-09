import { speedEnabled, deferSpeed } from '../../../scripts/support/speed-phase.mjs';
// VoxelPhysics against the real solver of @margoengine/physics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Physics, PhysicsBody, PhysicsCollider } from '@margoengine/physics';
import {
  BlockTypes,
  chunkKey,
  doubleSlabState,
  slabState,
  stairState,
  VoxelChunk,
  VoxelWorld,
  waterlogState,
} from '../dist/index.js';
import { VoxelPhysics } from '../dist/physics.js';

await Physics.load();
const rtest = test;
const vec = ([x, y, z]) => ({ x, y, z });

// Collider work counted, to tell in-place updates (setVoxel) from rebuilds (a new voxels or trimesh collider), with the
// largest triangle mesh built.
// `meshed` is every triangle handed to trimesh and every cell handed to voxels so far: the work of building colliders,
// which wall time only estimates.
const calls = { builds: 0, setVoxel: 0, propagate: 0, combine: 0, meshes: 0, triangles: 0, meshed: 0 };
const addCollider = PhysicsBody.prototype.addCollider;
PhysicsBody.prototype.addCollider = function (options) {
  if (options.shape === 'trimesh') {
    calls.builds++;
    calls.meshes++;
    calls.triangles = Math.max(calls.triangles, options.indices.length / 3);
    calls.meshed += options.indices.length / 3;
  } else if (options.shape === 'voxels') {
    calls.builds++;
    calls.meshed += options.cells.length / 3;
  }
  return addCollider.call(this, options);
};
const count = (owner, name, counter) => {
  const original = owner[name];
  owner[name] = function (...args) {
    calls[counter]++;
    return original.apply(this, args);
  };
};
count(PhysicsCollider.prototype, 'setVoxel', 'setVoxel');
count(PhysicsCollider.prototype, 'propagateVoxelChange', 'propagate');
count(PhysicsCollider.prototype, 'combineVoxelStates', 'combine');
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const blocks = new BlockTypes(),
  stone = blocks.define('stone'),
  dirt = blocks.define('dirt'),
  flower = blocks.define('flower', { shape: 'cross', layer: 'cutout', solid: false }),
  water = blocks.define('water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' }),
  slab = blocks.define('slab', { shape: 'slab', waterlog: water }),
  stair = blocks.define('stair', { shape: 'stair', waterlog: water });
const setup = (options, gravity = [0, -9.81, 0]) => {
  const physics = new Physics(null, { gravity }),
    world = new VoxelWorld({ blocks }),
    voxels = new VoxelPhysics(physics, world, options);
  return { physics, world, voxels };
};
// Like setup, and `spent` gets the milliseconds each step spends in VoxelPhysics (its beforestep listener), printed
// only. `work` gets the collider work (triangles and voxel cells) done in the same step: tests assert on that, which a busy machine cannot change.
const timed = (options, gravity, world = new VoxelWorld({ blocks })) => {
  const physics = new Physics(null, { gravity }),
    spent = [],
    work = [];
  let start = 0,
    meshed = 0;
  physics.on('beforestep', () => {
    start = performance.now();
    meshed = calls.meshed;
  });
  const voxels = new VoxelPhysics(physics, world, options);
  physics.on('beforestep', () => {
    spent.push(performance.now() - start);
    work.push(calls.meshed - meshed);
  });
  return { physics, world, voxels, spent, work };
};
// A chunk with each cell stone at random (seeded), unless `keep` says no: about 66,000 triangles of open faces, the
// worst case for a ball's mesh.
const caves = (seed, keep = () => true) => {
  const next = random(seed),
    chunk = new VoxelChunk();
  for (let i = 0; i < 32768; i++)
    if (next() < 0.5 && keep(i & 31, i >> 10, (i >> 5) & 31)) chunk.set(i & 31, i >> 10, (i >> 5) & 31, stone);
  return chunk;
};
const max = (list) => list.reduce((a, b) => Math.max(a, b), 0);
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

// 'mesh' or 'voxels' per chunk key: the collider kind VoxelPhysics chose (a mesh may be several pieces).
const isMesh = (list) => list.every((c) => c.shape === 'trimesh');
const kinds = (voxels) =>
  Object.fromEntries(
    [...voxels.colliders]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, list]) => [key, isMesh(list) ? 'mesh' : list.length === 1 ? 'voxels' : 'mixed']),
  );
const ballBody = (physics, radius, position, options = {}) =>
  physics.addBody(null, { position, colliders: { shape: 'sphere', radius, ...options.collider }, ...options.body });
// Ledgy terrain over chunks x 0..1, z 0..1 (borders x 32 and z 32): a floor (top y 1), a plateau with 2-cell ledges,
// a 2-high wall, a 1-deep pit (lowest top y 0) and a step.
const ledges = (world, width = 64) => {
  fill(world, 0, width, -2, 1, 0, 64, stone);
  fill(world, 40, 48, 1, 3, 8, 56, stone);
  fill(world, 4, 30, 1, 3, 20, 21, dirt);
  fill(world, 20, 24, 0, 1, 30, 36, 0);
  fill(world, 10, 14, 1, 2, 40, 50, stone);
};

rtest('a box rests on a voxel floor, keeps it while asleep and falls once the block under it is removed', () => {
  const { physics, world, voxels } = setup();
  fill(world, 0, 8, 0, 1, 0, 8, stone);
  const box = physics.addBody(null, {
    position: [4.5, 3, 4.5],
    colliders: { shape: 'box', halfExtents: [0.4, 0.4, 0.4] },
  });
  steps(physics, 240);
  assert.ok(Math.abs(box.position[1] - 1.4) < 0.01, `rests on the floor top (y ${box.position[1]})`);
  assert.ok(box.sleeping, 'falls asleep on the floor');
  steps(physics, 10);
  assert.deepEqual(kinds(voxels), { '0,0,0': 'voxels' }, 'a sleeping body keeps its chunk collider');
  const builds = calls.builds;
  world.setBlock(4, 0, 4, 0); // the 0.8-wide box fits the 1-wide hole
  steps(physics, 60);
  assert.ok(box.position[1] < -1, `falls through the hole (y ${box.position[1]})`);
  assert.equal(calls.builds, builds, 'the edit changed the collider in place');
  physics.dispose();
});

rtest('a ball rests on a mesh chunk, sleeps, and falls once the block under it is removed', () => {
  const { physics, world, voxels } = setup();
  fill(world, 0, 8, 0, 1, 0, 8, stone);
  const ball = ballBody(physics, 0.4, [4.5, 3, 4.5]);
  steps(physics, 240);
  assert.deepEqual(kinds(voxels), { '0,0,0': 'mesh' }, 'a chunk near a ball is a triangle mesh');
  assert.ok(Math.abs(ball.position[1] - 1.4) < 0.01, `rests on the floor top (y ${ball.position[1]})`);
  assert.ok(ball.sleeping, 'falls asleep on the floor');
  const builds = calls.builds,
    setVoxel = calls.setVoxel;
  world.setBlock(4, 0, 4, 0);
  world.setBlock(0, 0, 0, 0); // two edits before the step: one rebuild
  steps(physics, 60);
  assert.ok(ball.position[1] < -1, `falls through the hole (y ${ball.position[1]})`);
  assert.equal(calls.builds, builds + 1, 'the mesh was rebuilt once for both edits');
  assert.ok(calls.setVoxel > setVoxel, 'its disabled voxel collider is kept up to date in place');
  physics.dispose();
});

rtest('balls roll off ledges, across chunk borders and into walls without a panic (96 seeded balls)', () => {
  let lowest = Infinity,
    crossings = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const next = random(seed),
      { physics, world, voxels } = setup();
    ledges(world);
    const balls = [];
    for (let i = 0; i < 6; i++) {
      const radius = 0.2 + next() * 0.4;
      balls.push([
        ballBody(physics, radius, [6 + next() * 52, 4 + next() * 2, 6 + next() * 52], {
          body: { linearVelocity: [(next() - 0.5) * 16, 0, (next() - 0.5) * 16] },
          collider: { restitution: next() * 0.5 },
        }),
        radius,
      ]);
    }
    const sides = balls.map(([b]) => [b.position[0] < 32, b.position[2] < 32]);
    for (let i = 0; i < 400; i++) {
      physics.step(); // a panic here would end the solver instance (RuntimeError: unreachable)
      for (const [b, radius] of balls) {
        const [x, y, z] = b.position;
        if (x > 1 && x < 63 && z > 1 && z < 63) lowest = Math.min(lowest, y - radius);
      }
    }
    balls.forEach(([b], i) => {
      if (b.position[0] < 32 !== sides[i][0]) crossings++;
      if (b.position[2] < 32 !== sides[i][1]) crossings++;
    });
    assert.ok(
      Object.values(kinds(voxels)).every((kind) => kind === 'mesh'),
      'every chunk near a ball is a mesh',
    );
    physics.dispose();
  }
  assert.ok(lowest > -0.05, `no ball sank below the lowest floor top y 0 (lowest bottom ${lowest})`);
  assert.ok(crossings > 30, `balls crossed chunk borders (${crossings} times)`);
});

rtest('balls roll across x and z chunk borders without a kick or a snag (seeded)', (t) => {
  let lag = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const next = random(seed),
      radius = 0.25 + next() * 0.3,
      start = [27, 1 + radius + 0.002, 28 + next() * 2],
      v = [3 + next() * 6, 0, 2 + next() * 4],
      w = [v[2] / radius, 0, -v[0] / radius]; // rolling, not sliding
    // The reference: the same ball on one box, without VoxelPhysics.
    const reference = new Physics(null);
    reference.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'box', halfExtents: [32, 1.5, 32], offset: [32, -0.5, 32] },
    });
    const ref = reference.addBody(null, {
      position: start,
      linearVelocity: v,
      angularVelocity: w,
      canSleep: false,
      colliders: { shape: 'sphere', radius },
    });
    const { physics, world } = setup();
    fill(world, 0, 64, -2, 1, 0, 64, stone);
    const ball = ballBody(physics, radius, start, { body: { linearVelocity: v, angularVelocity: w, canSleep: false } });
    // Slip: how far the spin is from rolling without sliding at the current velocity.
    const slip = (lin, ang) => Math.hypot(ang[0] - lin[2] / radius, ang[1], ang[2] + lin[0] / radius);
    let bump = 0,
      refBump = 0,
      spin = 0,
      refSpin = 0;
    for (let i = 0; i < 150; i++) {
      physics.step();
      reference.step();
      if (i < 4) continue;
      const lv = vec(ref.linearVelocity),
        av = vec(ref.angularVelocity);
      bump = Math.max(bump, Math.abs(ball.linearVelocity[1]));
      refBump = Math.max(refBump, Math.abs(lv.y));
      spin = Math.max(spin, slip(ball.linearVelocity, ball.angularVelocity));
      refSpin = Math.max(refSpin, slip([lv.x, lv.y, lv.z], [av.x, av.y, av.z]));
    }
    const p = vec(ref.position),
      lv = vec(ref.linearVelocity),
      [x, y, z] = ball.position,
      [vx, , vz] = ball.linearVelocity;
    lag = Math.max(lag, Math.hypot(x - p.x, y - p.y, z - p.z));
    const speed = Math.hypot(vx, vz),
      refSpeed = Math.hypot(lv.x, lv.z);
    assert.ok(x > 33 && z > 33, `seed ${seed}: crossed both borders (${x}, ${z})`);
    assert.ok(bump <= refBump + 0.01, `seed ${seed}: no vertical kick (|vy| ${bump} vs ${refBump} on one box)`);
    assert.ok(spin <= refSpin + 0.02, `seed ${seed}: no snag in the roll (slip ${spin} vs ${refSpin})`);
    assert.ok(Math.abs(speed - refSpeed) < 0.01, `seed ${seed}: kept its speed (${speed} vs ${refSpeed})`);
    // The solver can drop up to one step of travel where a ball passes from one collider to the next (separate boxes
    // do it too), so the path may trail the one-box path by a step for each of the three chunks it enters.
    const trail = Math.hypot(x - p.x, y - p.y, z - p.z);
    assert.ok(trail < (3 * refSpeed) / 60 + 0.02, `seed ${seed}: trails the one-box path by ${trail} m`);
    reference.dispose();
    physics.dispose();
  }
  t.diagnostic(`largest trail behind the one-box path after the x and z borders: ${lag.toFixed(3)} m`);
});

rtest('balls roll across the mesh piece seams of a floor under caves without a kick or a snag (seeded)', (t) => {
  let lag = 0,
    pieces = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const next = random(seed),
      radius = 0.25 + next() * 0.3,
      start = [7, 1 + radius + 0.002, 8 + next() * 2],
      v = [3 + next() * 6, 0, 2 + next() * 4],
      w = [v[2] / radius, 0, -v[0] / radius];
    const reference = new Physics(null);
    reference.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'box', halfExtents: [32, 1.5, 32], offset: [32, -0.5, 32] },
    });
    const ref = reference.addBody(null, {
      position: start,
      linearVelocity: v,
      angularVelocity: w,
      canSleep: false,
      colliders: { shape: 'sphere', radius },
    });
    const { physics, world, voxels } = setup();
    fill(world, 0, 64, -2, 1, 0, 64, stone);
    // Random stone at y 12..31 makes each chunk's mesh far over 2,048 triangles, so the floor is cut into pieces.
    const edits = [],
      cave = random(seed + 100);
    for (let x = 0; x < 64; x++)
      for (let z = 0; z < 64; z++) for (let y = 12; y < 32; y++) if (cave() < 0.5) edits.push(x, y, z, stone);
    world.setBlocks(edits);
    const ball = ballBody(physics, radius, start, { body: { linearVelocity: v, angularVelocity: w, canSleep: false } });
    const slip = (lin, ang) => Math.hypot(ang[0] - lin[2] / radius, ang[1], ang[2] + lin[0] / radius);
    let bump = 0,
      refBump = 0,
      spin = 0,
      refSpin = 0;
    for (let i = 0; i < 150; i++) {
      physics.step();
      reference.step();
      if (i < 4) continue;
      const lv = vec(ref.linearVelocity),
        av = vec(ref.angularVelocity);
      bump = Math.max(bump, Math.abs(ball.linearVelocity[1]));
      refBump = Math.max(refBump, Math.abs(lv.y));
      spin = Math.max(spin, slip(ball.linearVelocity, ball.angularVelocity));
      refSpin = Math.max(refSpin, slip([lv.x, lv.y, lv.z], [av.x, av.y, av.z]));
    }
    const p = vec(ref.position),
      lv = vec(ref.linearVelocity),
      [x, y, z] = ball.position,
      [vx, , vz] = ball.linearVelocity,
      trail = Math.hypot(x - p.x, y - p.y, z - p.z),
      refSpeed = Math.hypot(lv.x, lv.z);
    pieces = Math.max(pieces, voxels.colliders.get('0,0,0').length);
    lag = Math.max(lag, trail);
    assert.ok(bump <= refBump + 0.01, `seed ${seed}: no vertical kick (|vy| ${bump} vs ${refBump} on one box)`);
    assert.ok(spin <= refSpin + 0.02, `seed ${seed}: no snag in the roll (slip ${spin} vs ${refSpin})`);
    assert.ok(Math.abs(Math.hypot(vx, vz) - refSpeed) < 0.01, `seed ${seed}: kept its speed`);
    // Like a chunk border, a seam can cost up to a step of travel; the path passes up to six seams and borders.
    assert.ok(trail < (6 * refSpeed) / 60 + 0.02, `seed ${seed}: trails the one-box path by ${trail} m`);
    reference.dispose();
    physics.dispose();
  }
  t.diagnostic(`largest trail behind the one-box path across ${pieces}-piece chunks: ${lag.toFixed(3)} m`);
});

rtest('chunks switch to meshes as a ball comes and back to voxels once it leaves, with hysteresis', () => {
  const { physics, world, voxels } = setup({ budget: Infinity }, [0, 0, 0]); // every build in the step that needs it
  for (let cx = -3; cx <= 4; cx++) fill(world, cx * 32, cx * 32 + 32, 0, 1, 0, 32, stone);
  physics.addBody(null, { position: [16, 16, 16], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  const ball = ballBody(physics, 0.4, [3 * 32 + 16, 16, 16], { body: { type: 'kinematicPosition' } });
  physics.step();
  const v = 'voxels',
    m = 'mesh';
  assert.deepEqual(kinds(voxels), {
    '-1,0,0': v,
    '0,0,0': v,
    '1,0,0': v,
    '2,0,0': m,
    '3,0,0': m,
    '4,0,0': m,
  });
  ball.setPosition([2 * 32 + 16, 16, 16]);
  physics.step();
  assert.deepEqual(
    kinds(voxels),
    { '-1,0,0': v, '0,0,0': v, '1,0,0': m, '2,0,0': m, '3,0,0': m, '4,0,0': m },
    'chunk 1 is a mesh once the ball is within a chunk of it; chunk 4, two chunks away, stays one',
  );
  const builds = calls.builds;
  for (let i = 0; i < 10; i++) {
    ball.setPosition([i & 1 ? 95.99 : 96.01, 16, 16]); // on the chunk 2 | 3 border
    physics.step();
  }
  assert.equal(calls.builds, builds, 'a ball on a chunk border makes nothing flip');
  ball.remove();
  physics.step();
  assert.deepEqual(
    kinds(voxels),
    { '-1,0,0': v, '0,0,0': v, '1,0,0': v, '2,0,0': v },
    'without the ball: voxels again, chunks beyond two of the box dropped',
  );
  physics.dispose();
});

rtest('mixed scene: balls, capsules and boxes over mesh and voxel chunks', () => {
  const next = random(11),
    { physics, world, voxels } = setup();
  ledges(world, 192); // six chunks along x: balls start in the first two
  const bodies = [];
  for (let i = 0; i < 12; i++) {
    const kind = i % 3,
      position = [kind ? 6 + next() * 170 : 6 + next() * 50, 4 + next() * 2, 6 + next() * 52],
      body = physics.addBody(null, {
        position,
        linearVelocity: [(next() - 0.5) * 10, 0, (next() - 0.5) * 10],
        colliders:
          kind === 0
            ? { shape: 'sphere', radius: 0.3 }
            : kind === 1
              ? { shape: 'capsule', halfHeight: 0.3, radius: 0.3 }
              : { shape: 'box', halfExtents: [0.3, 0.3, 0.3] },
      });
    bodies.push(body);
  }
  const seen = new Set();
  let lowest = Infinity;
  for (let i = 0; i < 400; i++) {
    physics.step();
    for (const kind of Object.values(kinds(voxels))) seen.add(kind);
    for (const b of bodies) {
      const [x, y, z] = b.position;
      if (x > 1 && x < 191 && z > 1 && z < 63) lowest = Math.min(lowest, y);
    }
  }
  assert.deepEqual([...seen].sort(), ['mesh', 'voxels'], 'both kinds of collider at once');
  assert.ok(lowest > 0.2, `no body sank through the terrain (lowest centre ${lowest})`);
  physics.dispose();
});

rtest('cubes slide between the mesh chunks around a ball and voxel chunks without snagging (seeded)', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const next = random(seed),
      { physics, world, voxels } = setup();
    fill(world, 0, 128, -2, 1, 0, 32, stone);
    // A ball in chunk 0 makes chunks 0 and 1 meshes; chunk 2 stays voxels. Odd seeds go mesh -> voxels.
    ballBody(physics, 0.4, [16, 8, 16], { body: { type: 'kinematicPosition' } });
    const out = seed & 1,
      half = 0.3 + next() * 0.2,
      v = [(out ? 1 : -1) * (3 + next() * 6), 0, (next() - 0.5) * 3],
      body = cube(physics, half, [out ? 58 : 70, 1 + half + 0.002, 10 + next() * 10], v);
    let bump = 0,
      spin = 0;
    for (let i = 0; i < 300 && Math.abs(body.position[0] - 64) < 7; i++) {
      physics.step();
      if (i > 3) {
        bump = Math.max(bump, Math.abs(body.linearVelocity[1]));
        spin = Math.max(spin, Math.hypot(...body.angularVelocity));
      }
    }
    const k = kinds(voxels);
    assert.ok(k['1,0,0'] === 'mesh' && k['2,0,0'] === 'voxels', `seed ${seed}: a mesh | voxels border at x 64`);
    assert.ok(out ? body.position[0] > 70 : body.position[0] < 58, `seed ${seed}: crossed it (x ${body.position[0]})`);
    assert.ok(bump < 0.05 && spin < 0.05, `seed ${seed}: no kick or tumble (|vy| ${bump}, |w| ${spin})`);
    assert.ok(Math.abs(body.linearVelocity[0] - v[0]) < 0.01 * Math.abs(v[0]), `seed ${seed}: kept its speed`);
    physics.dispose();
  }
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

rtest('colliders follow the radius rule: near moving bodies, loaded chunks only, kept one chunk further', () => {
  const { physics, world, voxels } = setup({ budget: Infinity }, [0, 0, 0]);
  for (let cx = -3; cx <= 3; cx++) fill(world, cx * 32, cx * 32 + 32, 0, 1, 0, 32, stone);
  const body = physics.addBody(null, {
    position: [16, 16, 16],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  physics.step();
  assert.deepEqual(keys(voxels), ['-1,0,0', '0,0,0', '1,0,0'], 'the body chunk and its loaded neighbours');
  assert.equal(physics.colliderCount, 4, 'three chunk colliders and the body');
  let builds = calls.builds;
  for (let i = 0; i < 10; i++) {
    body.setPosition([i & 1 ? 31.99 : 32.01, 16, 16]); // on the chunk 0 | 1 border
    physics.step();
  }
  assert.equal(calls.builds, builds + 1, 'a body on a chunk border builds chunk 2 once and drops nothing');
  body.setPosition([3 * 32 + 16, 16, 16]);
  physics.step();
  assert.deepEqual(keys(voxels), ['1,0,0', '2,0,0', '3,0,0'], 'moved with the body; chunk 1 kept, 4 not loaded');
  const other = physics.addBody(null, { type: 'kinematicPosition', position: [-3 * 32 + 5, 5, 5], colliders: [] });
  physics.step();
  assert.deepEqual(keys(voxels), ['-2,0,0', '-3,0,0', '1,0,0', '2,0,0', '3,0,0'], 'kinematic bodies count too');
  world.removeChunk(3, 0, 0);
  physics.step();
  assert.deepEqual(keys(voxels), ['-2,0,0', '-3,0,0', '1,0,0', '2,0,0'], 'an unloaded chunk loses its collider');
  builds = calls.builds;
  fill(world, 96, 128, 0, 1, 0, 32, dirt); // loads it again
  physics.step();
  assert.ok(voxels.colliders.has('3,0,0') && calls.builds === builds + 1, 'a reloaded chunk gets one again');
  body.remove();
  other.remove();
  physics.addBody(null, { type: 'fixed', position: [16, 16, 16], colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  physics.step();
  assert.equal(voxels.colliders.size, 0, 'fixed bodies do not count; no moving body, no colliders');
  physics.step(); // dropped colliders stay disabled for one step, so their contacts end with events
  assert.equal(physics.colliderCount, 1);
  physics.dispose();
  const wide = setup({ radius: 2, budget: Infinity }, [0, 0, 0]);
  for (let cx = -3; cx <= 3; cx++) fill(wide.world, cx * 32, cx * 32 + 32, 0, 1, 0, 32, stone);
  wide.physics.addBody(null, { position: [16, 16, 16], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  wide.physics.step();
  assert.deepEqual(keys(wide.voxels), ['-1,0,0', '-2,0,0', '0,0,0', '1,0,0', '2,0,0'], 'radius 2');
  wide.physics.dispose();
});

rtest('a chunk that comes back after edits made out of range leaves no stale seam', () => {
  const { physics, world, voxels } = setup({ budget: Infinity }); // the seam is under test, not the time budget
  fill(world, 0, 128, -1, 0, 0, 16, stone); // floor, top at y 0
  fill(world, 30, 34, 0, 1, 0, 16, stone); // a wall across the chunk border x 32
  const body = cube(physics, 0.4, [20, 0.402, 8.3], [0, 0, 0]);
  physics.step();
  body.setPosition([3 * 32 + 16, 0.402, 8.3]); // away: chunk 0 drops out of range, chunk 1 stays
  physics.step();
  assert.deepEqual(keys(voxels), ['1,-1,0', '1,0,0', '2,-1,0', '3,-1,0']);
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

for (const mesh of [false, true])
  rtest(`edits keep ${mesh ? 'mesh' : 'voxel'} colliders matching the world (ray oracle, seeded)`, () => {
    const next = random(7),
      { physics, world, voxels } = setup({ budget: Infinity }, [0, 0, 0]);
    const height = (x, z) => 6 + Math.floor(8 + 7 * Math.sin(x * 0.21) * Math.cos(z * 0.17));
    const edits = [];
    for (let x = -32; x < 64; x++)
      for (let z = -32; z < 64; z++)
        for (let y = 0; y < height(x, z); y++) edits.push(x, y, z, y > 9 && (x + z) % 3 ? dirt : stone);
    world.setBlocks(edits);
    // A kinematic body (a ball for meshes) whose radius covers all 9 chunks; rays skip it.
    const anchor = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [16, 16, 16],
      colliders: mesh ? { shape: 'sphere', radius: 0.4 } : [],
    });
    const builds = calls.builds;
    physics.step();
    assert.equal(voxels.colliders.size, 9);
    assert.equal(calls.builds, builds + (mesh ? 18 : 9), mesh ? 'voxels and a mesh per chunk' : 'one build per chunk');
    assert.ok(Object.values(kinds(voxels)).every((kind) => kind === (mesh ? 'mesh' : 'voxels')));
    const solid = (x, y, z) => blocks.get(world.getBlock(x, y, z) & 0xffff).solid;
    // Every ray from outside the 3 x 1 x 3 chunks must hit the first solid cell the world has on its line.
    const check = (label) => {
      physics.step();
      let rays = 0;
      const cast = (origin, dir, expected) => {
        const hit = physics.raycast(origin, dir, { maxDistance: 200, exclude: anchor }),
          got = hit ? hit.distance : null;
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
      // Rows along x and along z through every cell height the edits reach.
      for (let y = 0; y < 24; y++)
        for (let a = -32; a < 64; a++) {
          let b = -32;
          while (b < 64 && !solid(b, y, a)) b++;
          cast([-40, y + 0.5, a + 0.5], [1, 0, 0], b === 64 ? null : b + 40);
          b = 63;
          while (b >= -32 && !solid(b, y, a)) b--;
          cast([70, y + 0.5, a + 0.5], [-1, 0, 0], b < -32 ? null : 70 - (b + 1));
          b = -32;
          while (b < 64 && !solid(a, y, b)) b++;
          cast([a + 0.5, y + 0.5, -40], [0, 0, 1], b === 64 ? null : b + 40);
          b = 63;
          while (b >= -32 && !solid(a, y, b)) b--;
          cast([a + 0.5, y + 0.5, 70], [0, 0, -1], b < -32 ? null : 70 - (b + 1));
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
      if (mesh && i % 100 === 99) check(`after ${i + 1} edits`); // meshes rebuild at the next step
    }
    const rays = check('after 600 edits'),
      updates = calls.setVoxel - before.setVoxel;
    if (mesh) assert.ok(calls.builds - before.builds <= 9 * 7, 'meshes: at most one rebuild per chunk and step');
    else assert.equal(calls.builds, before.builds, 'no rebuilds');
    assert.ok(flips > 200 && updates >= flips, `${updates} setVoxel calls for ${flips} solidity flips`);
    // A shaft dug in chunk 0's last column, beside solid cells of chunks 0 and 1: from inside it, rays must hit
    // the walls the digging exposed on both sides of the chunk border (each in its own chunk's collider).
    const shaft = [31, 2, 40, 31, 3, 40, 31, 4, 40, 30, 2, 40, 32, 2, 40, 30, 3, 40, 32, 3, 40];
    world.setBlocks(shaft.flatMap((c, i) => (i % 3 === 2 ? [c, stone] : [c])));
    physics.step();
    world.setBlock(31, 3, 40, 0);
    world.setBlock(31, 2, 40, 0);
    physics.step();
    for (const [dir, side] of [
      [1, 'chunk 1'],
      [-1, 'chunk 0'],
    ]) {
      const hit = physics.raycast([31.5, 2.5, 40.5], [dir, 0, 0], { maxDistance: 10, exclude: anchor });
      assert.ok(hit && Math.abs(hit.distance - 0.5) < 1e-3, `the shaft wall in ${side} (hit ${hit?.distance})`);
    }
    world.setBlock(-30, 0, -30, 0);
    physics.step();
    const kept = { ...calls };
    world.setBlock(-30, 0, -30, stone); // air -> stone
    world.setBlock(-30, 0, -30, dirt); // stone -> dirt: still solid
    world.setBlock(-30, 30, -30, flower); // air -> flower: still not solid
    physics.step();
    assert.equal(calls.setVoxel, kept.setVoxel + 1, 'only the solidity change touched the voxel collider');
    assert.equal(calls.builds, kept.builds + (mesh ? 1 : 0), mesh ? 'and rebuilt one mesh' : 'and rebuilt nothing');
    assert.ok(rays > 18000);
    physics.dispose();
  });

rtest('a cave chunk entering a ball radius is meshed piece by piece within the budget (measured)', (t) => {
  // The cave chunk x 2 enters the radius when a kinematic ball moves into chunk 1, 24 m from it.
  const approach = (budget) => {
    const { physics, world, voxels, spent, work } = timed({ budget }, [0, 0, 0]);
    world.addChunk(2, 0, 0, caves(3));
    const ball = ballBody(physics, 0.4, [16, 16, 16], { body: { type: 'kinematicPosition' } });
    physics.step();
    assert.equal(voxels.colliders.size, 0, 'two chunks away: no collider yet');
    spent.length = 0;
    work.length = 0;
    calls.triangles = 0;
    ball.setPosition([40, 16, 16]);
    const seen = new Set();
    let steps = 0;
    do {
      physics.step();
      steps++;
      if (voxels.pending) seen.add(kinds(voxels)['2,0,0']);
    } while (voxels.pending && steps < 500);
    const pieces = voxels.colliders.get('2,0,0'),
      triangles = calls.triangles;
    assert.deepEqual(kinds(voxels), { '2,0,0': 'mesh' });
    physics.dispose();
    return { steps, spent, work, seen, pieces: pieces.length, triangles };
  };
  approach(Infinity); // warm up
  const whole = approach(Infinity),
    spread = approach(2);
  assert.equal(whole.steps, 1, 'budget Infinity: built in the step that needs it');
  assert.ok(whole.triangles <= 2048 && spread.triangles <= 2048, 'no mesh piece over 2,048 triangles');
  assert.ok(spread.pieces >= 32, `the cave chunk is ${spread.pieces} pieces`);
  assert.ok(spread.steps >= 10, `spread over ${spread.steps} steps`);
  assert.deepEqual([...spread.seen], ['voxels'], 'until its mesh is complete the chunk keeps its voxel collider');
  const worst = max(spread.spent),
    worstWork = max(spread.work);
  if (speedEnabled())
    t.diagnostic(
      `cave chunk meshed for a ball: all at once ${whole.spent[0].toFixed(1)} ms in one step; budget 2: ` +
        `${spread.steps} steps, at most ${worst.toFixed(2)} ms a step (${spread.pieces} pieces)`,
    );
  assert.ok(
    worstWork < whole.work[0] / 4,
    `no step meshes more than a quarter of the whole build (${worstWork} of ${whole.work[0]} triangles)`,
  );
});

rtest('the budget tests measure meshing work, which a busy machine cannot change', async () => {
  // The budget tests assert on triangles meshed per step, never on milliseconds. Hog every core with busy-loop workers:
  // the work of the one-step build must come out exactly as on an idle machine.
  const build = () => {
    const { physics, world, work } = timed({ budget: Infinity }, [0, 0, 0]);
    world.addChunk(2, 0, 0, caves(3));
    const ball = ballBody(physics, 0.4, [16, 16, 16], { body: { type: 'kinematicPosition' } });
    physics.step();
    work.length = 0;
    ball.setPosition([40, 16, 16]);
    physics.step();
    physics.dispose();
    return work[0];
  };
  const idle = build();
  assert.ok(idle > 1000, `the build meshes ${idle} triangles`);
  const hogs = Array.from(
    { length: Math.max(2, availableParallelism()) },
    () => new Worker('const end = Date.now() + 60000; while (Date.now() < end);', { eval: true }),
  );
  try {
    assert.equal(build(), idle, 'the same triangles meshed while every core is busy');
    assert.equal(build(), idle);
  } finally {
    await Promise.all(hogs.map((hog) => hog.terminate()));
  }
});

rtest('a ball spawned inside a cave chunk gets the mesh around it at once; no body falls through', (t) => {
  // Floor y 0..1, random stone above except a shaft at x, z 12..19; a platform (top y 32) at x, z 2..7.
  const shaft = (x, y, z) => !(x >= 12 && x < 20 && z >= 12 && z < 20);
  const { physics, world, voxels, spent } = timed({ budget: 2 });
  const chunk = caves(9, shaft);
  for (let x = 0; x < 32; x++)
    for (let z = 0; z < 32; z++) {
      for (let y = 0; y < 2; y++) chunk.set(x, y, z, stone);
      if (x >= 2 && x < 8 && z >= 2 && z < 8) for (let y = 28; y < 32; y++) chunk.set(x, y, z, stone);
    }
  world.addChunk(0, 0, 0, chunk);
  const box = physics.addBody(null, {
    position: [5, 32.42, 5],
    colliders: { shape: 'box', halfExtents: [0.4, 0.4, 0.4] },
  });
  steps(physics, 30);
  assert.deepEqual(kinds(voxels), { '0,0,0': 'voxels' });
  const rest = box.position[1];
  const ball = ballBody(physics, 0.4, [16, 20, 16]);
  spent.length = 0;
  calls.triangles = 0;
  physics.step();
  const first = voxels.colliders.get('0,0,0').length;
  assert.equal(kinds(voxels)['0,0,0'], 'mesh', 'a ball inside the chunk switches it to a mesh in the same step');
  assert.ok(voxels.pending > 0, 'the pieces away from the bodies are still pending');
  let lowest = Infinity,
    drift = 0,
    done = 0;
  for (let n = 1; n < 300 && (voxels.pending || n < 150); n++) {
    physics.step();
    if (!voxels.pending && !done) done = n;
    lowest = Math.min(lowest, ball.position[1]);
    drift = Math.max(drift, Math.abs(box.position[1] - rest));
  }
  const pieces = voxels.colliders.get('0,0,0').length;
  if (speedEnabled())
    t.diagnostic(
      `ball spawned in a cave chunk: first step ${spent[0].toFixed(2)} ms built ${first} of ${pieces} pieces; ` +
        `the rest took ${done} more steps, at most ${max(spent.slice(1, done + 1)).toFixed(2)} ms each`,
    );
  assert.ok(first < pieces / 2, `the first step built only the pieces near the bodies (${first} of ${pieces})`);
  assert.equal(voxels.pending, 0);
  assert.ok(calls.triangles <= 2048);
  assert.ok(Math.abs(ball.position[1] - 2.4) < 0.01, `the ball landed on the floor (y ${ball.position[1]})`);
  assert.ok(lowest > 2.35, `and never sank into it (lowest ${lowest})`);
  assert.ok(drift < 0.01, `the box on the platform kept its floor through the switch (moved ${drift})`);
  physics.dispose();
});

rtest('chunks entering a moving body radius are built within the budget, never under it (measured)', (t) => {
  // Cave chunks at chunk y -1 under a one-cell floor (top y 1) over chunks x -3..3, z -1..1.
  const cross = (budget) => {
    const { physics, world, voxels, spent, work } = timed({ budget }, [0, 0, 0]);
    for (let cx = -3; cx <= 3; cx++)
      for (let cz = -1; cz <= 1; cz++) {
        world.addChunk(cx, -1, cz, caves(cx * 7 + cz + 20));
        const floor = world.addChunk(cx, 0, cz);
        for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) floor.set(x, 0, z, stone);
      }
    const body = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [-80, 1.5, 16],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
    physics.step();
    spent.length = 0;
    work.length = 0;
    let holes = 0;
    // 12 m/s along x across chunk borders -64, -32, 0, 32 and 64.
    for (let x = -80; x < 80; x += 0.2) {
      body.setNextPosition([x, 1.5, 16]);
      physics.step();
      const cx = Math.floor(x / 32),
        have = voxels.colliders;
      if (!have.has(chunkKey(cx, 0, 0)) || !have.has(chunkKey(cx, -1, 0))) holes++;
    }
    physics.dispose();
    return { spent, work, holes };
  };
  cross(Infinity); // warm up
  const whole = cross(Infinity),
    spread = cross(2);
  const top = (list) => [...list].sort((a, b) => b - a).slice(0, 5);
  if (speedEnabled())
    t.diagnostic(
      `crossing chunk borders over cave chunks: budget Infinity, worst steps ${top(whole.spent).map((v) => v.toFixed(1))} ms; ` +
        `budget 2: ${top(spread.spent).map((v) => v.toFixed(1))} ms`,
    );
  assert.equal(spread.holes, 0, 'the chunk under the body always had its collider');
  assert.ok(
    max(spread.work) < max(whole.work) / 2,
    `the border crossing cost is spread (${max(spread.work)} of ${max(whole.work)} units in the worst step)`,
  );
});

rtest('contacts with blocks raise Physics collision events naming voxels.body and the chunk', () => {
  const { physics, world, voxels } = setup();
  fill(world, 0, 64, 0, 1, 0, 16, stone);
  const events = [];
  for (const type of ['contactstart', 'contactend', 'intersectionstart', 'intersectionend'])
    physics.on(type, (e) => {
      const a = e.bodyA === voxels.body;
      assert.ok(a || e.bodyB === voxels.body, 'every event here involves the blocks');
      const collider = a ? e.colliderA : e.colliderB,
        other = a ? e.bodyB : e.bodyA;
      assert.equal(a ? e.meshA : e.meshB, null);
      events.push(
        `${type} ${other.userData} ${voxels.chunkOf(collider)} ${collider.shape === 'voxels' ? 'voxels' : 'mesh'}`,
      );
    });
  assert.equal(voxels.body.userData, voxels);
  assert.equal(voxels.body.type, 'fixed');
  const box = physics.addBody(null, {
    position: [8.5, 2, 8.5],
    userData: 'box',
    colliders: { shape: 'box', halfExtents: [0.4, 0.4, 0.4] },
  });
  steps(physics, 60);
  assert.deepEqual(events.splice(0), ['contactstart box 0,0,0 voxels'], 'a box landing on voxels');
  const ball = ballBody(physics, 0.4, [40.5, 3, 8.5], { body: { userData: 'ball' } });
  steps(physics, 60);
  assert.deepEqual(
    events.splice(0),
    ['contactend box 0,0,0 voxels', 'contactstart box 0,0,0 mesh', 'contactstart ball 1,0,0 mesh'],
    'the switch to meshes ends the voxel contact and starts a mesh one in the same step; the ball lands on a mesh',
  );
  ball.remove();
  steps(physics, 2);
  assert.deepEqual(
    events.splice(0),
    ['contactend box 0,0,0 mesh', 'contactstart box 0,0,0 voxels'],
    'and back: a dropped mesh piece ends its contacts too',
  );
  world.setBlock(8, 0, 8, 0);
  world.setBlock(9, 0, 8, 0);
  steps(physics, 30);
  assert.deepEqual(events.splice(0), ['contactend box 0,0,0 voxels'], 'the box fell through the hole it was on');
  const sensor = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [30.5, 0.5, 8.5],
    userData: 'sensor',
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], sensor: true },
  });
  steps(physics, 2);
  assert.deepEqual(events.splice(0), ['intersectionstart sensor 0,0,0 voxels'], 'sensors see blocks');
  sensor.setPosition([30.5, 3, 8.5]);
  steps(physics, 2);
  assert.deepEqual(events.splice(0), ['intersectionend sensor 0,0,0 voxels']);
  const hit = physics.raycast([40.5, 10, 3.5], [0, -1, 0]);
  assert.ok(hit?.body === voxels.body && Math.abs(hit.distance - 9) < 1e-6, 'queries see blocks near bodies');
  assert.equal(voxels.chunkOf(box.colliders[0]), undefined);
  physics.dispose();
  // contactFilter sees the voxel body too: a ghost passes through the blocks, a box does not.
  const filtered = new Physics(null, {
      contactFilter: (a, b) => !(a.userData === 'ghost' || b.userData === 'ghost'),
    }),
    floor = new VoxelWorld({ blocks }),
    other = new VoxelPhysics(filtered, floor);
  fill(floor, 0, 16, 0, 1, 0, 16, stone);
  const ghost = filtered.addBody(null, {
      position: [4.5, 2, 4.5],
      userData: 'ghost',
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    }),
    solid = filtered.addBody(null, {
      position: [10.5, 2, 4.5],
      userData: 'box',
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
  steps(filtered, 60);
  assert.ok(ghost.position[1] < -2 && Math.abs(solid.position[1] - 1.5) < 0.01, 'the filter decides per body pair');
  other.body.remove();
  filtered.step();
  assert.equal(other.colliders.size, 0, 'removing voxels.body disposes the VoxelPhysics');
  floor.setBlock(1, 0, 1, 0);
  filtered.dispose();
});

rtest('dispose removes every collider and stops following edits and steps', () => {
  const { physics, world, voxels } = setup();
  fill(world, -40, 40, 0, 1, -8, 8, stone);
  physics.addBody(null, { position: [0.5, 1.6, 0.5], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  ballBody(physics, 0.4, [-35.5, 1.5, 0.5]); // meshes in chunk x -2 and its neighbours
  physics.step();
  assert.ok(Object.values(kinds(voxels)).includes('mesh') && Object.values(kinds(voxels)).includes('voxels'));
  assert.ok(physics.colliderCount > 2 + voxels.colliders.size, 'mesh chunks keep a disabled voxel collider');
  voxels.dispose();
  assert.equal(voxels.colliders.size, 0);
  assert.equal(physics.colliderCount, 2, 'only the body colliders are left');
  const before = { ...calls };
  world.setBlock(3, 0, 3, 0);
  world.setBlock(-36, 0, 0, 0);
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

rtest('arguments and a solver without voxels are rejected with clear errors', () => {
  const physics = new Physics(null),
    world = new VoxelWorld({ blocks });
  assert.throws(() => new VoxelPhysics({}, world), TypeError);
  assert.throws(() => new VoxelPhysics(physics, {}), TypeError);
  assert.throws(() => new VoxelPhysics(physics, world, { radius: 0 }), RangeError);
  assert.throws(() => new VoxelPhysics(physics, world, { radius: 1.5 }), RangeError);
  assert.throws(() => new VoxelPhysics(physics, world, { radius: '1' }), TypeError);
  assert.throws(() => new VoxelPhysics(physics, world, { budget: -1 }), RangeError);
  assert.throws(() => new VoxelPhysics(physics, world, { budget: Number.NaN }), RangeError);
  assert.throws(() => new VoxelPhysics(physics, world, { budget: '2' }), TypeError);
  const live = new VoxelPhysics(physics, world, { budget: 0 });
  live.budget = Infinity;
  assert.equal(live.budget, Infinity);
  assert.throws(() => {
    live.budget = -2;
  }, RangeError);
  live.dispose();
  const old = new Physics(null);
  old.supportsShape = () => false;
  assert.throws(() => new VoxelPhysics(old, world), { name: 'MargoError', code: 'unsupported' });
  old.dispose();
  physics.dispose();
  assert.throws(() => new VoxelPhysics(physics, world), { name: 'MargoError', code: 'disposed' });
});

const speedRtest = (...args) => {
  if (deferSpeed(args[0])) return;
  return rtest(...args);
};

speedRtest('benchmark: collider builds and edit updates (printed)', (t) => {
  // One chunk alone in its world, built all at once by the first step (the solver's collider creation included); best of 3.
  const single = (make, ball) => {
    let best = Infinity,
      pieces = 0;
    for (let i = 0; i < 3; i++) {
      const { physics, world, voxels } = setup({ budget: Infinity }, [0, 0, 0]);
      world.addChunk(0, 0, 0, make());
      physics.addBody(null, {
        type: 'kinematicPosition',
        position: [16, 16, 16],
        colliders: ball ? { shape: 'sphere', radius: 0.4 } : [],
      });
      const start = performance.now();
      physics.step();
      best = Math.min(best, performance.now() - start);
      pieces = voxels.colliders.get('0,0,0')?.length ?? 0;
      physics.dispose();
    }
    return `${best.toFixed(2)} ms${ball ? ` (${pieces} pieces)` : ''}`;
  };
  const next = random(3),
    surface = () => {
      const chunk = new VoxelChunk();
      for (let x = 0; x < 32; x++)
        for (let z = 0; z < 32; z++)
          for (let y = 0; y < 16 + Math.floor(8 * Math.sin(x * 0.3) * Math.cos(z * 0.2)); y++)
            chunk.set(x, y, z, stone);
      return chunk;
    };
  for (const ball of [false, true])
    if (speedEnabled())
      t.diagnostic(
        `one chunk all at once, ${ball ? 'triangle mesh' : 'voxel collider'}: terrain surface ${single(surface, ball)}, ` +
          `solid with open faces ${single(() => new VoxelChunk(stone), ball)}, 50% random ${single(() => caves(3), ball)}, ` +
          `air ${single(() => new VoxelChunk(), ball)}`,
      );
  // Terrain over 8 x 8 chunk columns: uniform stone at chunk y -2..0, the surface in chunk y 1, nothing above.
  const height = (x, z) => 42 + Math.floor(8 * Math.sin(x * 0.13) * Math.cos(z * 0.11)),
    terrain = () => {
      const world = new VoxelWorld({ blocks });
      for (let cx = -4; cx < 4; cx++)
        for (let cz = -4; cz < 4; cz++) {
          for (let cy = -2; cy < 1; cy++) world.addChunk(cx, cy, cz, new VoxelChunk(stone));
          const edits = [];
          for (let x = cx * 32; x < cx * 32 + 32; x++)
            for (let z = cz * 32; z < cz * 32 + 32; z++)
              for (let y = 32; y < height(x, z); y++) edits.push(x, y, z, stone);
          world.setBlocks(edits);
        }
      return world;
    };
  let kept = null;
  for (const budget of [Infinity, 2]) {
    const { physics, world, voxels, spent } = timed({ budget }, [0, 0, 0], terrain());
    for (const ball of [false, true]) {
      const body = physics.addBody(null, {
        type: 'kinematicPosition',
        position: [-80, 40, ball ? 48 : -80],
        colliders: ball ? { shape: 'sphere', radius: 0.4 } : [],
      });
      // Steps until nothing is pending: the builds, steps, time and worst step in VoxelPhysics.
      const settle = () => {
        const builds = calls.builds;
        spent.length = 0;
        do physics.step();
        while (voxels.pending && spent.length < 500);
        return {
          builds: calls.builds - builds,
          steps: spent.length,
          total: spent.reduce((a, b) => a + b),
          worst: max(spent),
        };
      };
      const spawn = settle(),
        crossings = [];
      for (let i = 1; i <= 4; i++) {
        body.setPosition([-80 + i * 32, 40, ball ? 48 : -80]);
        crossings.push(settle());
      }
      const mean = (key) => (crossings.reduce((a, c) => a + c[key], 0) / 4).toFixed(1);
      if (speedEnabled())
        t.diagnostic(
          `${ball ? 'a ball' : 'a body'} on terrain, budget ${budget}: spawn ${spawn.builds} builds in ${spawn.steps} ` +
            `steps, worst ${spawn.worst.toFixed(1)} ms; a chunk border crossing ${mean('builds')} builds in ` +
            `${mean('steps')} steps, ${mean('total')} ms, worst step ${max(crossings.map((c) => c.worst)).toFixed(1)} ms`,
        );
    }
    if (budget === Infinity) kept = { physics, world, voxels, spent };
    else physics.dispose();
  }
  const { physics, world, voxels, spent } = kept,
    cells = [];
  for (const [key, list] of voxels.colliders) {
    const [cx, cy, cz] = key.split(',').map(Number);
    if (cy !== 1 || isMesh(list)) continue;
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
  if (speedEnabled())
    t.diagnostic(
      `dig + place at the surface of voxel chunks: ${withColliders.toFixed(1)} us per edit (` +
        `${((calls.setVoxel - updates) / (cells.length / 3) / 2).toFixed(1)} setVoxel each), ${without.toFixed(1)} us without`,
    );
  // A mesh piece rebuilds at the next step however many edits it took.
  const [meshKey] = [...voxels.colliders].find(([key, list]) => key.split(',')[1] === '1' && isMesh(list)),
    [mx, , mz] = meshKey.split(',').map(Number),
    meshes = calls.meshes;
  world.setBlock(mx * 32 + 5, height(mx * 32 + 5, mz * 32 + 5) - 1, mz * 32 + 5, 0);
  spent.length = 0;
  physics.step();
  if (speedEnabled())
    t.diagnostic(
      `an edit in a mesh chunk: ${calls.meshes - meshes} piece rebuilt at the next step, ${spent[0].toFixed(1)} ms`,
    );
  physics.dispose();
});

rtest('slabs and stairs collide as their half-block boxes, and edits rebuild their mesh', () => {
  const { physics, world, voxels } = setup();
  fill(world, 0, 8, 0, 1, 0, 8, stone);
  fill(world, 1, 4, 1, 2, 1, 4, slabState(slab));
  world.setBlock(6, 1, 6, stairState(stair, '+x'));
  const box = (x, z) =>
    physics.addBody(null, { position: [x, 4, z], colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2] } });
  const onSlab = box(2.5, 2.5),
    onBack = box(6.75, 6.5), // over the stair's full-height back
    onStep = box(6.25, 6.5), // over its step
    ball = ballBody(physics, 0.2, [2.5, 4, 1.5]);
  steps(physics, 240);
  const near = (body, y, what) =>
    assert.ok(Math.abs(body.position[1] - y) < 0.02, `${what} rests at y ${y} (y ${body.position[1]})`);
  near(onSlab, 1.7, 'a box on a slab top');
  near(onBack, 2.2, "a box on a stair's back");
  near(onStep, 1.7, "a box on a stair's step");
  near(ball, 1.7, 'a ball on a slab (mesh chunk)');
  // The slab and stair mesh is one collider of the chunk, beside its voxels or mesh pieces.
  assert.ok(voxels.colliders.get('0,0,0').some((c) => c.shape === 'trimesh'));
  // Removing the slab under a resting box rebuilds the mesh and drops the box to the floor.
  world.setBlock(2, 1, 2, 0);
  steps(physics, 120);
  near(onSlab, 1.2, 'the box, once its slab is gone,');
  physics.dispose();
});

rtest('double slabs, waterlogged slabs and corner stairs collide as their boxes', () => {
  const { physics, world } = setup();
  fill(world, 0, 8, 0, 1, 0, 8, stone);
  world.setBlock(2, 1, 2, doubleSlabState(slab));
  world.setBlock(5, 1, 2, waterlogState(slabState(slab)));
  world.setBlock(2, 1, 5, stairState(stair, '+x', false, 'outer+z')); // only the +x, +z quarter is high
  const box = (x, z) =>
    physics.addBody(null, { position: [x, 4, z], colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2] } });
  const onDouble = box(2.5, 2.5),
    onWet = box(5.5, 2.5),
    onCorner = box(2.75, 5.75),
    besideCorner = box(2.25, 5.75);
  steps(physics, 240);
  const near = (body, y, what) =>
    assert.ok(Math.abs(body.position[1] - y) < 0.02, `${what} rests at y ${y} (y ${body.position[1]})`);
  near(onDouble, 2.2, 'a box on a double slab');
  near(onWet, 1.7, 'a box on a waterlogged slab');
  near(onCorner, 2.2, "a box on an outer corner's high quarter");
  near(besideCorner, 1.7, 'a box beside it, on the step');
  physics.dispose();
});
