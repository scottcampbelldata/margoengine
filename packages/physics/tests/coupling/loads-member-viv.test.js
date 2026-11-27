import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { LoadSolver } from '../../dist/loads.js';
import { FORCE_WORDS, PhysicsWorld, RigidSolver, regionWords } from '../../dist/world.js';

await Physics.load();

const density = 1000;
const gravity = [0, 0, 0];
const coupling = { vortexCoupling: 'body-acceleration' };

function sea(current) {
  return {
    density,
    cell: [0, 0, 0],
    elevation: () => 0,
    water: { medium: 'water', cell: [0, 0, 0], sample: () => ({ velocity: [current, 0, 0], density }) },
  };
}

function memberWorld(physics, rate, body, member, current, viscosity, loads = new LoadSolver()) {
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity })
    .add(new RigidSolver(), { physics })
    .add(loads, {
      sea: sea(current),
      viscosity,
      level: Math.log2(rate / 60),
      members: [{ ...member, row: body.row, period: Infinity }],
    })
    .couple(['loads', 'rigid'], 'staggered');
  return { world, loads };
}

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual}, expected ${expected} ± ${tolerance}`);
}

test('SEA-12 rigid wake lift locks to the held-out Carberry transverse drive', (t) => {
  // Carberry, Sheridan and Rockwell, JFM 538 (2005), §2 and Fig. 17(c), which is distinct from
  // the earlier 2001 A/D=0.5, Re=2300 series discussed by Facchinetti. A separate strain-gauge
  // lift trace peaks at the imposed frequency, 1.15 times the fixed-cylinder shedding frequency.
  // Source: https://flair.monash.edu/publications/pdfs/Carberry_etal_JFM2005.pdf
  const diameter = 0.0254;
  const viscosity = 1e-6;
  const speed = (4410 * viscosity) / diameter;
  const baseFrequency = (0.2 * speed) / diameter;
  const frequencyRatio = 1.15;
  const omega = 2 * Math.PI * baseFrequency * frequencyRatio;
  const amplitude = 0.25 * diameter;
  const centre = -0.35;
  const span = 12.5 * diameter;
  const from = [0, 0, -span / 2];
  const to = [0, 0, span / 2];

  function measure(rate, wake) {
    using physics = new Physics(null, { fixedTimestep: 1 / rate, gravity });
    const body = physics.addBody(null, {
      position: [0, centre, 0],
      enabledTranslations: [false, true, false],
      lockRotations: true,
      canSleep: false,
      colliders: { shape: 'sphere', radius: diameter / 2, mass: 1 },
    });
    const { world, loads } = memberWorld(
      physics,
      rate,
      body,
      { from, to, diameter, roughness: 0, ...wake },
      speed,
      viscosity,
    );
    const start = Math.ceil((40 * rate) / (baseFrequency * frequencyRatio));
    const end = Math.ceil((120 * rate) / (baseFrequency * frequencyRatio));
    const advance = (frame) => {
      const time = (frame - 1) / rate;
      body.setPosition([0, centre + amplitude * Math.sin(omega * time), 0]);
      body.setLinearVelocity([0, amplitude * omega * Math.cos(omega * time), 0]);
      world.advance(frame);
      return loads.memberLoad(0).lift;
    };
    const crossings = [];
    let previous = 0;
    let saved;
    let sine = 0;
    let cosine = 0;
    let power = 0;
    for (let frame = 1; frame <= end; frame++) {
      const lift = advance(frame);
      assert.ok(Number.isFinite(lift));
      if (frame > start) {
        if (previous < 0 && lift >= 0) crossings.push((frame - 1 - previous / (lift - previous)) / rate);
        const phase = (omega * frame) / rate;
        sine += lift * Math.sin(phase);
        cosine += lift * Math.cos(phase);
        power += lift * lift;
      }
      previous = lift;
      if (frame === start) saved = world.takeSnapshot();
    }
    assert.ok(crossings.length > 60);
    const measured = (crossings.length - 1) / (crossings.at(-1) - crossings[0]) / baseFrequency;
    const hash = world.hash();
    world.restoreSnapshot(saved.bytes);
    for (let frame = start + 1; frame <= end; frame++) advance(frame);
    assert.equal(world.hash(), hash);
    return { ratio: measured, dominantFraction: (2 * (sine * sine + cosine * cosine)) / ((end - start) * power) };
  }

  const coarse = measure(60, coupling);
  const fine = measure(120, coupling);
  const without = measure(60, { vortex: {} });
  // Half the printed 0.01 ratio is the experimental reading resolution. Add the finite
  // observation band of the published acquisition (over 400 cylinder oscillations).
  const bound = 0.005 + frequencyRatio / 400;
  close(coarse.ratio, frequencyRatio, bound, '60 Hz lift frequency');
  close(fine.ratio, frequencyRatio, bound, '120 Hz lift frequency');
  assert.ok(coarse.dominantFraction > 0.5 && fine.dominantFraction > 0.5, 'the measured peak carries most lift power');
  assert.ok(Math.abs(without.ratio - frequencyRatio) > bound, 'free shedding fails the measured force-frequency check');
  t.diagnostic(JSON.stringify({ coarse, fine, without, measuredRatio: frequencyRatio, bound }));
});

test('SEA-12 a partly submerged wake transfers its actual linear and angular impulse to rigid state', async () => {
  const rate = 60;
  const mass = 125;
  const radius = 0.1;
  const diameter = 0.2;
  const speed = 1.1;
  const wetLength = 0.75;
  const offCentre = -0.125;
  const ends = [
    [0, -0.5, 0],
    [0, 0.75, 0],
  ];

  function measure({ reversed = false, wake, solver }) {
    using physics = new Physics(null, { fixedTimestep: 1 / rate, gravity });
    const body = physics.addBody(null, {
      position: [0, -0.25, 0],
      linearDamping: 0,
      angularDamping: 0,
      canSleep: false,
      colliders: { shape: 'sphere', radius, mass },
    });
    const [from, to] = reversed ? [...ends].reverse() : ends;
    const { world, loads } = memberWorld(physics, rate, body, { from, to, diameter, ...wake }, speed, 1e-6, solver);
    world.advance(1);
    const { region } = loads.exportPorts(0)[0];
    const force = regionWords(world.arena.memory, region).slice(body.row * FORCE_WORDS, (body.row + 1) * FORCE_WORDS);
    const member = loads.memberLoad(0);
    return {
      force,
      rawLift: member.force[2],
      coefficient: member.lift,
      speed: body.linearVelocity[2],
      spin: body.angularVelocity[0],
    };
  }

  const physical = measure({ wake: coupling });
  const native = measure({ wake: coupling, solver: await LoadSolver.load() });
  const reverse = measure({ wake: coupling, reversed: true });
  const noVortex = measure({});
  assert.ok(physical.rawLift < 0);
  assert.equal(noVortex.force[2], 0);
  assert.equal(noVortex.force[3], 0);
  const added = (density * Math.PI * diameter * diameter * wetLength) / 4;
  const inertia = (2 * radius * radius * mass) / 5;
  const tolerance = 32 * 2 ** -23;
  const referenceForce = -0.5 * density * speed * speed * diameter * wetLength * physical.coefficient;
  close(physical.rawLift, referenceForce, tolerance * Math.abs(physical.rawLift), 'wet span force');
  close(physical.force[3], offCentre * physical.rawLift, tolerance * Math.abs(physical.rawLift), 'wet centroid torque');
  close(
    (mass + added) * physical.speed,
    physical.rawLift / rate,
    (tolerance * Math.abs(physical.rawLift)) / rate,
    'linear impulse',
  );
  close(
    inertia * physical.spin,
    physical.force[3] / rate,
    (tolerance * Math.abs(physical.force[3])) / rate,
    'angular impulse',
  );
  assert.deepEqual(reverse, physical, 'a circular member does not change its wake when endpoints are reordered');
  assert.deepEqual(native, physical, 'the native wrench batch holds the same vortex momentum');
});

test('SEA-12 motion-driven vortex input requires a live rigid member', () => {
  const world = new PhysicsWorld();
  assert.throws(
    () =>
      world.add(new LoadSolver(), {
        sea: sea(1),
        members: [{ from: [0, -1, 0], to: [0, -2, 0], diameter: 0.1, ...coupling }],
      }),
    { name: 'MargoError', code: 'unsupported', message: /body-acceleration.+rigid member.+#hydrodynamic-loads/ },
  );
});

test('SEA-12 the rigid wake refuses shedding that the world rate cannot resolve', () => {
  using physics = new Physics(null, { fixedTimestep: 1 / 60, gravity });
  const body = physics.addBody(null, {
    position: [0, -1, 0],
    colliders: { shape: 'sphere', radius: 0.05, mass: 10 },
  });
  const { world } = memberWorld(
    physics,
    60,
    body,
    { from: [0, 0, -0.5], to: [0, 0, 0.5], diameter: 0.01, ...coupling },
    5,
    1e-6,
  );
  assert.throws(() => world.advance(1), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Nyquist frequency.+raise the Loads and rigid rates.+#hydrodynamic-loads/,
  });
});
