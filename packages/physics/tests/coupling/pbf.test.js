import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { PBF_LAYOUT, PBF_PARTICLE_WORDS, PbfSolver } from '../../dist/pbf.js';
import { BODY_IMPULSES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const ZERO = [0, 0, 0];
const RATE = { num: 60, den: 1 };
const POLY6 = 315 / (64 * Math.PI);
const wide = [
  [-8, -8, -8],
  [8, 8, 8],
];
const relaxed = { iterations: 1, tensile: 0, viscosity: 0, friction: 0 };

function near(actual, expected, error = 1e-11) {
  assert.ok(Math.abs(actual - expected) <= error, `${actual} vs ${expected} ± ${error}`);
}

const solve = async (params, worldOptions = {}, options = {}) => {
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, ...worldOptions });
  const pbf = await PbfSolver.load(world.memory, options);
  world.add(pbf, params);
  return { world, pbf };
};

test('PbfSolver publishes the exact Poly6 self density and the closed-form free flight', async () => {
  const particles = [{ position: [0.4, 0.8, 0.5], velocity: [0.2, 0, 0] }];
  const { world, pbf } = await solve({ particles, ...relaxed }, { gravity: [0, -9.81, 0] });
  near(pbf.sample(0).density, (1000 * POLY6) / 8);
  near(pbf.mass, 0.216);
  const frames = 12;
  world.advance(frames);
  const point = pbf.sample(0);
  near(point.position[1], 0.8 - (9.81 * frames * (frames + 1)) / (2 * 60 * 60));
  near(point.velocity[1], (-9.81 * frames) / 60);
  near(point.position[0], 0.4 + (0.2 * frames) / 60);
  const { region } = world.fields.port(pbf.particleField.name);
  assert.equal(region.layout, PBF_LAYOUT);
  assert.equal(region.byteLength, 8 * PBF_PARTICLE_WORDS);
  near(regionWords(world.memory, region)[7], point.mass);
});

test('static contacts and density corrections do not create mechanical energy', async () => {
  const gravity = 9.81;
  const { world, pbf } = await solve(
    {
      particles: [{ position: [0.46, 0.28, 0.5] }, { position: [0.54, 0.28, 0.5] }],
      spacing: 0.09,
      support: 0.12,
      friction: 0,
    },
    { gravity: [0, -gravity, 0] },
  );
  const energy = () =>
    [pbf.sample(0), pbf.sample(1)].reduce(
      (sum, p) =>
        sum +
        p.mass *
          (0.5 * p.velocity.reduce((speed, component) => speed + component * component, 0) + gravity * p.position[1]),
      0,
    );
  let previous = energy();
  for (let frame = 1; frame <= 30; frame++) {
    world.advance(frame);
    const current = energy();
    assert.ok(current <= previous + 128 * Number.EPSILON * previous);
    previous = current;
  }
});

test('the first native Jacobi projection matches equations 11–14 and preserves pair momentum', async () => {
  const r = 0.2;
  const spacing = 0.75;
  const correction = 0.003;
  const q = 0.3;
  const relaxation = 0.02;
  const volume = spacing ** 3;
  const W = (x) => POLY6 * (1 - x * x) ** 3;
  const density = volume * (W(0) + W(r));
  const gradient = (45 / Math.PI) * (1 - r) ** 2 * volume;
  const lambda = -(density - 1) / (2 * gradient * gradient + relaxation);
  const delta = (2 * lambda - correction * (W(r) / W(q)) ** 4) * gradient;
  const { world, pbf } = await solve({
    ...relaxed,
    spacing,
    support: 1,
    bounds: wide,
    tensile: correction,
    relaxation,
    particles: [{ position: [-r / 2, 0, 0] }, { position: [r / 2, 0, 0] }],
  });
  near(pbf.sample(0).density, 1000 * density);
  world.advance(1);
  near(pbf.sample(0).position[0], -r / 2 + delta);
  near(pbf.sample(1).position[0], r / 2 - delta);
  near((pbf.sample(0).velocity[0] + pbf.sample(1).velocity[0]) * pbf.sample(0).mass, 0);
  assert.ok(pbf.statistics.peakCompression < density - 1);
});

