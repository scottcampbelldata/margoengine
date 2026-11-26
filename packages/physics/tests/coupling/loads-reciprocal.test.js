import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { FORCING_WORDS, ShallowWaterSolver, SURFACE_WATER_FORCING_FIELD } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT, SwimSolver } from '../../dist/life.js';
import { LoadSolver } from '../../dist/loads.js';
import { HullSolver } from '../../dist/seakeeping.js';
import {
  BODY_FORCES_FIELD,
  FORCE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
  worldMemory,
} from '../../dist/world.js';

const RHO = 1000;
const WIDTH = 2;
const AREA = WIDTH * WIDTH;
const DEPTH = 0.5;
const WATER_MASS = RHO * AREA * DEPTH;
const RATE = { num: 60, den: 1 };
const DT = 1 / RATE.num;
const ORIGIN = [0, 0, 0];
const SIDES = { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' };

const mesh = {
  vertices: new Float64Array([
    -0.1, -0.1, -0.1, 0.1, -0.1, -0.1, 0.1, 0.1, -0.1, -0.1, 0.1, -0.1, -0.1, -0.1, 0.1, 0.1, -0.1, 0.1, 0.1, 0.1, 0.1,
    -0.1, 0.1, 0.1,
  ]),
  indices: new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]),
};

/** Alias the existing contributor's published wrench, retaining its actual clock, cell and words. */
function withWrenchField(Base, name) {
  const field = { ...BODY_FORCES_FIELD, name };
  return class extends Base {
    wrenchField = field;

    describe() {
      const description = super.describe();
      return { ...description, fields: [...description.fields, { field, access: 'write' }] };
    }

    exportPorts(tick) {
      const ports = super.exportPorts(tick);
      const force = ports.find((port) => port.field === BODY_FORCES_FIELD.name);
      assert.ok(force);
      return [...ports, { ...force, field: field.name }];
    }
  };
}

/** A one-cell, all-wet test receiver. Reactions enter the real HYDRO-01 step as held forcing. */
function reciprocalWetCell(wrenches, swimWake) {
  let host, source, signedImpulse;
  const read = (port) => regionWords(port.region.memory ?? host.memory, port.region);
  return {
    id: 'wet-cell-reaction',
    describe() {
      return {
        id: this.id,
        fields: [
          ...wrenches.map(({ field }) => ({ field, access: 'read' })),
          ...(swimWake ? [{ field: SWIM_WAKE_FIELD, access: 'read' }] : []),
          { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
        ],
        rate: 0,
        stableRate: () => 0,
      };
    },
    init(h) {
      host = h;
      source = h.allocate('wet-cell-horizontal-force', FORCING_WORDS * 8, 'f64', 1);
      signedImpulse = h.allocate('wet-cell-source-impulse', 2 * 8, 'f64', 1);
    },
    step({ tick, inputs }, dt) {
      assert.equal(dt, DT);
      const impulse = regionWords(host.memory, signedImpulse);
      impulse.fill(0);
      for (const { field, row, enabled } of wrenches) {
        const port = inputs.get(field.name);
        assert.equal(port.tick, tick);
        assert.deepEqual(port.cell, ORIGIN);
        if (!enabled) continue;
        const words = read(port);
        impulse[0] -= words[FORCE_WORDS * row] * dt;
        impulse[1] -= words[FORCE_WORDS * row + 2] * dt;
      }
      if (swimWake) {
        // LIFE-03 has already integrated its wet actuator reaction over the tick, in N·s.
        const port = inputs.get(SWIM_WAKE_FIELD.name);
        assert.equal(port.tick, tick);
        assert.deepEqual(port.cell, ORIGIN);
        assert.equal(port.region.layout, SWIM_WAKE_LAYOUT);
        const words = read(port);
        assert.equal(words.length, 16);
        for (let i = 0; i < words.length; i += 8) {
          if (words[i + 7] <= 0) continue;
          assert.ok(Math.abs(words[i]) < WIDTH / 2 && Math.abs(words[i + 2]) < WIDTH / 2);
          assert.ok(words[i + 4] === 0);
          if (swimWake.enabled) {
            impulse[0] += words[i + 3];
            impulse[1] += words[i + 5];
          }
        }
      }
      // The conservative shallow-water momentum variables are depth × velocity. This divides
      // the SI impulse by density, footprint area and the exact same step duration.
      // Kurganov and Petrova, 2007: https://people.tamu.edu/~gpetrova/KPSV.pdf
      const out = regionWords(host.memory, source);
      out[0] = impulse[0] / (RHO * AREA * dt);
      out[1] = impulse[1] / (RHO * AREA * dt);
    },
    impulse: () => regionWords(host.memory, signedImpulse).slice(),
    importPorts() {},
    exportPorts(tick) {
      return [{ field: SURFACE_WATER_FORCING_FIELD.name, region: source, tick, cell: ORIGIN }];
    },
    stateRegions: () => [source, signedImpulse],
    extraState: () => [],
  };
}

function waterOf(world) {
  const water = new ShallowWaterSolver();
  const bed = bedSurface(
    { columns: 1, rows: 1, width: WIDTH, depth: WIDTH, centre: [0, 0] },
    new Float64Array(4).fill(-DEPTH),
  );
  world.add(water, { bed, depth: DEPTH, density: RHO, roughness: 0, sides: SIDES });
  return {
    water,
    sea: { elevation: (x, z) => water.sample(x, z).surface, water: water.flow, density: RHO, cell: ORIGIN },
  };
}

function waterMomentum(water) {
  // Read the live f64 sample. The renderer's public surface-water mirror is rounded to f32.
  const { depth, velocity } = water.sample(0, 0);
  assert.equal(depth, DEPTH);
  assert.equal(water.volume() * RHO, WATER_MASS);
  return [WATER_MASS * velocity[0], WATER_MASS * velocity[1]];
}

function horizontal(body, mass) {
  const velocity = body.linearVelocity;
  return [mass * velocity[0], mass * velocity[2]];
}

function advanceWithReceipt(world, water, receiver, frame) {
  const before = waterMomentum(water);
  world.advance(frame);
  const after = waterMomentum(water);
  const accepted = receiver.impulse();
  for (let k = 0; k < 2; k++) {
    assert.ok(
      Math.abs(after[k] - before[k] - accepted[k]) < 512 * Number.EPSILON * Math.max(1, Math.abs(after[k])),
      JSON.stringify({ frame, k, before, after, accepted }),
    );
  }
  return after;
}

function rigidBody(physics, position, linearVelocity, mass) {
  return physics.addBody(null, {
    position,
    linearVelocity,
    enabledTranslations: [true, false, true],
    lockRotations: true,
    colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass },
  });
}

