import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { ATMOSPHERE, HULL_BREACHES_FIELD, HULL_BREACH_WORDS, HullSolver } from '../../dist/seakeeping.js';
import { CRUSH_LAYOUT, CRUSH_WORDS, CrushSolver, resolveCrush, squareTubeCrushMaterial } from '../../dist/crush.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const zero = [0, 0, 0];
const rate = { num: 60, den: 1 };

const material = { stiffness: 400, yieldForce: 10, stroke: 0.4 };
const measuredTube = {
  width: 0.0381,
  thickness: 0.00159,
  length: 0.2032,
  young: 69e9,
  yieldStress: 118e6,
  tensileStrength: 152e6,
};
const close = (got, want, bound = 32 * Number.EPSILON * Math.max(1, Math.abs(want))) =>
  assert.ok(Math.abs(got - want) <= bound, `${got} differs from ${want} by more than ${bound}`);

function withBodies({
  shared = false,
  two = true,
  y = 0,
  offset = 0,
  initial = 2,
  frameRate = rate,
  slip = [0, 0],
  gap = 0.1,
  friction,
  halfA = [0.2, 0.2, 0.2],
  halfB = halfA,
  curve = material,
  response,
  movingMass = 4,
} = {}) {
  const world = new PhysicsWorld({ rate: frameRate, gravity: zero, memory: worldMemory(shared) });
  const physics = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: 1 / 60 });
  const add = (position, mass, linearVelocity, halfExtents) =>
    physics.addBody(null, {
      position,
      linearVelocity,
      colliders: { shape: 'box', halfExtents, mass, sensor: true },
    });
  const vehicle = add([-0.4 - gap, -slip[0] / 60, -slip[1] / 60], movingMass, [initial, ...slip], halfA);
  const other = two ? add([0, y, 0], 6, [0, 0, 0], halfB) : undefined;
  const crush = new CrushSolver();
  const capacity = physics.kernel.capacity;
  world.add(new RigidSolver(), { physics, capacity });
  world.add(crush, {
    bodyCapacity: capacity,
    patches: [
      {
        body: vehicle.row,
        anchor: [0.2, offset, 0],
        normal: [1, 0, 0],
        radius: 0.12,
        material: curve,
        response,
        friction,
        support: { body: other?.row, point: other ? [-0.2, offset, 0] : [-0.2, y + offset, 0] },
      },
    ],
  });
  world.couple(['rigid', crush.id], 'staggered');
  return { world, physics, crush, vehicle, other };
}

async function assemble(options) {
  await Physics.load({ threads: options?.shared ?? false });
  return withBodies(options);
}

test('two actual moving bodies transfer opposite impulse and lose exactly the measured normal work', async () => {
  const { world, physics, crush, vehicle, other } = await assemble();
  try {
    const expected = resolveCrush(material, (4 * 6) / (4 + 6), 2);
    world.advance(12);
    assert.equal(crush.read(0).impacts, 1);
    close(4 * vehicle.linearVelocity[0] + 6 * other.linearVelocity[0], 8, 1e-6);
    close(other.linearVelocity[0] - vehicle.linearVelocity[0], expected.reboundSpeed, 2e-7);
    const kinetic =
      0.5 *
      (4 * vehicle.linearVelocity[0] * vehicle.linearVelocity[0] +
        6 * other.linearVelocity[0] * other.linearVelocity[0]);
    close(8 - kinetic, crush.read(0).absorbedEnergy, 1e-6);
    close(crush.read(0).permanentStroke, expected.permanentStroke);
  } finally {
    physics.dispose();
  }
});

