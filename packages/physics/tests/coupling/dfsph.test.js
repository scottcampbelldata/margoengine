import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DFSPH_LAYOUT,
  DFSPH_PARTICLE_WORDS,
  DFSPH_PARCEL_WORDS,
  DFSPH_PARCEL_LAYOUT,
  DfsphSolver,
} from '../../dist/dfsph.js';
import { Physics } from '../../dist/index.js';
import { ModalSoundSolver } from '../../dist/modal-sound.js';
import { BODY_IMPULSES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { measureSurge } from '../dfsph-lab.mjs';
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
      wallKernel: 'analytic',
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
  // Independently integrate the unit kernel over spherical rings beyond a
  // plane. The smoothed interface energy per unit planar area must be gamma.
  const integrate = (f, lo, hi, intervals) => {
    const step = (hi - lo) / intervals;
    let sum = f(lo) + f(hi);
    for (let i = 1; i < intervals; i++) sum += (i % 2 ? 4 : 2) * f(lo + i * step);
    return (step * sum) / 3;
  };
  const cap = (depth) => {
    const ring = (radius) => {
      const cubic = radius < 0.5 ? 1 - 6 * radius ** 2 * (1 - radius) : 2 * (1 - radius) ** 3;
      return 2 * Math.PI * CUBIC * cubic * radius * (radius - depth);
    };
    const inner = depth < 0.5 ? integrate(ring, depth, 0.5, 128) : 0;
    return inner + integrate(ring, Math.max(0.5, depth), 1, 128);
  };
  const plane = integrate((depth) => Math.hypot(cap(depth), 0.05) - 0.05, 0, 1, 2048);
  const area = spacing ** 2 / (3 * plane);
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
      wallKernel: 'analytic',
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
  assert.equal(liquid.statistics.neighborhoodSearches, 2 * positions.length);
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

class ParcelPool {
  id = 'shallow-pool-stand-in';
  cell = [1, 0, 0];
  constructor(fields, volume, commands) {
    this.fields = fields;
    this.volume = volume;
    this.commands = commands;
  }
  describe() {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.fields.requests, access: 'write' },
        { field: this.fields.receipts, access: 'read' },
      ],
    };
  }
  init(host) {
    this.host = host;
    this.request = host.allocate('parcels', 2 * DFSPH_PARCEL_WORDS * 8, 'f64', DFSPH_PARCEL_LAYOUT);
    this.ledger = host.allocate('ledger', 6 * 8, 'f64', DFSPH_PARCEL_LAYOUT);
    // The donor keeps funds reserved until the recipient reports the actual transfer.
    this.read(this.ledger).set([0, 0, this.volume, 35, 15, -20]);
  }
  read(region) {
    return regionWords(this.host.memory, region);
  }
  step(context) {
    const ledger = this.read(this.ledger);
    const ack = context.inputs.get(this.fields.receipts.name);
    if (ack) {
      const receipts = this.read(ack.region);
      for (let i = 0; i < receipts.length; i += DFSPH_PARCEL_WORDS) {
        const ticket = receipts[i];
        if (ticket <= ledger[1]) continue;
        ledger[1] = ticket;
        ledger[2] -= receipts[i + 5];
        for (let axis = 0; axis < 3; axis++) ledger[3 + axis] -= receipts[i + 6 + axis];
      }
    }
    const request = this.read(this.request);
    request.fill(0);
    for (const [i, row] of (this.commands[ledger[0]] ?? []).entries()) request.set(row, i * DFSPH_PARCEL_WORDS);
    ledger[0]++;
  }
  importPorts() {}
  exportPorts(tick) {
    return [{ field: this.fields.requests.name, region: this.request, tick, cell: this.cell }];
  }
  stateRegions() {
    return [this.request, this.ledger];
  }
  extraState() {
    return [];
  }
}