test('SEA-12 and SEA-08 exchange actual horizontal momentum through one live HYDRO water cell', async (context) => {
  await Physics.load();
  function run(hullReturn, loadsReturn) {
    const world = new PhysicsWorld({ rate: RATE, memory: worldMemory(false) });
    const { sea, water } = waterOf(world);
    using physics = new Physics(null, { fixedTimestep: DT, arena: world.arena });
    const mass = 4;
    const hullBody = rigidBody(physics, [-0.5, -0.25, 0], [0.8, 0, 0], mass);
    const probe = rigidBody(physics, [0.5, -0.25, 0], [0, 0, 0.5], mass);
    const hull = new (withWrenchField(HullSolver, 'sea08-wet-wrench'))();
    const loads = new (withWrenchField(LoadSolver, 'sea12-wet-wrench'))();
    const receiver = reciprocalWetCell([
      { field: hull.wrenchField, row: hullBody.row, enabled: hullReturn },
      { field: loads.wrenchField, row: probe.row, enabled: loadsReturn },
    ]);
    world.add(new RigidSolver(), { physics });
    // SEA-08 uses the same live water as SEA-12. The spectral pressure/volume wake does not
    // expose a bulk momentum receipt, so the fixture closes only the horizontal HYDRO ledger.
    world.add(hull, {
      hulls: [{ row: hullBody.row, mesh }],
      sea,
      addedMass: false,
      radiation: false,
      rollDamping: false,
      greenWater: false,
      slamming: false,
    });
    world.add(loads, {
      bodies: [{ row: probe.row, shape: { sphere: 0.1 }, drag: 1, addedMass: [0, 0, 0] }],
      sea,
    });
    world.add(receiver, {});
    world.couple(['hull', 'loads', receiver.id, 'water', 'rigid'], 'staggered');
    for (let frame = 1; frame <= 22; frame++) advanceWithReceipt(world, water, receiver, frame);
    const snapshot = world.takeSnapshot();
    let fluid;
    for (let frame = 23; frame <= 48; frame++) fluid = advanceWithReceipt(world, water, receiver, frame);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    for (let frame = 23; frame <= 48; frame++) advanceWithReceipt(world, water, receiver, frame);
    assert.equal(world.hash(), hash);
    return { water: fluid, hull: horizontal(hullBody, mass), probe: horizontal(probe, mass), hash };
  }
  const both = run(true, true);
  const noHull = run(false, true);
  const noLoads = run(true, false);
  const total = both.water.map((value, k) => value + both.hull[k] + both.probe[k]);
  const expected = [Math.fround(0.8) * 4, 2];
  for (let k = 0; k < 2; k++) assert.ok(Math.abs(total[k] - expected[k]) < 128 * 2 ** -24 * 4);
  assert.ok(both.probe[0] > noHull.probe[0] + 1e-4, 'the hull reaction changes the load on the other body');
  assert.ok(both.hull[1] > noLoads.hull[1] + 1e-4, 'the load reaction changes the force on the hull');
  assert.ok(Math.hypot(...both.water) > 0.1);
  context.diagnostic(JSON.stringify({ total, expected, water: both.water, hash: both.hash }));
});