test('a pressed crush patch supports a sustained load and retains one impact history', async () => {
  for (const two of [false, true]) {
    const { world, physics, crush, vehicle, other } = await assemble({ initial: 0.05, two });
    try {
      // Start in the elastic support stage. The low-energy first contact establishes the active patch.
      vehicle.setPosition([-0.3, 0, 0]);
      world.advance(2);
      const impact = crush.read(0);
      assert.equal(impact.impacts, 1);
      const load = 30;
      vehicle.addForce([load, 0, 0]);
      if (other) other.addForce([-load, 0, 0]);
      world.advance(180);

      const step = 1 / 60;
      const inverseMass = 1 / 4 + (other ? 1 / 6 : 0);
      const substeps = physics.kernel.substeps;
      const damping = 2 * Math.sqrt(material.stiffness / inverseMass);
      const impedance = damping + step * material.stiffness;
      // At equilibrium J = Fh. Rigid substeps integrate a velocity ramp from the applied contact
      // impulse to the frame's final velocity. Its mean is zero, so v_end = a h (s − 1)/(2s).
      const terminal = (load * step * inverseMass * (substeps - 1)) / (2 * substeps);
      const expected = (load * (1 + step * impedance * inverseMass) - impedance * terminal) / material.stiffness;
      const depth = () => vehicle.position[0] - (other?.position[0] ?? 0) + 0.4 - impact.permanentStroke;
      // At most two rounding operations per body substep, plus published f32 positions and velocities.
      const rounding = 2 * 180 * (substeps + 2) * 2 ** -23;
      close(depth(), expected, rounding * 0.4);
      close(vehicle.linearVelocity[0] - (other?.linearVelocity[0] ?? 0), terminal, rounding * terminal);
      assert.deepEqual(crush.read(0), impact);
      if (other) {
        const momentum = 4 * vehicle.linearVelocity[0] + 6 * other.linearVelocity[0];
        close(momentum, 4 * 0.05, rounding * 0.2);
      }

      const saved = world.takeSnapshot();
      world.advance(360);
      close(depth(), expected, 2 * rounding * 0.4);
      assert.deepEqual(crush.read(0), impact);
      const continued = world.hash();
      world.restoreSnapshot(saved.bytes);
      world.advance(360);
      assert.equal(world.hash(), continued);
    } finally {
      physics.dispose();
    }
  }
});

test('crush sliding minimizes contact kinetic energy within a round 3D friction bound', async () => {
  const slip = [0.875, -0.625];
  const halfA = [0.2, 0.55, 0.08];
  const halfB = [0.2, 0.35, 0.12];
  let normalDamage;
  for (const friction of [0, 0.04, 2]) {
    const { world, physics, crush, vehicle, other } = await assemble({ friction, slip, halfA, halfB, gap: 0.025 });
    try {
      world.advance(1);
      const damage = crush.read(0);
      assert.equal(damage.impacts, 1);
      normalDamage ??= damage;
      assert.deepEqual(damage, normalDamage);
      // The centred box arms are along x at the contact. The y and z moments have different inertias.
      const halfSeparation = 0.5 * (other.position[0] - vehicle.position[0]);
      const inverse = [1, 2].map((axis) => {
        const inertiaA = (4 * (halfA[0] ** 2 + halfA[axis] ** 2)) / 3;
        const inertiaB = (6 * (halfB[0] ** 2 + halfB[axis] ** 2)) / 3;
        return 1 / 4 + 1 / 6 + halfSeparation ** 2 * (1 / inertiaA + 1 / inertiaB);
      });
      const saved = world.takeSnapshot();
      world.advance(2);
      // Infer the actual impulse from the momentum of the two native RigidSolver bodies.
      const impulse = slip.map((velocity, axis) => 4 * (vehicle.linearVelocity[axis + 1] - velocity));
      const rounding = 32 * 2 ** -23;
      for (let axis = 0; axis < 2; axis++) close(impulse[axis] + 6 * other.linearVelocity[axis + 1], 0, rounding);
      const remaining = slip.map((velocity, axis) => velocity + inverse[axis] * impulse[axis]);
      const energy = impulse.reduce((sum, value, axis) => sum + value * (slip[axis] + 0.5 * inverse[axis] * value), 0);
      if (friction === 0) {
        assert.deepEqual(impulse, [0, 0]);
      } else if (friction < 1) {
        close(Math.hypot(...impulse), friction * damage.impulse, rounding);
        close(remaining[0] * impulse[1] - remaining[1] * impulse[0], 0, rounding);
        assert.ok(remaining[0] * impulse[0] + remaining[1] * impulse[1] < 0);
        assert.ok(energy < 0);
      } else {
        close(Math.hypot(...remaining), 0, rounding);
        assert.ok(Math.hypot(...impulse) < friction * damage.impulse);
        assert.ok(energy < 0);
      }
      const hash = world.hash();
      world.restoreSnapshot(saved.bytes);
      world.advance(2);
      assert.equal(world.hash(), hash);
    } finally {
      physics.dispose();
    }
  }
});

