import assert from 'node:assert/strict';
import test from 'node:test';
import { DFSPH_LAYOUT, DFSPH_PARTICLE_WORDS, DfsphSolver } from '../../dist/dfsph.js';
import { Physics } from '../../dist/index.js';
import { ModalSoundSolver } from '../../dist/modal-sound.js';
import { BODY_IMPULSES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const ZERO = [0, 0, 0];
const RATE = { num: 60, den: 1 };
const DT = 1 / RATE.num;
const CUBIC = 8 / Math.PI;
const wide = [
  [-8, -8, -8],
  [8, 8, 8],
];

function near(actual, expected, roundings = 128) {
  assert.ok(
    Math.abs(actual - expected) <= roundings * Number.EPSILON * Math.max(1, Math.abs(expected)),
    `${actual} vs ${expected}`,
  );
}

function pair(distance, velocity) {
  return [
    { position: [-distance / 2, 0, 0], velocity },
    { position: [distance / 2, 0, 0], velocity: velocity.map((value) => -value) },
  ];
}

async function solve(params, worldOptions = {}, options = {}) {
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, ...worldOptions });
  const liquid = await DfsphSolver.load(world.memory, options);
  world.add(liquid, { viscosity: 0, friction: 0, ...params });
  return { world, liquid };
}

test('published cubic self density and one gravity step match exact isolated-particle motion', async () => {
  const { world, liquid } = await solve(
    { particles: [{ position: [0.5, 0.75, 0.5], velocity: [0.2, 0, 0] }] },
    { gravity: [0, -9.81, 0] },
  );
  near(liquid.sample(0).density, (1000 * CUBIC) / 8);
  near(liquid.mass, 0.216);
  world.advance(1);
  assert.equal(liquid.statistics.substeps, 1);
  near(liquid.sample(0).position[0], 0.5 + DT * 0.2);
  near(liquid.sample(0).position[1], 0.75 - 9.81 * DT * DT);
  near(liquid.sample(0).velocity[1], -9.81 * DT);
  const { region } = world.fields.port(liquid.particleField.name);
  assert.equal(region.layout, DFSPH_LAYOUT);
  assert.equal(region.byteLength, 8 * DFSPH_PARTICLE_WORDS);
  near(regionWords(world.memory, region)[7], 0.216);
});

test('constant-density pressure solves the exact first-order compression of a symmetric pair', async () => {
  const spacing = 0.65;
  const distance = 0.3;
  const volume = spacing ** 3;
  const density = volume * CUBIC * (2 - 6 * distance ** 2 * (1 - distance));
  const gradient = volume * CUBIC * distance * (12 - 18 * distance);
  const predictedSpeed = (density - 1) / (2 * gradient * DT);
  for (const scale of [1e-6, 1, 1e4]) {
    const { world, liquid } = await solve({
      spacing: spacing * scale,
      support: scale,
      bounds: wide.map((v) => v.map((x) => x * scale)),
      particles: pair(distance * scale, ZERO),
      densityTolerance: 1e-13,
    });
    near(liquid.sample(0).density / 1000, density);
    world.advance(1);
    assert.equal(liquid.statistics.densityIterations, 1);
    assert.equal(liquid.statistics.divergenceIterations, 0);
    near(liquid.statistics.compression, 0);
    near(liquid.sample(0).velocity[0] / scale, -predictedSpeed);
    near(liquid.sample(1).velocity[0] / scale, predictedSpeed);
    near(liquid.sample(0).position[0] / scale, -distance / 2 - predictedSpeed * DT);
  }
});

test('post-advection divergence pressure cancels approaching underdense velocities without tensile force', async () => {
  for (const direction of [-1, 1]) {
    const speed = 0.2 * direction;
    const { world, liquid } = await solve({
      spacing: 0.5,
      support: 1,
      bounds: wide,
      particles: pair(0.4, [speed, 0, 0]),
      divergenceTolerance: 1e-13,
    });
    world.advance(1);
    assert.equal(liquid.statistics.densityIterations, 0);
    assert.equal(liquid.statistics.divergenceIterations, direction === 1 ? 1 : 0);
    near(liquid.sample(0).position[0], -0.2 + speed * DT);
    near(liquid.sample(0).velocity[0], direction === 1 ? 0 : speed);
    near(liquid.sample(0).velocity[0] + liquid.sample(1).velocity[0], 0);
  }
});