test('SEA-12 and LIFE-03 exchange resolved axial impulse and keep the one-cell momentum ledger closed', async (context) => {
  await Physics.load();
  const fishMass = 8;
  const probeMass = 6;
  async function run(fishReturn, loadsReturn) {
    const world = new PhysicsWorld({ rate: RATE, memory: worldMemory(false) });
    const { sea, water } = waterOf(world);
    using physics = new Physics(null, { fixedTimestep: DT, arena: world.arena });
    const probe = rigidBody(physics, [0.5, -0.25, 0], [0, 0, 0.5], probeMass);
    const loads = new (withWrenchField(LoadSolver, 'sea12-swimmer-wrench'))();
    const swimmer = await SwimSolver.load();
    const receiver = reciprocalWetCell([{ field: loads.wrenchField, row: probe.row, enabled: loadsReturn }], {
      enabled: fishReturn,
    });
    world.add(new RigidSolver(), { physics });
    // Isolate the tail actuator to close the modes represented by LIFE-03's public wake rows.
    // Lighthill, 1960: https://doi.org/10.1017/S0022112060001110
    world.add(swimmer, {
      flow: sea.water,
      bodies: [
        {
          position: [-0.5, -0.25, 0],
          velocity: [0, 0, 0.15],
          mass: fishMass,
          volume: fishMass / RHO,
          length: 0.5,
          width: 0.12,
          height: 0.12,
          tail: { amplitude: 0.13, span: 0.22, wavelength: 0.75 },
          frequency: 1.6,
          wettedArea: 0,
          formDragArea: 0,
          crossflowDrag: [0, 0],
          axialAddedMassRatio: 0,
        },
      ],
    });
    world.add(loads, {
      bodies: [{ row: probe.row, shape: { sphere: 0.1 }, drag: 1, addedMass: [0, 0, 0] }],
      sea,
    });
    world.add(receiver, {});
    world.couple(['swim', 'loads', receiver.id, 'water', 'rigid'], 'staggered');
    for (let frame = 1; frame <= 16; frame++) advanceWithReceipt(world, water, receiver, frame);
    const snapshot = world.takeSnapshot();
    let fluid;
    for (let frame = 17; frame <= 40; frame++) fluid = advanceWithReceipt(world, water, receiver, frame);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    for (let frame = 17; frame <= 40; frame++) advanceWithReceipt(world, water, receiver, frame);
    assert.equal(world.hash(), hash);
    return {
      fish: swimmer.read(0).velocity[2] * fishMass,
      probe: horizontal(probe, probeMass)[1],
      water: fluid[1],
      hash,
    };
  }
  const both = await run(true, true);
  const noFish = await run(false, true);
  const noLoads = await run(true, false);
  const total = both.fish + both.probe + both.water;
  const expected = 0.15 * fishMass + 0.5 * probeMass;
  assert.ok(Math.abs(total - expected) < 128 * 2 ** -24 * probeMass);
  assert.ok(Math.abs(both.water / WATER_MASS - noFish.water / WATER_MASS) > 1e-5);
  assert.ok(both.probe < noFish.probe - 1e-4, 'the swimmer wake changes the SEA-12 load');
  assert.ok(
    both.fish > noLoads.fish + 1e-5,
    'the SEA-12 reaction changes the swimmer thrust by changing the live water',
  );
  context.diagnostic(JSON.stringify({ ...both, total, expected }));
});