test('whole parcel requests conserve the surface and fluid volume and momentum in both directions', async () => {
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, memory: worldMemory(false) });
  const liquid = await DfsphSolver.load(world.memory, { parcelCapacity: 2 });
  const particleVolume = 0.125;
  const particleMass = particleVolume * 1000;
  const firstVelocity = [0.1, 0.2, 0.3];
  const pool = new ParcelPool(liquid.parcelFields, particleVolume, [
    [[1, -1, -14, 0, 0, particleVolume, 35, 15, -20]],
    [],
    [
      [2, 0, 0, 0, 0, -particleVolume, 0, 0, 0],
      [3, 99, 0, 0, 0, -particleVolume, 0, 0, 0],
    ],
  ]);
  world.add(pool, {}, pool.cell);
  world.add(liquid, {
    capacity: 2,
    spacing: 0.5,
    bounds: wide,
    viscosity: 0,
    cellSize: 16,
    particles: [{ position: [-2, 0, 0], velocity: firstVelocity }],
  });
  world.couple([pool.id, liquid.id], 'staggered');
  assert.equal(liquid.particleVolume, particleVolume);
  world.advance(2);
  assert.equal(liquid.mass, 2 * particleMass);
  assert.ok(liquid.sample(1).position[0] > 2 && liquid.sample(1).position[0] < 2.1);
  const snapshot = world.takeSnapshot();
  world.advance(6);
  assert.equal(liquid.mass, particleMass);
  const { region } = world.fields.port(liquid.parcelFields.receipts.name);
  const [frame, ticket, volume, px, py, pz] = pool.read(pool.ledger);
  assert.ok(frame >= 6);
  assert.equal(ticket, 3);
  assert.equal(volume + liquid.mass / 1000, 2 * particleVolume);
  const final = liquid.sample(0);
  for (const [axis, retained] of [px, py, pz].entries())
    near(retained + final.velocity[axis] * final.mass, firstVelocity[axis] * particleMass + [35, 15, -20][axis]);
  assert.ok(region.byteLength > 0);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(6);
  assert.equal(world.hash(), hash);
});

test('an over-capacity parcel is declined and consumes no mass or pressure state', async () => {
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, memory: worldMemory(true) });
  const liquid = await DfsphSolver.load(world.memory, { parcelCapacity: 2 });
  const volume = 0.125;
  const pool = new ParcelPool(liquid.parcelFields, volume, [[[1, -1, -14, 0, 0, volume, 35, 15, -20]]]);
  world.add(pool, {}, pool.cell);
  world.add(liquid, { capacity: 0, spacing: 0.5, bounds: wide, viscosity: 0, cellSize: 16 });
  world.couple([pool.id, liquid.id], 'staggered');
  world.advance(5);
  assert.equal(liquid.mass, 0);
  assert.deepEqual([...pool.read(pool.ledger).slice(1)], [1, volume, 35, 15, -20]);
  assert.equal(liquid.statistics.pairEvaluations, 0);
});

test('a final outgoing parcel clears the old hard-contact strike from the modal field', async () => {
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, memory: worldMemory(false) });
  const sound = await ModalSoundSolver.load();
  const liquid = await DfsphSolver.load(world.memory, { parcelCapacity: 2, modalContactField: sound.contactField });
  const volume = 0.125;
  const pool = new ParcelPool(liquid.parcelFields, volume, [[], [[1, 0, 0, 0, 0, -volume, 0, 0, 0]]]);
  world.add(pool, {}, pool.cell);
  world.add(liquid, {
    viscosity: 0,
    wallPressure: false,
    spacing: 0.5,
    particles: [{ position: [0.5, 0.26, 0.5], velocity: [0, -0.8, 0] }],
  });
  world.add(sound, { tracks: [{ material: 'glass' }] });
  world.couple([pool.id, liquid.id], 'staggered');
  const amplitude = () => {
    const { region } = world.fields.port(sound.contactField.name);
    return regionWords(world.memory, region)[0];
  };
  world.advance(1);
  assert.ok(amplitude() > 0);
  world.advance(3);
  assert.equal(liquid.mass, 0);
  assert.equal(amplitude(), 0);
});

test('a retransmitted parcel ticket is acknowledged once through later clock ticks and restore', async () => {
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO });
  const liquid = await DfsphSolver.load(world.memory, { parcelCapacity: 2 });
  const volume = 0.125;
  const batch = [[1, -1, -14, 0, 0, volume, 35, 15, -20]];
  const pool = new ParcelPool(liquid.parcelFields, volume, [batch, batch, batch]);
  world.add(pool, {}, pool.cell);
  world.add(liquid, { capacity: 3, spacing: 0.5, bounds: wide, viscosity: 0, cellSize: 16 });
  world.couple([pool.id, liquid.id], 'staggered');
  world.advance(1);
  const snapshot = world.takeSnapshot();
  world.advance(6);
  const hash = world.hash();
  assert.equal(liquid.statistics.particles, 1);
  assert.deepEqual([...pool.read(pool.ledger).slice(1)], [1, 0, 0, 0, 0]);
  world.restoreSnapshot(snapshot.bytes);
  world.advance(6);
  assert.equal(world.hash(), hash);
});

