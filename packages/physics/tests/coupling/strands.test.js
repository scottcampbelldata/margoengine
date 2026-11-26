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

test('segment contact clears a narrow capsule between two guide points', async () => {
  const points = [
    [-0.23, 0, 0],
    [0.23, 0, 0],
  ];
  const bead = { start: [0, 0.035, 0], end: [0, 0.035, 0], radius: 0.06 };
  const radius = 0.01;
  const params = { iterations: 24, rate: 0, damping: 0, selfCollision: false, colliders: [bead] };
  const strands = [{ points, radius, young: 70, drag: 0 }];
  const old = await attach(strands, params, zero);
  const selected = await attach(strands, { ...params, contactGeometry: 'segments' }, zero);
  const clearance = (solver) => {
    const first = solver.sample(0, 0).position,
      second = solver.sample(0, 1).position;
    const edge = second.map((x, axis) => x - first[axis]);
    const numerator = edge.reduce((n, x, axis) => n + x * (bead.start[axis] - first[axis]), 0);
    const denominator = edge.reduce((n, x) => n + x * x, 0);
    const t = Math.max(0, Math.min(1, numerator / denominator));
    return distance(
      first.map((x, axis) => x + t * edge[axis]),
      bead.start,
    );
  };
  old.world.advance(1);
  selected.world.advance(1);
  near(clearance(old.solver), 0.035, 1e-12);
  assert.ok(clearance(selected.solver) >= bead.radius + radius - 2e-6);
  assert.deepEqual(selected.solver.sample(0, 0).position, points[0]);
  assert.ok(selected.solver.sample(0, 1).position[1] < -0.05);
  await assert.rejects(attach(strands, { fidelity: 'follow', contactGeometry: 'segments' }, zero), /Use the rod tier/);
});

test('a moving sphere receives the full impulse from a contact in the middle of a link', async () => {
  await Physics.load();
  const world = new PhysicsWorld({ rate, gravity: zero });
  const rigid = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60, gravity: zero });
  try {
    const velocity = -2.8,
      mass = 2,
      radius = 0.01,
      density = 850,
      span = 0.4;
    const body = rigid.addBody(null, {
      position: [0, 0.095, 0],
      linearVelocity: [0, velocity, 0],
      colliders: { shape: 'sphere', radius: 0.06, sensor: true, mass },
    });
    world.add(new RigidSolver(), { physics: rigid });
    const solver = await StrandSolver.load({
      rigidCapsules: [{ body: body.row, start: [0.03, 0, 0], end: [0.03, 0, 0], radius: 0.06 }],
    });
    world.add(solver, {
      strands: [
        {
          points: [
            [-0.2, 0, 0],
            [0.2, 0, 0],
          ],
          radius,
          density,
          young: 1,
          drag: 0,
        },
      ],
      rate: 0,
      damping: 0,
      friction: 0,
      iterations: 1,
      selfCollision: false,
      contactGeometry: 'segments',
    });
    world.couple(['rigid', solver.id], 'staggered');
    world.advance(1);
    const pending = solver.exportPorts(0).find((value) => value.field === BODY_IMPULSES_FIELD.name);
    const reaction = regionWords(world.memory, pending.region),
      at = body.row * 6;
    const tip = solver.sample(0, 1),
      tipMass = 0.5 * density * Math.PI * radius * radius * span;
    assert.ok(tip.velocity[1] < 0 && reaction[at + 1] > 0 && reaction[at + 5] > 0);
    near(reaction[at + 1] + tipMass * tip.velocity[1] + mass * body.linearVelocity[1], mass * velocity, 1e-6);
    world.advance(2);
    assert.ok(body.linearVelocity[1] > velocity && body.angularVelocity[2] > 0);
  } finally {
    rigid.dispose();
  }
});

test('direct Cosserat bending follows a measured hair modulus as the guide is refined', async () => {
  // Fujita and Tohmyoh (2020) measured 3.45 GPa at small strain. Gravity supplies a distributed load.
  const length = 0.03,
    radius = 40e-6,
    density = 1300,
    young = 3.45e9,
    g = 9.81;
  const area = Math.PI * radius * radius,
    inertia = (area * radius * radius) / 4;
  const weight = density * area * g,
    bending = young * inertia;
  const continuous = (weight * length ** 4) / (8 * bending);
  const angleBound = (weight * length ** 3) / (6 * bending);
  const shear = (2.6 * weight * length * length) / (2 * young * area);
  let previous = Infinity;
  for (const n of [8, 16, 32, 64]) {
    const points = Array.from({ length: n + 1 }, (_, i) => [0, 0, (length * i) / n]);
    const { solver, world } = await attach(
      [{ points, radius, density, young, drag: 0 }],
      { rodSolve: 'direct', iterations: 6, damping: 27, selfCollision: false },
      [0, -g, 0],
    );
    world.advance(120);
    const tip = -solver.sample(0, n).position[1];
    // The half mass at the free tip makes the discrete joint moment q * (L - x)^2 / 2.
    // The cubic moment sum with the clamped first segment yields (1 - 1/n)^2 times the continuum solution.
    const discrete = continuous * (1 - 1 / n) ** 2;
    // Curvature changes the moment arm by at most theta^2/2 and the rise per edge by theta^2/6.
    // An additional theta^2/3 covers the quaternion angle linearization and their product.
    near(tip, discrete, discrete * angleBound * angleBound + shear + 64 * Number.EPSILON);
    assert.ok(continuous - tip < previous);
    previous = continuous - tip;
  }
});

