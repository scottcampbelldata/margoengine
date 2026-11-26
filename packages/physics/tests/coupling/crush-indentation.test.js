import assert from 'node:assert/strict';
import test from 'node:test';
import { CircularPlateIndentation, CrushSolver } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { HULL_BREACHES_FIELD, HullSolver } from '../../dist/seakeeping.js';
import { BODIES_FIELD, BODY_WORDS, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const zero = [0, 0, 0];
const material = { radius: 0.1114, thickness: 0.001, indenterRadius: 0.025, strength: 497e6, hardening: 0.19 };
const near = (got, expected, tolerance) =>
  assert.ok(Math.abs(got - expected) <= tolerance, `${got} differs from ${expected} by more than ${tolerance}`);
const half = 0.2;

function pair(physics, [m1, m2], afloat = false) {
  const add = (position, mass) =>
    physics.addBody(null, {
      position,
      colliders: { shape: 'box', halfExtents: [half, half, half], mass, sensor: true },
    });
  return [add([-2 * half - 0.005, afloat ? 0.1 : 0, 0], m1), add([0, afloat ? 0.1 : 0, 0], m2)];
}

function attach(world, physics, [a, b], indentation) {
  const crush = new CrushSolver();
  const capacity = physics.kernel.capacity;
  world.add(new RigidSolver(), { physics, capacity });
  world.add(crush, {
    bodyCapacity: capacity,
    patches: [],
    indentationPatches: [
      {
        body: a.row,
        anchor: [half, 0, 0],
        normal: [1, 0, 0],
        radius: 0.14,
        support: { body: b.row, point: [-half, 0, 0] },
        indentation,
      },
    ],
  });
  return crush;
}

test('measured membrane rupture caps actual rigid work and leaves the correct residual speed', async () => {
  await Physics.load({ threads: false });
  const masses = [400, 600];
  const reduced = (masses[0] * masses[1]) / (masses[0] + masses[1]);
  const model = new CircularPlateIndentation(material);
  const rest = [0, 0, 0.025, 0, material.radius, 0];
  for (const inputWork of [250, 800]) {
    const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(false) });
    using physics = new Physics(null, { arena: world.arena, gravity: zero });
    const [a, b] = pair(physics, masses);
    const crush = attach(world, physics, [a, b], material);
    world.couple(['rigid', crush.id], 'staggered');
    world.advance(1);
    const saved = world.takeSnapshot();
    const approach = Math.fround(Math.sqrt((2 * inputWork) / reduced));
    const fracture = inputWork > model.fractureWork;
    const cycle = () => {
      a.setLinearVelocity([approach, 0, 0]);
      world.advance(2);
      const damage = crush.read(0);
      const dent = crush.readIndentation(0, rest);
      assert.equal(damage.impacts, 1);
      assert.equal(damage.sealLoss, fracture ? 1 : 0);
      assert.equal(dent.fractured, fracture);
      assert.equal(dent.surface.positions[2], damage.permanentStroke);
      assert.equal(dent.surface.positions[8], 0);
      near(dent.work, damage.absorbedEnergy, 1e-9);
      if (fracture) {
        // The independent 25 mm spherical-indenter result in Simonsen & Lauridsen, Table 1.
        near(damage.permanentStroke, 0.04184, 0.07 * 0.04184);
        near(damage.absorbedEnergy, 575.2, 0.13 * 575.2);
      } else {
        const native = regionWords(world.memory, world.fields.port(BODIES_FIELD.name).region);
        const aa = a.row * BODY_WORDS;
        const bb = b.row * BODY_WORDS;
        const inverse = native[aa + 16] + native[bb + 16];
        const incoming = native[aa + 10] - native[bb + 10];
        near(damage.absorbedEnergy, (0.5 * incoming ** 2) / inverse, 1e-8);
      }
      world.advance(3);
      const remaining = a.linearVelocity[0] - b.linearVelocity[0];
      near(masses[0] * a.linearVelocity[0] + masses[1] * b.linearVelocity[0], masses[0] * approach, 2e-4);
      near(0.5 * reduced * (approach ** 2 - remaining ** 2), damage.absorbedEnergy, 3e-4);
      if (fracture) {
        assert.ok(remaining > 0);
        world.advance(5);
        assert.deepEqual(crush.read(0), damage);
        assert.deepEqual(crush.readIndentation(0, rest), dent);
      } else {
        near(remaining, 0, 1e-6);
      }
      return { damage, dent };
    };
    const first = cycle();
    const hash = world.hash();
    world.restoreSnapshot(saved.bytes);
    assert.deepEqual(cycle(), first);
    assert.equal(world.hash(), hash);
  }
});

