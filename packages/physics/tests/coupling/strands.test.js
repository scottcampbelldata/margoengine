import assert from 'node:assert/strict';
import test from 'node:test';
import { StrandSolver, STRAND_LAYOUT, STRAND_WORDS } from '../../dist/strands.js';
import { Physics } from '../../dist/index.js';
import { TerrainBed } from '../../dist/earth.js';
import { BODY_IMPULSES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const zero = [0, 0, 0];
const rate = { num: 60, den: 1 };
const air = (velocity, density = 1.225) => ({
  medium: 'air',
  cell: zero,
  sample: () => ({ velocity, density, temperature: 289 }),
});
const distance = (a, b) => Math.hypot(...a.map((value, k) => value - b[k]));
const near = (actual, expected, bound) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} versus ${expected} ± ${bound}`);

async function attach(strands, params = {}, gravity = [0, -9.81, 0]) {
  const solver = await StrandSolver.load();
  const world = new PhysicsWorld({ rate, gravity }).add(solver, { strands, ...params });
  return { solver, world };
}

test('the single-segment hanging rod has the classical elastic extension under half its own weight', async () => {
  const length = 0.24,
    radius = 0.002,
    density = 965,
    young = 120_000,
    g = 9.81;
  const { solver, world } = await attach(
    [{ points: [zero, [0, -length, 0]], radius, density, young, drag: 0 }],
    { damping: 30, selfCollision: false },
    [0, -g, 0],
  );
  world.advance(540);
  const expected = (density * g * length * length) / (2 * young);
  // Each hanging point has half the cylinder mass. The discrete XPBD equilibrium is exact as v tends to zero.
  const tip = solver.sample(0, 1);
  near(-tip.position[1] - length, expected, 128 * Number.EPSILON);
  near(distance(zero, tip.velocity), 0, 512 * Number.EPSILON);
  assert.deepEqual(solver.sample(0, 0).position, zero);
  const [port] = solver.exportPorts(world.tick);
  assert.equal(port.region.layout, STRAND_LAYOUT);
  assert.equal(regionWords(world.memory, port.region).length, 2 * STRAND_WORDS);
});

test('a curved rod stays at zero strain after a rigid transform of its authored frame', async () => {
  const root = [0.45, 1.2, -0.3],
    points = [zero, [0, 0, 0.2], [0.08, 0, 0.34], [0.22, 0.04, 0.43]];
  const { solver, world } = await attach(
    [{ points, radius: 0.007, anchor: () => ({ position: root, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }) }],
    { selfCollision: false },
    zero,
  );
  world.advance(180);
  for (const [i, [x, y, z]] of points.entries()) {
    const p = solver.sample(0, i).position;
    near(distance(p, [root[0] - y, root[1] + x, root[2] + z]), 0, 1e-10);
  }
});

test('follow-the-leader keeps link lengths under an accelerating root and a reversing wind', async () => {
  const points = [
    [0, 1, 0],
    [0, 0.75, 0],
    [0, 0.5, 0],
    [0, 0.25, 0],
  ];
  const strand = { points, radius: 0.015, anchor: (time) => ({ position: [0.2 * Math.sin(time * 4), 1, 0] }) };
  const wind = {
    medium: 'air',
    cell: zero,
    sample: (x, y, z, time) => ({ velocity: [time < 0.65 ? 23 : -30, 0, 0], density: 1.225, temperature: 289 }),
  };
  const { solver, world } = await attach([strand], { fidelity: 'follow', wind });
  const calm = await attach([strand], { fidelity: 'follow', wind: air(zero) });
  for (let f = 1; f <= 90; f++) {
    world.advance(f);
    for (let i = 1; i < points.length; i++) {
      near(distance(solver.sample(0, i).position, solver.sample(0, i - 1).position), 0.25, 32 * Number.EPSILON);
    }
  }
  calm.world.advance(90);
  assert.ok(solver.sample(0, 3).position[0] < calm.solver.sample(0, 3).position[0] - 0.1);
  near(solver.sample(0, 0).position[0], 0.2 * Math.sin(6), 2 * Number.EPSILON);
});

test('fast contact preserves link length while resting against the common ground field', async () => {
  const terrain = new TerrainBed();
  const world = new PhysicsWorld({ rate }).add(terrain, {
    columns: 2,
    rows: 2,
    width: 4,
    depth: 4,
    centre: [0, 0],
    elevations: () => 0,
  });
  const points = [
    [0, 0.3, 0],
    [0.3, 0.3, 0],
    [0.6, 0.3, 0],
  ];
  const solver = await StrandSolver.load();
  world.add(solver, { strands: [{ points, radius: 0.02 }], fidelity: 'follow', bed: terrain.bed });
  for (let i = 1; i <= 180; i++) {
    world.advance(i);
    const last = solver.sample(0, 2).position,
      parent = solver.sample(0, 1).position;
    assert.ok(last[1] >= 0.02 - 16 * Number.EPSILON);
    near(distance(last, parent), 0.3, 32 * Number.EPSILON);
  }
  near(solver.sample(0, 2).position[1], 0.02, 32 * Number.EPSILON);
});

test('rod contacts an actual moving body capsule and sparse neighbours keep disjoint bundles apart', async () => {
  const points = [
    [0, 0.5, 0],
    [0, 0.3, 0],
    [0, 0.1, 0],
  ];
  const mapped = (offset) => points.map(([x, y, z]) => [x + offset, y, z]);
  const strands = [
    { points, radius: 0.01 },
    { points: mapped(0.014), radius: 0.01 },
  ];
  for (let i = 1; i <= 32; i++) strands.push({ points: mapped(i * 0.5), radius: 0.01 });
  const capsule = (time) => ({
    start: [-0.08 + time * 0.08, 0.21, -0.065],
    end: [-0.08 + time * 0.08, 0.21, 0.065],
    radius: 0.09,
  });
  const { solver, world } = await attach(strands, { colliders: [capsule], iterations: 20 });
  world.advance(60);
  const tip = solver.sample(0, 2).position,
    body = capsule(1);
  const nearest = [body.start[0], body.start[1], Math.max(body.start[2], Math.min(body.end[2], tip[2]))];
  assert.ok(distance(tip, nearest) >= 0.1 - 1e-9);
  assert.ok(distance(tip, solver.sample(1, 2).position) >= 0.01999);
  assert.ok(solver.candidatePairs > 0 && solver.candidatePairs < 34 * 240 * 20);
});

test('moving anchors agree across frame rates and restore the exact plain and shared snapshots', async () => {
  const strands = [
    {
      points: [
        [0, 0.4, 0],
        [0.08, 0.32, 0],
        [0.12, 0.21, 0],
        [0.15, 0.12, 0],
      ],
      radius: 0.005,
      anchor: (time) => ({ position: [time * 0.12, 0.4 + Math.sin(time * 5) * 0.06, 0] }),
    },
  ];
  const queue = [];
  for (let i = 0; i < 12; i++) queue.push(await StrandSolver.load());
  const make = (playback, shared = false) =>
    new PhysicsWorld({ rate: playback, memory: worldMemory(shared) }).add(queue.shift(), {
      strands,
      wind: air([3, 0, 2]),
    });
  const replay = { num: 24, den: 1 };
  for (const shared of [false, true]) {
    frameRateIndependent((playback) => make(playback, shared));
    seekEqualsContinuous(() => make(replay, shared));
  }
  const plain = make(rate),
    shared = make(rate, true);
  plain.advance(57);
  shared.advance(57);
  assert.equal(plain.hash(), shared.hash());
});

test('invalid fibre lengths, mass and collision profiles report direct fixes', async () => {
  const points = [zero, [0, -0.1, 0]];
  await assert.rejects(attach([{ points: [zero, zero] }]), /positive rest edge length/);
  await assert.rejects(attach([{ points, density: 0 }]), /positive fibre density/);
  await assert.rejects(attach([{ points }], { fidelity: 'follow', selfCollision: true }), /Use the rod tier/);
});

test('a real moving rigid capsule gets the opposite strand impulse and an off-centre moment', async () => {
  for (const [shared, offset] of [
    [false, 0],
    [true, 16],
  ]) {
    await Physics.load({ threads: shared });
    const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(shared), cellSize: 16 });
    const rigid = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: 1 / 60 });
    try {
      const incoming = -3.6,
        mass = 2;
      const body = rigid.addBody(null, {
        position: [offset + 0.14, 0, 0],
        linearVelocity: [incoming, 0, 0],
        colliders: { shape: 'sphere', radius: 0.1, mass, sensor: true },
      });
      world.add(new RigidSolver(), { physics: rigid }, offset ? zero : [1, 0, 0]);
      const solver = await StrandSolver.load({
        rigidCapsules: [{ body: body.row, start: [0, 0.04, 0], end: [0, 0.04, 0], radius: 0.1 }],
      });
      const radius = 0.01,
        density = 850,
        length = 0.3;
      world.add(
        solver,
        {
          strands: [{ points: [[0, length, 0], zero], radius, density, young: 0.25, drag: 0 }],
          rate: 0,
          damping: 0,
          friction: 0,
          iterations: 1,
          selfCollision: false,
          cellSize: 16,
        },
        [1, 0, 0],
      );
      world.couple(['rigid', solver.id], 'staggered');
      world.advance(1);
      const [port] = solver.exportPorts(0).filter(({ field }) => field === BODY_IMPULSES_FIELD.name);
      const pending = regionWords(world.memory, port.region).slice(body.row * 6, body.row * 6 + 6);
      const tip = solver.sample(0, 1),
        tipMass = 0.5 * density * Math.PI * radius * radius * length;
      assert.ok(tip.velocity[0] < 0 && pending[0] > 0 && pending[5] < 0, JSON.stringify({ tip, pending }));
      // The root was unloaded at the first projection. The known initial rigid momentum remains in the two
      // bodies and the in-flight f64 reaction. Its f32 velocity can round by less than one part in 2^22.
      near(
        pending[0] + tipMass * tip.velocity[0] + mass * body.linearVelocity[0],
        mass * incoming,
        mass * Math.abs(incoming) * 2 ** -22,
      );
      near(pending[1] + tipMass * tip.velocity[1] + mass * body.linearVelocity[1], 0, 64 * Number.EPSILON);
      const snapshot = world.takeSnapshot();
      world.advance(2);
      assert.ok(body.linearVelocity[0] > incoming && body.angularVelocity[2] < 0);
      const hash = world.hash();
      world.restoreSnapshot(snapshot.bytes);
      world.advance(2);
      assert.equal(world.hash(), hash);
    } finally {
      rigid.dispose();
    }
  }
});