test('swept geometry catches a kinematic capsule crossing a whole guide within one tick', async () => {
  const points = [
      [-0.25, 0, 0],
      [0.25, 0, 0],
    ],
    radius = 0.01;
  const capsule = (t) => {
    const center = [0, 0.2 - 24 * t, 0];
    return { start: center, end: center, radius: 0.06 };
  };
  const params = { rate: 0, iterations: 12, damping: 0, friction: 0, selfCollision: false, colliders: [capsule] };
  const strand = { points, radius, young: 9, drag: 0 };
  const discrete = await attach([strand], { ...params, contactGeometry: 'segments' }, zero);
  const swept = await attach([strand], { ...params, contactGeometry: 'swept' }, zero);
  discrete.world.advance(1);
  swept.world.advance(1);
  const end = swept.solver.sample(0, 1);
  near(discrete.solver.sample(0, 1).position[1], 0, 64 * Number.EPSILON);
  assert.ok(end.position[1] < -0.2, JSON.stringify(end));
  assert.deepEqual(swept.solver.sample(0, 0).position, points[0]);
});

test('a rigid capsule crossing the strand in one tick transfers impulse and replays its swept history', async () => {
  await Physics.load();
  const world = new PhysicsWorld({ rate, gravity: zero });
  const rigid = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60, gravity: zero });
  try {
    const velocity = -24,
      mass = 2,
      radius = 0.01,
      density = 850,
      span = 0.5;
    const body = rigid.addBody(null, {
      position: [0, 0.6, 0],
      linearVelocity: [0, velocity, 0],
      colliders: { shape: 'sphere', radius: 0.06, sensor: true, mass },
    });
    world.add(new RigidSolver(), { physics: rigid });
    const solver = await StrandSolver.load({
      rigidCapsules: [{ body: body.row, start: [0.02, 0, 0], end: [0.02, 0, 0], radius: 0.06 }],
    });
    world.add(solver, {
      strands: [
        {
          points: [
            [-0.25, 0, 0],
            [0.25, 0, 0],
          ],
          radius,
          density,
          young: 9,
          drag: 0,
        },
      ],
      rate: 0,
      damping: 0,
      friction: 0,
      iterations: 1,
      selfCollision: false,
      contactGeometry: 'swept',
    });
    world.couple(['rigid', solver.id], 'staggered');
    world.advance(1);
    near(solver.sample(0, 1).velocity[1], 0, 64 * Number.EPSILON);
    const start = world.takeSnapshot();
    world.advance(2);
    const port = solver.exportPorts(1).find((value) => value.field === BODY_IMPULSES_FIELD.name);
    const reaction = regionWords(world.memory, port.region),
      at = body.row * 6;
    const tip = solver.sample(0, 1),
      tipMass = 0.5 * density * Math.PI * radius * radius * span;
    assert.ok(tip.position[1] < -0.2 && reaction[at + 1] > 0 && reaction[at + 5] > 0);
    near(reaction[at + 1] + tipMass * tip.velocity[1] + mass * body.linearVelocity[1], mass * velocity, 3e-6);
    const middle = world.takeSnapshot();
    world.advance(4);
    const hash = world.hash();
    assert.ok(body.linearVelocity[1] > velocity);
    world.restoreSnapshot(middle.bytes);
    world.advance(4);
    assert.equal(world.hash(), hash);
    world.restoreSnapshot(start.bytes);
    world.advance(4);
    assert.equal(world.hash(), hash);
  } finally {
    rigid.dispose();
  }
});