test('implicit viscosity damps an axial pair by the closed form and produces no torque on a rigid rotation', async () => {
  const spacing = 0.5;
  const r = 0.35;
  const viscosity = 1e5;
  const speed = 0.15;
  const volume = spacing ** 3;
  const relativeDensity = volume * CUBIC * (2 - 6 * r ** 2 * (1 - r));
  const gradient = volume * CUBIC * r * (12 - 18 * r);
  const weight = (10 * viscosity * DT * r * gradient) / ((r ** 2 + 0.01) * relativeDensity ** 2);
  for (const profile of ['accurate', 'interactive']) {
    const { world, liquid } = await solve({
      viscosity,
      spacing,
      support: 1,
      bounds: wide,
      profile,
      particles: pair(r, [-speed, 0, 0]),
    });
    world.advance(1);
    const remaining = speed / (1 + 2 * weight);
    assert.equal(liquid.statistics.viscosityIterations, 1);
    near(liquid.sample(0).velocity[0], -remaining);
    near(liquid.sample(1).velocity[0], remaining);
    const rotation = await solve({ viscosity, spacing, support: 1, bounds: wide, particles: pair(r, [0, speed, 0]) });
    rotation.world.advance(1);
    assert.equal(rotation.liquid.statistics.viscosityIterations, 0);
    near(rotation.liquid.sample(0).velocity[1], speed);
    near(rotation.liquid.sample(1).velocity[1], -speed);
  }
});

test('both profiles run the sparse-grid interactions without traversing distant particles', async () => {
  const particles = Array.from({ length: 256 }, (_, i) => ({ position: [3 * i, -73, 18] }));
  for (const profile of ['interactive', 'accurate']) {
    const { world, liquid } = await solve({
      profile,
      particles,
      capacity: particles.length * 4,
      support: 1,
      bounds: [
        [0, -100, 0],
        [1000, 0, 100],
      ],
    });
    world.advance(1);
    assert.equal(liquid.statistics.pairEvaluations, 0);
    assert.equal(liquid.statistics.substeps, 1);
    assert.equal(liquid.statistics.particles, particles.length);
  }
});

test('advective CFL catches a fast droplet, and open faces retain its mass', async () => {
  for (const floor of [false, true]) {
    const speed = 63;
    const { world, liquid } = await solve({
      walls: [true, true, floor, true, true, true],
      wallPressure: false,
      particles: [{ position: [0.3, 0.5, 0.4], velocity: [0, -speed, 0] }],
    });
    world.advance(1);
    const cfl = (0.4 * 0.06) / speed;
    assert.equal(liquid.statistics.substeps, floor ? Math.ceil((0.5 - 0.03) / (0.4 * 0.06)) + 1 : Math.ceil(DT / cfl));
    near(liquid.sample(0).position[1], floor ? 0.03 : 0.5 - speed * DT);
    near(liquid.sample(0).velocity[1], floor ? 0 : -speed);
    near(liquid.mass, 0.216);
  }
});

async function withPlate(shared, offset = 0) {
  await Physics.load({ threads: shared });
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, memory: worldMemory(shared) });
  const rigid = new Physics(null, { arena: world.arena, gravity: ZERO, fixedTimestep: DT });
  const halfExtents = [0.035, 0.19, 0.19];
  const plate = rigid.addBody(null, {
    position: [0.4 + offset, 0.45, 0.5],
    colliders: { shape: 'box', halfExtents, mass: 2, sensor: true },
  });
  world.add(new RigidSolver(), { physics: rigid, capacity: rigid.kernel.capacity }, offset ? [0, 0, 0] : [1, 0, 0]);
  const liquid = await DfsphSolver.load(world.memory, { rigid: true });
  world.add(
    liquid,
    {
      bounds: wide,
      spacing: 0.03,
      support: 0.06,
      cellSize: 16,
      viscosity: 0,
      friction: 0,
      boundaries: [{ body: plate.row, halfExtents }],
      particles: [{ position: [0.3, 0.54, 0.5], velocity: [2, 0, 0] }],
    },
    [1, 0, 0],
  );
  world.couple(['rigid', liquid.id], 'staggered');
  return { liquid, world, rigid, plate };
}