test('a fixed crush shoe opposes slip under a continued load without counting a second material event', async () => {
  const { world, physics, crush, vehicle } = await assemble({ friction: 0.25, two: false, initial: 0.05 });
  try {
    vehicle.setPosition([-0.3, 0, 0]);
    world.advance(2);
    const impact = crush.read(0);
    assert.equal(impact.impacts, 1);
    vehicle.addForce([30, 0, 0]);
    world.advance(180);
    vehicle.setLinearVelocity([vehicle.linearVelocity[0], 0, 0.5]);
    world.advance(182);
    assert.deepEqual(crush.read(0), impact);
    // The pre-existing 30 N load has built one tick's worth of Coulomb capacity at 60 Hz.
    close(4 * (0.5 - vehicle.linearVelocity[2]), (0.25 * 30) / 60, 4e-6);
  } finally {
    physics.dispose();
  }
});

test('crush patches reject negative or nonfinite dry friction coefficients', () => {
  for (const friction of [-1, Infinity, NaN]) {
    const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(false) });
    assert.throws(
      () =>
        world.add(new CrushSolver(), {
          bodyCapacity: 1,
          patches: [
            { body: 0, anchor: zero, normal: [1, 0, 0], radius: 0.1, support: { point: zero }, material, friction },
          ],
        }),
      { code: 'state', message: /Choose crush friction coefficient/ },
    );
  }
});

test('a fixed barrier receives the equivalent normal work, with a versioned deformation and seal output', async () => {
  const { world, physics, crush, vehicle } = await assemble({ two: false });
  try {
    world.advance(12);
    const damage = crush.read(0);
    const expected = resolveCrush(material, 4, 2);
    close(vehicle.linearVelocity[0], -expected.reboundSpeed, 1e-7);
    close(damage.sealLoss, expected.permanentStroke / material.stroke);
    const port = world.fields.port(crush.damageField.name);
    assert.equal(port.region.layout, CRUSH_LAYOUT);
    assert.equal(port.region.byteLength, 8 * CRUSH_WORDS);
    assert.deepEqual(Array.from(regionWords(world.memory, port.region)), [
      damage.permanentStroke,
      damage.absorbedEnergy,
      damage.peakStroke,
      damage.peakForce,
      damage.impulse,
      damage.elasticEnergy,
      damage.sealLoss,
      damage.impacts,
    ]);
  } finally {
    physics.dispose();
  }
});

test('a rigid sled transfers its energy into hollow-tube collapse predicted from wall and tensile inputs', async () => {
  const curve = squareTubeCrushMaterial(measuredTube);
  const speed = 20;
  const { world, physics, crush, vehicle } = await assemble({ initial: speed, two: false, gap: 0.3, curve });
  try {
    world.advance(5);
    const state = crush.read(0);
    assert.equal(state.impacts, 1);
    const workFromSled = 0.5 * 4 * (speed ** 2 - vehicle.linearVelocity[0] ** 2);
    close(state.absorbedEnergy, workFromSled, 4 * 2 ** -23 * speed ** 2);
    assert.ok(state.permanentStroke > 0 && state.permanentStroke < curve.stroke);
    const load = state.absorbedEnergy / state.permanentStroke;
    // Yob et al. 2016, Table 4 measured mean load across five independent guided square-tube compressions.
    assert.ok(load > 8970 && load < 10490);
  } finally {
    physics.dispose();
  }
});