test('a resting lattice keeps exact discrete density and zero velocity against walls, edges and corners', async () => {
  const spacing = 0.04;
  const size = 4;
  const points = [];
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) points.push({ position: [x, y, z].map((i) => (i + 0.5) * spacing) });
  let density = 0;
  for (let z = -1; z <= 1; z++)
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        const q = Math.sqrt(x * x + y * y + z * z) / 2;
        const w = q <= 0.5 ? 1 - 6 * q ** 2 + 6 * q ** 3 : 2 * (1 - q) ** 3;
        density += (1000 * CUBIC * w) / 8;
      }
  const { world, liquid } = await solve({
    spacing,
    particles: points,
    bounds: [
      [0, 0, 0],
      [size * spacing, size * spacing, size * spacing],
    ],
  });
  world.advance(10);
  assert.equal(liquid.statistics.maximumSpeed, 0);
  for (const [index, point] of points.entries()) {
    near(liquid.sample(index).density, density);
    assert.deepEqual(liquid.sample(index).position, point.position);
  }
});

test('a viscous liquid near a closed plane follows the implicit wall kernel with no contact event', async () => {
  const spacing = 0.06;
  const support = 2 * spacing;
  const viscosity = 0.02;
  const speed = 0.15;
  const { world, liquid } = await solve({
    viscosity,
    spacing,
    support,
    divergenceTolerance: 10,
    bounds: [
      [-0.48, 0, -0.48],
      [0.48, 0.6, 0.48],
    ],
    walls: [false, false, true, false, false, false],
    particles: [{ position: [0.03, 0.5 * spacing, 0.03], velocity: [speed, 0, 0] }],
  });
  let normalizedDrag = 0;
  let normalizedDensity = CUBIC / 8;
  for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++) {
      const q = Math.sqrt(x * x + 1 + z * z) / 2;
      const cubic = 2 * CUBIC * (1 - q) ** 3;
      normalizedDensity += cubic / 8;
      const slope = 6 * CUBIC * (1 - q) ** 2;
      const xx = (x * x) / (4 * q * q);
      normalizedDrag += (10 * q * slope * xx) / (8 * support ** 2 * (q * q + 0.01));
    }
  const expected = speed / (1 + (DT * viscosity * normalizedDrag) / normalizedDensity ** 2);
  world.advance(1);
  near(liquid.sample(0).velocity[0], expected);
  assert.ok(liquid.sample(0).velocity[0] < speed);
  near(liquid.sample(0).velocity[1], 0);
  near(liquid.sample(0).velocity[2], 0);
});

test('analytic wall shear dissipates tangential motion and vanishes beyond the kernel', async () => {
  let previous = 0;
  const initial = 0.1;
  for (const y of [0.03, 0.06, 0.119, 0.12, 0.18]) {
    const { world, liquid } = await solve({
      wallKernel: 'analytic',
      spacing: 0.06,
      viscosity: 0.02,
      walls: [false, false, true, false, false, false],
      particles: [{ position: [0.5, y, 0.5], velocity: [initial, 0, 0] }],
    });
    world.advance(1);
    const speed = liquid.sample(0).velocity[0];
    assert.ok(speed >= previous && speed <= initial);
    if (y < 0.12) assert.ok(speed < initial);
    else near(speed, initial);
    previous = speed;
  }
});

test('advecting across grid cells rebuilds candidates before the divergence pass', async () => {
  const { world, liquid } = await solve({
    spacing: 0.5,
    support: 1,
    bounds: wide,
    divergenceTolerance: 1e-13,
    particles: [
      { position: [0.99, 0, 0], velocity: [0.9, 0, 0] },
      { position: [2.01, 0, 0], velocity: [-0.9, 0, 0] },
    ],
  });
  world.advance(1);
  near(liquid.sample(0).position[0], 0.99 + DT * 0.9);
  near(liquid.sample(1).position[0], 2.01 - DT * 0.9);
  near(liquid.sample(0).velocity[0], 0);
  near(liquid.sample(1).velocity[0], 0);
  assert.equal(liquid.statistics.neighborhoodSearches, 4);
  assert.equal(liquid.statistics.divergenceIterations, 1);
});