test('the same dimensionless density solve holds at micrometre and kilometre scales', async () => {
  let reference;
  for (const h of [1, 1e-6, 1e4]) {
    const { world, pbf } = await solve({
      ...relaxed,
      spacing: 0.75 * h,
      support: h,
      bounds: wide.map((corner) => corner.map((value) => value * h)),
      particles: [{ position: [-0.1 * h, 0, 0] }, { position: [0.1 * h, 0, 0] }],
    });
    world.advance(1);
    const row = pbf.sample(0);
    const measurement = [row.position[0] / h, row.density];
    if (reference)
      measurement.forEach((value, axis) =>
        near(value, reference[axis], 32 * Number.EPSILON * Math.max(1, Math.abs(value))),
      );
    reference = measurement;
  }
});

test('an under-filled free surface cannot pull itself together unless cohesion is selected', async () => {
  for (const cohesive of [false, true]) {
    const { world, pbf } = await solve({
      ...relaxed,
      cohesive,
      spacing: 0.5,
      support: 1,
      bounds: wide,
      particles: [{ position: [-0.2, 0, 0] }, { position: [0.2, 0, 0] }],
    });
    world.advance(1);
    const separation = pbf.sample(1).position[0] - pbf.sample(0).position[0];
    if (cohesive) assert.ok(separation < 0.4);
    else near(separation, 0.4);
    near(pbf.sample(0).velocity[0] + pbf.sample(1).velocity[0], 0);
  }
});

test('artificial pressure preserves underfilled rest and scales displacement with the squared step', async () => {
  const { world, pbf } = await solve({
    ...relaxed,
    spacing: 0.09,
    support: 0.12,
    bounds: wide,
    tensile: 0.001,
    particles: [{ position: [-0.04, 0, 0] }, { position: [0.04, 0, 0] }],
  });
  assert.ok(pbf.sample(0).density < 1000);
  world.advance(1);
  near(pbf.sample(0).position[0], -0.04);
  near(pbf.sample(1).position[0], 0.04);

  const displacements = [];
  for (const rate of [60, 120]) {
    const positions = [];
    for (const tensile of [0, 0.003]) {
      const fixture = await solve(
        {
          ...relaxed,
          spacing: 0.75,
          support: 1,
          bounds: wide,
          tensile,
          particles: [{ position: [-0.1, 0, 0] }, { position: [0.1, 0, 0] }],
        },
        { rate: { num: rate, den: 1 } },
        { rate: rate === 60 ? 0 : 1 },
      );
      fixture.world.advance(1);
      assert.equal(fixture.pbf.statistics.substeps, 1);
      positions.push(fixture.pbf.sample(0).position[0]);
    }
    displacements.push(positions[0] - positions[1]);
  }
  assert.ok(displacements[0] > 0);
  near(displacements[1] * 4, displacements[0]);
});

test('XSPH blends equal and opposite velocities by the kernel weight and dissipates their kinetic energy', async () => {
  const speed = 0.15;
  const spacing = 0.5;
  const initialSeparation = 0.4;
  const viscosity = 0.25;
  const { world, pbf } = await solve({
    ...relaxed,
    spacing,
    support: 1,
    bounds: wide,
    tolerance: 1,
    viscosity,
    particles: [
      { position: [-0.2, 0, 0], velocity: [speed, 0, 0] },
      { position: [0.2, 0, 0], velocity: [-speed, 0, 0] },
    ],
  });
  world.advance(1);
  const distance = initialSeparation - (2 * speed) / 60;
  const weight = spacing ** 3 * POLY6 * (1 - distance * distance) ** 3;
  const expected = speed * (1 - 2 * viscosity * weight);
  const velocities = [pbf.sample(0).velocity[0], pbf.sample(1).velocity[0]];
  near(velocities[0], expected);
  near(velocities[1], -expected);
  assert.ok(velocities[0] ** 2 + velocities[1] ** 2 < 2 * speed ** 2);
});

test('both profiles use sparse 27-cell candidates with linear work on separated particles', async () => {
  const particles = Array.from({ length: 256 }, (_, i) => ({ position: [3 * i, -73, 18] }));
  for (const [profile, iterations] of [
    ['fast', 4],
    ['precise', 12],
  ]) {
    const { world, pbf } = await solve({
      profile,
      particles,
      capacity: 16 * particles.length,
      spacing: 0.5,
      support: 1,
      bounds: [
        [0, -100, 0],
        [1000, 0, 100],
      ],
      viscosity: 0,
      vorticity: 0,
      tensile: 0,
    });
    world.advance(1);
    assert.equal(pbf.statistics.projections, iterations);
    assert.equal(pbf.statistics.pairEvaluations, (iterations + 1) * particles.length);
    assert.equal(pbf.statistics.substeps, 1);
  }
});