test('continuous contact yields throughout guided compression and retains the measured tube work on unloading', async (t) => {
  const curve = squareTubeCrushMaterial(measuredTube);
  const movingMass = 5e6;
  const input = { initial: 0, two: false, response: 'continuous', movingMass, curve };
  const observations = [];
  for (const frames of [32, 128]) {
    const { world, physics, crush, vehicle } = await assemble(input);
    const setStroke = (stroke) => {
      // The specimen is driven by a displacement-controlled platen. A large carriage inertia keeps the
      // actual RigidSolver's compliance small and its response can still be read from the live port.
      vehicle.setPosition([-0.4 + stroke, 0, 0]);
      vehicle.setLinearVelocity(zero);
    };
    try {
      for (let i = 1; i <= frames; i++) {
        setStroke((0.1 * i) / frames);
        world.advance(i);
      }
      const loaded = crush.read(0);
      assert.equal(loaded.impacts, 1);
      assert.ok(loaded.permanentStroke > 0);
      close(loaded.peakForce, curve.yieldForce);
      const bias = (3 * curve.yieldForce) / (movingMass * 60 ** 2) + 8 * 2 ** -23;
      close(loaded.peakStroke, 0.1, bias);
      const work = loaded.absorbedEnergy + loaded.elasticEnergy;
      // Yob et al. Table 4. The five guided 100 mm comparisons are independent of the geometry and tensile inputs.
      assert.ok(work >= 897.4 && work <= 1048.77);
      observations.push(work);
      const saved = world.takeSnapshot();
      const unload = () => {
        setStroke(0.06);
        world.advance(frames + 1);
        assert.deepEqual(crush.read(0), loaded);
        return world.hash();
      };
      const hash = unload();
      world.restoreSnapshot(saved.bytes);
      assert.equal(unload(), hash);
    } finally {
      physics.dispose();
    }
  }
  close(observations[0], observations[1]);
  t.diagnostic(
    `Work at 100 mm for 32 and 128 driving steps: ${observations.map((value) => value.toFixed(3)).join(' and ')} J`,
  );
});

test('continuous elastic, yielding and compacted branches return reciprocal native impulses', async () => {
  const curve = { stiffness: 200, yieldForce: 40, hardening: 100, stroke: 0.4, backingStiffness: 800 };
  const compliance = (1 / 4 + 1 / 6) / 60 ** 2;
  const cases = [
    [0.1, 200, 0, 0],
    [0.5, 200 / 3, 0.2, 40],
    [0.9, 800, 0.8, 80],
  ];
  for (const [depth, stiffness, origin, startForce] of cases) {
    const { world, physics, crush, vehicle, other } = await assemble({ initial: 0, response: 'continuous', curve });
    try {
      vehicle.setPosition([depth - 0.4, 0, 0]);
      world.advance(1);
      const geometry = vehicle.position[0] - other.position[0] + 0.4;
      const load = (startForce + (geometry - origin) * stiffness) / (1 + compliance * stiffness);
      const displacement = geometry - compliance * load;
      const first = crush.read(0);
      const roundoff = 8 * 2 ** -23;
      close(first.peakForce, load, roundoff * load);
      close(first.peakStroke, displacement, roundoff);
      close(first.impulse, load / 60, (roundoff * load) / 60);
      assert.equal(first.impacts, 1);
      world.advance(2);
      close(4 * vehicle.linearVelocity[0], -load / 60, roundoff * load);
      close(6 * other.linearVelocity[0], load / 60, roundoff * load);
    } finally {
      physics.dispose();
    }
  }
});