test('native membrane fracture opens the watertight compartment and intact denting keeps it dry', async () => {
  await Physics.load({ threads: false });
  const gravity = [0, -9.81, 0];
  const mesh = {
    vertices: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map(
      (value) => value * half,
    ),
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    ],
  };
  const scale = 0.2;
  const local = {
    ...material,
    radius: scale * material.radius,
    thickness: scale * material.thickness,
    indenterRadius: scale * material.indenterRadius,
  };
  for (const speed of [0.4, 1.7]) {
    const world = new PhysicsWorld({ rate, gravity, memory: worldMemory(false) });
    using physics = new Physics(null, { arena: world.arena, gravity });
    const [a, b] = pair(physics, [16, 16], true);
    const crush = attach(world, physics, [a, b], local);
    const hull = new HullSolver('hull', undefined, crush.damageField);
    world.add(hull, {
      hulls: [
        {
          row: a.row,
          mesh,
          compartments: [{ mesh, permeability: 1 }],
          openings: [
            {
              from: 0,
              to: 'outside',
              centre: [0, -half, 0],
              normal: [0, -1, 0],
              width: 0.02,
              height: 0.02,
              crushPatch: 0,
            },
          ],
        },
        { row: b.row, mesh },
      ],
      sea: { density: 1000, elevation: () => 0, pressure: (_x, y) => Math.max(0, -9810 * y) },
      gravity,
      addedMass: false,
      radiation: false,
      drag: false,
      rollDamping: false,
    });
    world.couple(['rigid', crush.id, hull.id], 'staggered');
    const water = () => {
      const port = world.fields.port(HULL_BREACHES_FIELD.name);
      return regionWords(world.memory, port.region)[10];
    };
    world.advance(1);
    assert.equal(water(), 0);
    a.setLinearVelocity([speed, 0, 0]);
    world.advance(6);
    const impact = crush.read(0);
    assert.equal(impact.impacts, 1);
    assert.ok(impact.permanentStroke > 0);
    if (speed > 1) {
      assert.equal(impact.sealLoss, 1);
      assert.ok(water() < 0);
    } else {
      assert.equal(impact.sealLoss, 0);
      assert.equal(water(), 0);
    }
  }
});

test('an intact permanent dent carries continued lower load without using its fracture work', async () => {
  await Physics.load({ threads: false });
  const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, gravity: zero });
  const [a, b] = pair(physics, [400, 600]);
  const crush = attach(world, physics, [a, b], material);
  world.couple(['rigid', crush.id], 'staggered');
  a.setLinearVelocity([1.2, 0, 0]);
  world.advance(1);
  const pressed = crush.read(0);
  assert.ok(pressed.permanentStroke > 0 && pressed.peakForce > 20);
  assert.equal(pressed.sealLoss, 0);
  a.setPosition([b.position[0] - 2 * half + pressed.permanentStroke + 0.001, 0, 0]);
  world.advance(2);
  a.addForce([20, 0, 0]);
  b.addForce([-20, 0, 0]);
  world.advance(25);
  assert.deepEqual(crush.read(0), pressed);
  const oneTick = (20 * (1 / 400 + 1 / 600)) / 60;
  assert.ok(Math.abs(a.linearVelocity[0] - b.linearVelocity[0]) <= oneTick + 4 * 2 ** -23);
});