test('CFL subdivision catches a fast droplet on the proper wall and an open face retains its mass', async () => {
  for (const floor of [true, false]) {
    const speed = 63;
    const { world, pbf } = await solve({
      ...relaxed,
      walls: [true, true, floor, true, true, true],
      particles: [{ position: [0.3, 0.5, 0.4], velocity: [0, -speed, 0] }],
    });
    world.advance(1);
    assert.equal(pbf.statistics.substeps, 1 + Math.floor(speed / (60 * 0.4 * 0.12)));
    near(pbf.sample(0).position[1], floor ? 0.03 : 0.5 - speed / 60);
    near(pbf.sample(0).velocity[1], floor ? 0 : -speed, 1e-10);
    near(pbf.mass, 0.216);
  }
});

test('both preview tiers resolve measured Martin–Moyce surge intervals independently of the release clock', {
  timeout: 45000,
}, async () => {
  // Table 2 plane rectangular section, a = 2¼ in, H = 2a, tank thickness a.
  // Use the same experiment columns at Z = 1.44, 2.33 and 3.00; subtract their individual time origins.
  const measured = [
    [0.71, 1.14],
    [1.19, 1.67],
  ];
  const a = 0.05715;
  const g = 9.81;
  const n = 12;
  const clock = 480;
  const spacing = a / n;
  const particles = [];
  for (let x = 0; x < n; x++)
    for (let y = 0; y < 2 * n; y++)
      for (let z = 0; z < n; z++)
        particles.push({ position: [(x + 0.5) * spacing, (y + 0.5) * spacing, (z + 0.5) * spacing] });
  const target = [1.44, 2.33, 3.0];
  for (const profile of ['fast', 'precise']) {
    const { world, pbf } = await solve(
      {
        spacing,
        profile,
        bounds: [
          [0, 0, 0],
          [8 * a, 3 * a, a],
        ],
        particles,
      },
      { rate: { num: clock, den: 1 }, gravity: [0, -g, 0] },
      { rate: 3 },
    );
    const captured = [];
    let previous = 1;
    const storage = new Float32Array(particles.length * 3);
    const rateScale = Math.sqrt((2 * g) / a);
    const dt = rateScale / clock;
    for (let frame = 1; frame <= 100 && captured.length < target.length; frame++) {
      world.advance(frame);
      pbf.positions(storage);
      let front = a;
      for (let i = 0; i < storage.length; i += 3)
        if (storage[i + 1] < 2 * spacing) front = Math.max(front, storage[i] + 0.5 * spacing);
      const normalized = front / a;
      while (normalized >= target[captured.length])
        captured.push((frame - 1 + (target[captured.length] - previous) / (normalized - previous)) * dt);
      previous = normalized;
    }
    assert.equal(captured.length, target.length);
    for (let slot = 0; slot < measured.length; slot++) {
      const [minimum, maximum] = measured[slot];
      // Two simulated brackets, two rounded table entries, and half of a 300 fps frame per
      // experimental crossing (section 3, each trial timed from an oscillator on the film).
      const error = 2 * dt + 0.01 + rateScale / 300;
      const elapsed = captured[slot + 1] - captured[0];
      assert.ok(
        elapsed >= minimum - error && elapsed <= maximum + error,
        `${profile} arrival interval ${elapsed} outside ${minimum}..${maximum} ± ${error}`,
      );
    }
    near(pbf.mass, 1000 * a * (2 * a) * a, 32 * Number.EPSILON);
  }
});

test('analytic sphere and capsule contacts stop a droplet at their expanded radial surfaces', async () => {
  const wall = 0.5;
  const solidRadius = 0.1;
  const particleRadius = 0.01;
  for (const shape of ['sphere', 'capsule']) {
    const y = shape === 'capsule' ? 0.59 : 0.5;
    const { world, pbf } = await solve({
      ...relaxed,
      tolerance: 1,
      spacing: 0.02,
      radius: particleRadius,
      boundaries: [{ shape, centre: [wall, 0.5, 0.5], radius: solidRadius, halfSegment: 0.16 }],
      particles: [{ position: [0.33, y, 0.5], velocity: [2, 0, 0] }],
    });
    world.advance(4);
    near(pbf.sample(0).position[0], wall - solidRadius - particleRadius);
    near(pbf.sample(0).velocity[0], 0);
  }
});