test('an offset station applies a real moment, and rotation increases its normal compliance', async () => {
  const { world, physics, crush, vehicle } = await assemble({ two: false, offset: 0.1 });
  try {
    world.advance(8);
    assert.equal(crush.read(0).impacts, 1);
    assert.ok(vehicle.angularVelocity[2] > 0);
    const translationOnly = resolveCrush(material, 4, 2);
    assert.ok(crush.read(0).impulse < translationOnly.impulse);
  } finally {
    physics.dispose();
  }
});

test('a transverse miss and a retreat leave the member and momentum intact', async () => {
  for (const config of [{ y: 0.4 }, { initial: -2 }]) {
    const { world, physics, crush, vehicle } = await assemble(config);
    try {
      world.advance(12);
      assert.equal(crush.read(0).impacts, 0);
      assert.equal(vehicle.linearVelocity[0], config.initial ?? 2);
      assert.equal(crush.read(0).absorbedEnergy, 0);
    } finally {
      physics.dispose();
    }
  }
});

test('civil impact ledger and pending impulses replay from before contact in both world memory modes', async () => {
  let previous;
  for (const shared of [false, true]) {
    const { world, physics, crush } = await assemble({ shared });
    try {
      world.advance(1);
      const snapshot = world.takeSnapshot();
      world.advance(12);
      const hash = world.hash();
      const damage = crush.read(0);
      world.restoreSnapshot(snapshot.bytes);
      world.advance(12);
      assert.equal(world.hash(), hash);
      assert.deepEqual(crush.read(0), damage);
      if (previous) assert.equal(hash, previous);
      previous = hash;
    } finally {
      physics.dispose();
    }
  }
});

test('event work is independent of presentation frame rate and of a capped seek', async () => {
  await Physics.load();
  const instances = [];
  const make = (frameRate) => {
    const { physics, world } = withBodies({ frameRate });
    instances.push(physics);
    return world;
  };
  try {
    frameRateIndependent(make);
    seekEqualsContinuous(() => make({ num: 24, den: 1 }), { at: 1, frames: 12 });
  } finally {
    for (const physics of instances) physics.dispose();
  }
});

function floatingHull(quayZ, options = {}) {
  const gravity = [0, -9.81, 0];
  const world = new PhysicsWorld({ rate, gravity, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity });
  try {
    const body = physics.addBody(null, {
      position: [-0.5, 0.1, 0],
      linearVelocity: [0.5, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 16 },
    });
    const positions = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ];
    const mesh = {
      vertices: Float64Array.from(positions.flat().map((v) => v * 0.2)),
      indices: Uint32Array.from([
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
      ]),
    };
    const crush = new CrushSolver();
    const hull = new HullSolver('hull', undefined, options.crushPatch !== undefined ? crush.damageField : undefined);
    const capacity = physics.kernel.capacity;
    const sea = { density: 1000, elevation: () => 0, pressure: (_x, y) => Math.max(0, -9810 * y) };
    const compartment =
      options.crushPatch === undefined
        ? undefined
        : {
            compartments: [{ mesh, permeability: 1 }],
            openings: [
              {
                from: 0,
                to: 'outside',
                centre: [0, -0.2, 0],
                normal: [0, -1, 0],
                width: 0.02,
                height: 0.02,
                discharge: 0.6,
                crushPatch: options.crushPatch,
              },
            ],
          };
    world.add(new RigidSolver(), { physics, capacity });
    world.add(hull, {
      hulls: [{ row: body.row, mesh, ...compartment }],
      sea,
      gravity,
      addedMass: false,
      radiation: false,
      greenWater: false,
      drag: false,
      rollDamping: false,
    });
    world.add(crush, {
      bodyCapacity: capacity,
      patches: [
        {
          body: body.row,
          anchor: [0.2, 0, 0],
          normal: [1, 0, 0],
          radius: 0.1,
          support: { point: [-0.2, 0.1, quayZ] },
          material,
          sealStroke: options.sealStroke ?? 0.1,
        },
      ],
    });
    world.couple(['rigid', hull.id, crush.id], 'staggered');
    return { world, physics, body, crush };
  } catch (error) {
    physics.dispose();
    throw error;
  }
}