test('the accurate liquid reproduces the fundamental gravity-wave period in a closed rectangular tank', {
  timeout: 45000,
}, async () => {
  // NASA SP-106, section 2.2: omega² = g*k*tanh(k*h), k = pi / tank length.
  // Start at the equilibrium surface with the mode's divergence-free velocity.
  const rate = 120;
  const spacing = 0.045;
  const nx = 20;
  const ny = 8;
  const nz = 4;
  const length = nx * spacing;
  const depth = ny * spacing;
  const width = nz * spacing;
  const gravity = 9.81;
  const k = Math.PI / length;
  const omega = Math.sqrt(gravity * k * Math.tanh(k * depth));
  const expectedPeriod = (2 * Math.PI) / omega;
  const amplitude = 0.02 * length;
  const factor = (amplitude * omega) / Math.sinh(k * depth);
  const particles = [];
  const ends = [];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const position = [x, y, z].map((i) => (i + 0.5) * spacing);
        const [px, py] = position;
        const velocity = [
          -factor * Math.sin(k * px) * Math.cosh(k * py),
          factor * Math.cos(k * px) * Math.sinh(k * py),
          0,
        ];
        if (y === ny - 1 && (x < 2 || x >= nx - 2)) ends.push([particles.length, x < 2 ? 1 : -1]);
        particles.push({ position, velocity });
      }
  const { world, liquid } = await solve(
    {
      spacing,
      viscosity: 1e-6,
      particles,
      bounds: [
        [0, 0, 0],
        [length, depth + 4 * spacing, width],
      ],
    },
    { gravity: [0, -gravity, 0], rate: { num: rate, den: 1 } },
    { rate: 1 },
  );
  let previous = 0;
  let crest = 0;
  let period = NaN;
  for (let frame = 1; frame <= Math.ceil(1.5 * rate * expectedPeriod); frame++) {
    world.advance(frame);
    const surface = ends.reduce((sum, [i, sign]) => sum + sign * liquid.sample(i).position[1], 0) / (2 * nz);
    crest = Math.max(crest, surface);
    if (previous < 0 && surface > 0 && crest > amplitude / 2) {
      period = (frame - 1 + previous / (previous - surface)) / rate;
      break;
    }
    previous = surface;
  }
  assert.ok(Math.abs(period - expectedPeriod) <= 1 / rate, `wave period ${period} versus ${expectedPeriod} s`);
  near(liquid.mass, 1000 * length * depth * width);
});

test('partial and disabled pressure caches preserve pair forces exactly', async () => {
  const count = 40;
  const particles = Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count;
    return {
      position: [0.38 * Math.cos(angle), 0, 0.38 * Math.sin(angle)],
      velocity: [0.03 * Math.cos(angle), 0, 0.03 * Math.sin(angle)],
    };
  });
  const identical = [];
  for (const cacheNeighbors of [false, true]) {
    const { world, liquid } = await solve({
      particles,
      spacing: 0.5,
      support: 1,
      viscosity: 0.01,
      cacheNeighbors,
      densityIterations: 1,
      bounds: wide,
    });
    assert.equal(liquid.statistics.pairEvaluations, count * (count - 1));
    if (cacheNeighbors) {
      assert.ok(liquid.statistics.cachedPressurePairs > 0);
      assert.ok(liquid.statistics.cachedPressurePairs < liquid.statistics.pairEvaluations);
    } else {
      assert.equal(liquid.statistics.cachedPressurePairs, 0);
    }
    world.advance(1);
    identical.push(particles.map((_, row) => liquid.sample(row)));
  }
  assert.deepEqual(identical[0], identical[1]);
});

test('refined accurate DFSPH matches both measured Martin–Moyce surge intervals', { timeout: 90000 }, async () => {
  const trials = await measureSurge({ profile: 'accurate', resolution: 18, capillarity: true });
  for (const { elapsed, minimum, maximum, error, matches } of trials)
    assert.ok(matches, `surge interval ${elapsed} outside ${minimum}–${maximum} ± ${error}`);
});