async function withPlate(shared, offset = 0) {
  await Physics.load({ threads: shared });
  const world = new PhysicsWorld({ rate: RATE, gravity: ZERO, memory: worldMemory(shared) });
  const rigid = new Physics(null, { arena: world.arena, gravity: ZERO, fixedTimestep: 1 / 60 });
  const halfExtents = [0.035, 0.19, 0.19];
  const plate = rigid.addBody(null, {
    position: [0.4 + offset, 0.45, 0.5],
    colliders: { shape: 'box', halfExtents, mass: 2, sensor: true },
  });
  const bodyCapacity = rigid.kernel.capacity;
  world.add(new RigidSolver(), { physics: rigid, capacity: bodyCapacity }, offset ? [0, 0, 0] : [1, 0, 0]);
  const pbf = await PbfSolver.load(world.memory, { rigid: true });
  world.add(
    pbf,
    {
      ...relaxed,
      bounds: wide,
      spacing: 0.03,
      support: 0.06,
      cellSize: 16,
      boundaries: [{ body: plate.row, halfExtents }],
      particles: [{ position: [0.3, 0.54, 0.5], velocity: [2, 0, 0] }],
    },
    [1, 0, 0],
  );
  world.couple(['rigid', pbf.id], 'staggered');
  return { pbf, world, rigid, plate };
}

test('a real RigidSolver plate receives the opposite fluid impulse, torque and the translated body cell', async () => {
  for (const offset of [0, 16]) {
    const { pbf, world, rigid, plate } = await withPlate(false, offset);
    try {
      const expected = pbf.mass * 2;
      let strongest = 0;
      for (let frame = 1; frame <= 9; frame++) {
        world.advance(frame);
        const contribution = pbf.exportPorts(frame).find(({ field }) => field === BODY_IMPULSES_FIELD.name);
        const pending = regionWords(world.memory, contribution.region)[6 * plate.row];
        strongest = Math.max(strongest, pending);
        const sum = pending + 2 * plate.linearVelocity[0] + pbf.mass * pbf.sample(0).velocity[0];
        // The released rigid body stores current velocities in f32. The fluid and pending reaction remain f64.
        near(sum, expected, 9 * expected * 2 ** -22);
      }
      assert.ok(strongest > 0 && plate.linearVelocity[0] > 0);
      assert.ok(plate.angularVelocity[2] < 0);
    } finally {
      rigid.dispose();
    }
  }
});

test('in-flight rigid pressure and the fluid state restore bit-for-bit in both Wasm memory modes', async () => {
  let reference;
  for (const shared of [false, true]) {
    const { world, rigid } = await withPlate(shared);
    try {
      world.advance(2);
      const snapshot = world.takeSnapshot();
      world.advance(12);
      const hash = world.hash();
      world.restoreSnapshot(snapshot.bytes);
      assert.equal(world.hash(), snapshot.hash);
      world.advance(12);
      assert.equal(world.hash(), hash);
      if (reference) assert.equal(hash, reference);
      reference = hash;
    } finally {
      rigid.dispose();
    }
  }
});

test('emission reserves real mass and the occupied rows replay across frame rates and snapshots', async () => {
  const points = [{ position: [0.5, 0.5, 0.5] }, { position: [0.55, 0.5, 0.5] }];
  const make = async (playback, shared = false) => {
    const built = await solve(
      { ...relaxed, capacity: 4, particles: points },
      { rate: playback, memory: worldMemory(shared) },
    );
    const first = built.pbf.emit([{ position: [0.3, 0.6, 0.5] }]);
    assert.equal(first, 2);
    near(built.pbf.mass, 0.648);
    assert.throws(() => built.pbf.emit(points), /Increase particle capacity/);
    return built.world;
  };
  const rates = [24, 30, 60];
  const prepared = new Map(await Promise.all(rates.map(async (num) => [num, await make({ num, den: 1 })])));
  frameRateIndependent(({ num }) => prepared.get(num));
  const replay = await Promise.all([make({ num: 24, den: 1 }), make({ num: 24, den: 1 })]);
  seekEqualsContinuous(() => replay.pop(), { frames: 24 });
  const shared = await make(RATE, true);
  shared.advance(60);
  assert.equal(shared.hash(), prepared.get(60).hash());
});

test('a non-finite travel budget fails with a fix before native subdivision can overflow', async () => {
  const { world } = await solve({ particles: [{ position: [0.5, 0.5, 0.5], velocity: [1e250, 0, 0] }] });
  assert.throws(() => world.advance(1), /Increase resolution in time or reduce velocity/);
});