test('a floating service hull recoils from a quay while its separate seakeeping load remains active', async () => {
  await Physics.load();
  const run = (quay) => {
    const { world, physics, body, crush } = floatingHull(quay);
    try {
      world.advance(30);
      return { damage: crush.read(0), surge: body.linearVelocity[0], heave: body.position[1] };
    } finally {
      physics.dispose();
    }
  };
  const berth = run(0);
  const clear = run(1);
  const result = resolveCrush(material, 16, 0.5);
  close(berth.surge, -result.reboundSpeed, 1e-7);
  close(clear.surge, 0.5, 1e-7);
  close(berth.heave, clear.heave, 8 * 2 ** -23);
  assert.equal(berth.damage.impacts, 1);
  assert.equal(clear.damage.impacts, 0);
  close(berth.damage.absorbedEnergy, result.absorbedEnergy, 1e-6);
  close(berth.damage.sealLoss, 1);
});

test('a structural seal failure opens a real compartment, floods the hull and replays', async () => {
  await Physics.load();
  const run = (sealStroke) => {
    const { world, physics, body, crush } = floatingHull(0, { crushPatch: 0, sealStroke });
    const opening = () => {
      const port = world.fields.port(HULL_BREACHES_FIELD.name);
      const words = regionWords(world.memory, port.region);
      assert.equal(words[0], 1);
      return Array.from(words.slice(1, 1 + HULL_BREACH_WORDS));
    };
    try {
      world.advance(1);
      assert.equal(opening()[8], 0);
      assert.equal(opening()[9], 0);
      const saved = world.takeSnapshot();
      let firstInflow;
      for (let frame = 2; frame <= 40; frame++) {
        world.advance(frame);
        const record = opening();
        if (record[9] < 0 && !firstInflow) firstInflow = record;
      }
      world.advance(75);
      const heave = body.position[1];
      const damage = crush.read(0);
      const hash = world.hash();
      world.restoreSnapshot(saved.bytes);
      world.advance(75);
      assert.equal(world.hash(), hash);
      return { firstInflow, heave, damage, opening: opening() };
    } finally {
      physics.dispose();
    }
  };

  const torn = run(0.1);
  const intact = run(0.4);
  assert.equal(torn.damage.sealLoss, 1);
  assert.equal(intact.damage.impacts, 1);
  assert.ok(intact.damage.sealLoss > 0 && intact.damage.sealLoss < 1);
  assert.equal(intact.firstInflow, undefined);
  assert.equal(intact.opening[8], 0);
  close(torn.opening[8], 0.02 ** 2);
  assert.ok(torn.heave < intact.heave);

  // The horizontal opening's every point starts at the published depth. Bound the initial
  // discharge by accounting for the largest possible rise in water and compression of air in one tick.
  assert.ok(torn.firstInflow);
  const head = torn.firstInflow[14];
  const limit = 0.6 * 0.02 ** 2 * Math.sqrt(2 * 9.81 * head);
  const volume = limit / 60;
  const backHead = volume / 0.4 ** 2 + (ATMOSPHERE * volume) / (9810 * (0.4 ** 3 - volume));
  const minimum = limit * Math.sqrt((head - backHead) / head);
  const inflow = -torn.firstInflow[9];
  assert.ok(inflow >= minimum && inflow <= limit, `expected ${minimum} to ${limit}, got ${inflow}`);
});

test('an opening linked to a missing crush patch gives an actionable error', async () => {
  await Physics.load();
  const { world, physics } = floatingHull(0, { crushPatch: 1 });
  try {
    assert.throws(() => world.advance(4), { code: 'state', message: /crushPatch within the connected damage port/ });
  } finally {
    physics.dispose();
  }
});
