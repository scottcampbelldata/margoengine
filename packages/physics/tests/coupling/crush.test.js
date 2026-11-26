import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { CRUSH_LAYOUT, CRUSH_WORDS, CrushSolver, resolveCrush } from '../../dist/crush.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const zero = [0, 0, 0];
const rate = { num: 60, den: 1 };

const material = { stiffness: 400, yieldForce: 10, stroke: 0.4 };
const close = (got, want, bound = 32 * Number.EPSILON * Math.max(1, Math.abs(want))) =>
  assert.ok(Math.abs(got - want) <= bound, `${got} differs from ${want} by more than ${bound}`);

function withBodies({ shared = false, two = true, y = 0, offset = 0, initial = 2, frameRate = rate } = {}) {
  const world = new PhysicsWorld({ rate: frameRate, gravity: zero, memory: worldMemory(shared) });
  const physics = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: 1 / 60 });
  const add = (position, mass, linearVelocity) =>
    physics.addBody(null, {
      position,
      linearVelocity,
      colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass, sensor: true },
    });
  const vehicle = add([-0.5, 0, 0], 4, [initial, 0, 0]);
  const other = two ? add([0, y, 0], 6, [0, 0, 0]) : undefined;
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
        material,
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

function floatingHull(quayZ) {
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
    const hull = new HullSolver();
    const crush = new CrushSolver();
    const capacity = physics.kernel.capacity;
    const sea = { density: 1000, elevation: () => 0, pressure: (_x, y) => Math.max(0, -9810 * y) };
    world.add(new RigidSolver(), { physics, capacity });
    world.add(hull, {
      hulls: [{ row: body.row, mesh }],
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
          sealStroke: 0.1,
        },
      ],
    });
    world.couple(['rigid', hull.id, crush.id], 'staggered');
    world.advance(30);
    return { damage: crush.read(0), surge: body.linearVelocity[0], heave: body.position[1] };
  } finally {
    physics.dispose();
  }
}

test('a floating service hull recoils from a quay while its separate seakeeping load remains active', async () => {
  await Physics.load();
  const berth = floatingHull(0);
  const clear = floatingHull(1);
  const result = resolveCrush(material, 16, 0.5);
  close(berth.surge, -result.reboundSpeed, 1e-7);
  close(clear.surge, 0.5, 1e-7);
  close(berth.heave, clear.heave, 8 * 2 ** -23);
  assert.equal(berth.damage.impacts, 1);
  assert.equal(clear.damage.impacts, 0);
  close(berth.damage.absorbedEnergy, result.absorbedEnergy, 1e-6);
  close(berth.damage.sealLoss, 1);
});