test('pressure on a real rigid plate conserves total momentum in different origin cells and produces torque', async () => {
  for (const offset of [0, 16]) {
    const { liquid, world, rigid, plate } = await withPlate(false, offset);
    try {
      const initial = liquid.mass * 2;
      for (let frame = 1; frame <= 7; frame++) {
        world.advance(frame);
        const { region } = liquid.exportPorts(frame).find(({ field }) => field === BODY_IMPULSES_FIELD.name);
        const pending = regionWords(world.memory, region)[6 * plate.row];
        const remaining = pending + 2 * plate.linearVelocity[0] + liquid.mass * liquid.sample(0).velocity[0];
        assert.ok(Math.abs(remaining - initial) <= frame * initial * 2 ** -22);
      }
      assert.ok(plate.linearVelocity[0] > 0);
      assert.ok(plate.angularVelocity[2] < 0);
    } finally {
      rigid.dispose();
    }
  }
});

test('warm pressure and the dual-clock fluid replay bit-for-bit on both memory modes', async () => {
  const particles = pair(0.3, [0.2, 0, 0]);
  const make = async (num, shared) =>
    (
      await solve(
        { spacing: 0.65, support: 1, bounds: wide, particles },
        { rate: { num, den: 1 }, memory: worldMemory(shared) },
        { rate: 1 },
      )
    ).world;
  const prepared = new Map(await Promise.all([24, 30, 60].map(async (num) => [num, await make(num, false)])));
  frameRateIndependent(({ num }) => prepared.get(num));
  const replay = await Promise.all([make(24, false), make(24, false)]);
  seekEqualsContinuous(() => replay.pop(), { frames: 24 });
  const shared = await make(60, true);
  shared.advance(60);
  assert.equal(shared.hash(), prepared.get(60).hash());
});

test('the native floor impulse drives the real modal solver once and emits audible signed PCM', async () => {
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO });
  const sound = await ModalSoundSolver.load();
  const liquid = await DfsphSolver.load(world.memory, { modalContactField: sound.contactField });
  world.add(liquid, {
    particles: [{ position: [0.5, 0.04, 0.5], velocity: [0, -0.8, 0] }],
    viscosity: 0,
    wallPressure: false,
  });
  world.add(sound, { tracks: [{ material: 'glass' }] });
  world.advance(1);
  const contact = world.fields.port(sound.contactField.name);
  near(regionWords(world.memory, contact.region)[0], liquid.mass * 0.8);
  world.advance(2);
  assert.equal(regionWords(world.memory, world.fields.port(sound.contactField.name).region)[0], 0);
  const { region } = world.fields.port(sound.pcmField.name);
  const pcm = regionWords(world.memory, region);
  assert.ok(pcm.some((value) => value > 0) && pcm.some((value) => value < 0));
});

test('unrepresentable advection is a failed solver step with a named fix', async () => {
  const { world } = await solve({ particles: [{ position: [0.5, 0.5, 0.5], velocity: [1e250, 0, 0] }] });
  assert.throws(() => world.advance(1), /Increase resolution in time or reduce velocity/);
});

test('one closed planar wall adds the exact cubic kernel integral on either half of its support', async () => {
  for (const [height, wallDensity] of [
    [0, 0.5],
    [0.5, 1 / 30],
    [1, 0],
  ]) {
    const { liquid } = await solve({
      spacing: 0.5,
      support: 1,
      bounds: [
        [-8, 0, -8],
        [8, 8, 8],
      ],
      walls: [false, false, true, false, false, false],
      particles: [{ position: [0, height, 0] }],
    });
    near(liquid.sample(0).density / 1000, CUBIC / 8 + wallDensity);
  }
});

test('the free surface follows the published energy gradient with matched pair momentum', async () => {
  const spacing = 0.5;
  const distance = 0.7;
  const surface = 0.072;
  const h = 3 * spacing;
  const q = distance / h;
  const volume = spacing ** 3;
  const contribution = 1 - (volume / h ** 3) * CUBIC * (2 - 6 * q ** 2 + 6 * q ** 3);
  const slope = contribution / Math.sqrt(contribution ** 2 + 0.05 ** 2);
  const gradient = (CUBIC * q * (12 - 18 * q)) / h ** 4;
  const area = (Math.PI / 4) * spacing ** 2;
  const impulse = 2 * DT * surface * slope * area * volume * gradient;
  const { world, liquid } = await solve({
    spacing,
    support: 1,
    bounds: wide,
    particles: pair(distance, ZERO),
    surfaceTension: surface,
    divergenceTolerance: 10,
  });
  world.advance(1);
  near(liquid.sample(0).velocity[0] * liquid.sample(0).mass, impulse);
  near(liquid.sample(1).velocity[0] * liquid.sample(1).mass, -impulse);
  assert.ok(liquid.sample(0).position[0] > -distance / 2);
});