test('sparse segment self contact sees crossing links and exchanges equal internal momentum', async () => {
  const radius = 0.02,
    young = 20;
  const guides = [
    {
      points: [
        [-0.25, 0, 0],
        [0.25, 0, 0],
      ],
      radius,
      young,
      drag: 0,
    },
    {
      points: [
        [0, -0.25, 0.015],
        [0, 0.25, 0.015],
      ],
      radius,
      young,
      drag: 0,
    },
  ];
  for (let i = 1; i <= 24; i++)
    guides.push({
      points: [
        [2 * i, 0, 0],
        [2 * i, 0.5, 0],
      ],
      radius,
      young,
      drag: 0,
    });
  const options = { rate: 0, damping: 0, friction: 0, iterations: 1 };
  const points = await attach(guides, options, zero);
  const links = await attach(guides, { ...options, contactGeometry: 'segments' }, zero);
  points.world.advance(1);
  links.world.advance(1);
  const a = links.solver.sample(0, 1),
    b = links.solver.sample(1, 1);
  near(points.solver.sample(0, 1).position[2], 0, 32 * Number.EPSILON);
  near(points.solver.sample(1, 1).position[2], 0.015, 32 * Number.EPSILON);
  // At the symmetric crossing the two contact weights on the free ends are each 1/2.
  // The midpoint difference gives exactly the two radii after one position projection.
  near((0.015 + b.position[2] - a.position[2]) / 2, 2 * radius, 128 * Number.EPSILON);
  near(a.velocity[2] + b.velocity[2], 0, 256 * Number.EPSILON);
  assert.ok(links.solver.candidatePairs > 0 && links.solver.candidatePairs < guides.length);
});

test('a swept strand blocks a whole neighbor link moved through it by an animated root', async () => {
  const radius = 0.021,
    young = 2e7;
  const guides = [
    {
      points: [
        [-0.25, 0, 0],
        [0.25, 0, 0],
      ],
      radius,
      young,
      drag: 0,
    },
    {
      points: [
        [0, -0.25, 0.2],
        [0, 0.25, 0.2],
      ],
      radius,
      young,
      drag: 0,
      anchor: (time) => ({ position: [0, -0.25, time === 0 ? 0.2 : -0.2] }),
    },
  ];
  const options = { rate: 0, iterations: 1, damping: 0, friction: 0 };
  const stationary = await attach(guides, { ...options, contactGeometry: 'segments' }, zero);
  const swept = await attach(guides, { ...options, contactGeometry: 'swept' }, zero);
  stationary.world.advance(1);
  swept.world.advance(1);
  near(stationary.solver.sample(0, 1).position[2], 0, 64 * Number.EPSILON);
  assert.ok(swept.solver.sample(0, 1).position[2] < -0.1);
});

test('link friction exchanges equal momentum and removes tangential sliding energy', async () => {
  const radius = 0.02;
  const guides = [
    {
      points: [
        [-0.25, 0, 0],
        [0.25, 0, 0],
      ],
      radius,
      young: 10,
      drag: 1.2,
    },
    {
      points: [
        [0, -0.25, 0.01],
        [0, 0.25, 0.01],
      ],
      radius,
      young: 10,
      drag: 0,
    },
  ];
  const options = { rate: 0, damping: 0, iterations: 1, wind: air([8, 0, 0]), contactGeometry: 'segments' };
  const clean = await attach(guides, { ...options, friction: 0 }, zero);
  const rough = await attach(guides, { ...options, friction: 0.5 }, zero);
  clean.world.advance(1);
  rough.world.advance(1);
  const sample = ({ solver }) => [solver.sample(0, 1), solver.sample(1, 1)];
  const [a, b] = sample(clean).map((tip) => tip.velocity);
  const [c, d] = sample(rough).map((tip) => tip.velocity);
  assert.ok(d[0] > b[0] && c[0] < a[0]);
  // Recover the internal impulses including the reactions on both fixed roots.
  const [tipA, tipB] = sample(rough).map((tip) => tip.position);
  const [rootA, rootB] = guides.map((guide) => guide.points[0]);
  const minus = (u, v) => u.map((x, k) => x - v[k]);
  const dot = (u, v) => u.reduce((sum, x, k) => sum + x * v[k], 0);
  const edgeA = minus(tipA, rootA);
  const edgeB = minus(tipB, rootB);
  const delta = minus(rootA, rootB);
  const aa = dot(edgeA, edgeA);
  const ab = dot(edgeA, edgeB);
  const bb = dot(edgeB, edgeB);
  const aw = dot(edgeA, delta);
  const bw = dot(edgeB, delta);
  const determinant = aa * bb - ab * ab;
  const weightA = (ab * bw - bb * aw) / determinant;
  const weightB = (aa * bw - ab * aw) / determinant;
  for (let k = 0; k < 3; k++) near((c[k] - a[k]) / weightA + (d[k] - b[k]) / weightB, 0, 128 * Number.EPSILON);
  const energy = (u, v) => u.reduce((sum, x, k) => sum + x * x + v[k] * v[k], 0);
  assert.ok(energy(c, d) < energy(a, b));
});