test('equal solid interface energies cancel for an analytic wall and their difference controls wetting', async () => {
  const height = 0.36;
  for (const [solidLiquidTension, solidVaporTension, sign] of [
    [0.08, 0, 1],
    [0.08, 0.08, 0],
    [0, 0.08, -1],
  ]) {
    const { world, liquid } = await solve({
      spacing: 0.5,
      support: 1,
      bounds: [
        [-8, 0, -8],
        [8, 8, 8],
      ],
      walls: [false, false, true, false, false, false],
      wallPressure: false,
      solidLiquidTension,
      solidVaporTension,
      particles: [{ position: [0, height, 0] }],
    });
    world.advance(1);
    assert.equal(Math.sign(liquid.sample(0).position[1] - height), sign);
  }
});

test('sampled solid wetting exchanges opposite capillary force with the real rigid plate', async () => {
  await Physics.load({ threads: false });
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, memory: worldMemory(false) });
  const rigid = new Physics(null, { arena: world.arena, gravity: ZERO, fixedTimestep: DT });
  try {
    const halfExtents = [0.04, 0.2, 0.2];
    const body = rigid.addBody(null, {
      position: [0.46, 0.45, 0.5],
      colliders: { shape: 'box', halfExtents, mass: 2, sensor: true },
    });
    world.add(new RigidSolver(), { physics: rigid, capacity: rigid.kernel.capacity });
    const liquid = await DfsphSolver.load(world.memory, { rigid: true });
    world.add(liquid, {
      spacing: 0.04,
      viscosity: 0,
      wallPressure: false,
      solidVaporTension: 0.072,
      densityTolerance: 1,
      divergenceTolerance: 10,
      boundaries: [{ body: body.row, halfExtents }],
      particles: [{ position: [0.34, 0.49, 0.5] }],
    });
    world.couple(['rigid', liquid.id], 'staggered');
    world.advance(1);
    const { region } = liquid.exportPorts(1).find(({ field }) => field === BODY_IMPULSES_FIELD.name);
    const momentum = liquid.sample(0).velocity[0] * liquid.sample(0).mass;
    assert.ok(momentum > 0);
    near(regionWords(world.memory, region)[6 * body.row], -momentum);
  } finally {
    rigid.dispose();
  }
});

test('coupled pressure constraints reach the minimum-impulse velocity in a compressed three-particle chain', async () => {
  const positions = [-0.65, 0, 0.7];
  const velocities = [0.5, -0.1, -0.5];
  const expected = velocities.reduce((a, b) => a + b) / velocities.length;
  // The two end constraints require v0 <= v1 <= v2 because only adjacent
  // particles interact. The projection of the descending input is its mean.
  const tolerance = 1e-12;
  const volume = 0.5 ** 3;
  const gaps = [0, 1].map((i) => positions[i + 1] - positions[i] + DT * (velocities[i + 1] - velocities[i]));
  const weakestGradient = Math.min(...gaps.map((q) => 6 * CUBIC * volume * (1 - q) ** 2));
  const bound = (3 * tolerance) / weakestGradient;
  const { world, liquid } = await solve({
    spacing: 0.5,
    support: 1,
    bounds: wide,
    divergenceTolerance: tolerance,
    divergenceIterations: 512,
    particles: positions.map((x, i) => ({ position: [x, 0, 0], velocity: [velocities[i], 0, 0] })),
  });
  world.advance(1);
  assert.ok(liquid.statistics.divergenceIterations > 1);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(liquid.sample(i).velocity[0] - expected) <= bound);
});

test('wet capillarity and warm pressure restore in the middle of a native step sequence', async () => {
  let other;
  for (const shared of [false, true]) {
    const { world } = await solve(
      {
        spacing: 0.11,
        support: 0.22,
        bounds: wide,
        surfaceTension: 0.07274,
        particles: pair(0.18, [0.04, 0, 0]),
        boundaries: [{ shape: 'sphere', centre: [0, -0.18, 0], radius: 0.1 }],
        solidVaporTension: 0.06,
      },
      { memory: worldMemory(shared) },
    );
    world.advance(8);
    const snapshot = world.takeSnapshot();
    world.advance(18);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(18);
    assert.equal(world.hash(), hash);
    if (other !== undefined) assert.equal(hash, other);
    other = hash;
  }
});
