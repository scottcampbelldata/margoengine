import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { PACK_ICE_LAYOUT, PACK_ICE_WORDS, PackIceSolver } from '../../dist/pack-ice.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { BODY_IMPULSES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const density = 917;
const still = { airSkinDrag: 0, airEdgeDrag: 0, waterSkinDrag: 0, waterEdgeDrag: 0 };
const radius = 1;
const rate = { num: 60, den: 1 };
const frozen = (x, z, vx, vz, thickness = 0.1) => ({ position: [x, z], velocity: [vx, vz], radius, thickness });

function near(actual, target, ulps = 64) {
  const error = ulps * Number.EPSILON * Math.max(1, Math.abs(target));
  assert.ok(Math.abs(actual - target) <= error, `${actual} instead of ${target}, beyond ${error}`);
}

const mass = (sample) => density * sample.volume;

const WAVELENGTH = 16;
const flow = {
  name: 'weather-wind-at-floe',
  kind: 'bodySet',
  quantity: 'wind',
  unit: 'm/s, kg/m³',
  centring: 'particle',
};
class WindSource {
  describe() {
    return { id: 'wind-source', fields: [{ field: flow, access: 'write' }], rate: 0, stableRate: () => 0 };
  }
  init(host) {
    this.memory = host.memory;
    this.region = host.allocate('source-wind', 48, 'f64', PACK_ICE_LAYOUT);
  }
  importPorts() {}
  step({ tick }) {
    regionWords(this.memory, this.region).set([tick % WAVELENGTH, 0, 1.23, -4, 0, 1.23]);
  }
  exportPorts(tick) {
    return [{ field: flow.name, region: this.region, tick, cell: [0, 0, 0] }];
  }
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

test('PackIceSolver: wind registry and floe records survive frame cadence, restore and plain/shared memory', async () => {
  const instances = await Promise.all(Array.from({ length: 7 }, () => PackIceSolver.load({ windField: flow })));
  const factory = (fps = rate, memory) => {
    const pack = instances.shift();
    const world = new PhysicsWorld({ rate: fps, memory })
      .add(pack, { ...still, airSkinDrag: 0.0017, floes: [frozen(-1.01, 0, 3, 0), frozen(1.01, 0, -3, 0)] })
      .add(new WindSource(), {});
    return Object.assign(world, { pack });
  };
  frameRateIndependent(factory);
  seekEqualsContinuous(factory);
  const plain = worldMemory(false);
  const shared = worldMemory(true);
  assert.ok(plain.buffer instanceof ArrayBuffer);
  assert.ok(shared.buffer instanceof SharedArrayBuffer);
  const a = factory(rate, plain);
  const b = factory(rate, shared);
  a.advance(60);
  b.advance(60);
  assert.equal(a.hash(), b.hash());
  assert.ok(a.pack.sample(0).raftedVolume > 0);
  const [p] = a.pack.exportPorts(60);
  assert.equal(p.region.type, 'f64');
  assert.equal(p.region.byteLength, 2 * PACK_ICE_WORDS * 8);
  assert.equal(p.region.layout, PACK_ICE_LAYOUT);
});

test('PackIceSolver: live RigidSolver receives the opposite ice impulse and bends the floe path', async () => {
  await Physics.load();
  const pack = await PackIceSolver.load({ rigid: true });
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  const physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
  const hullMass = 550;
  const speed = 12;
  const hull = new HullSolver();
  const mesh = {
    vertices: Float64Array.of(
      -0.5,
      -0.5,
      -1,
      0.5,
      -0.5,
      -1,
      0.5,
      0.5,
      -1,
      -0.5,
      0.5,
      -1,
      -0.5,
      -0.5,
      1,
      0.5,
      -0.5,
      1,
      0.5,
      0.5,
      1,
      -0.5,
      0.5,
      1,
    ),
    indices: Uint32Array.of(
      0,
      2,
      1,
      0,
      3,
      2,
      4,
      5,
      6,
      4,
      6,
      7,
      0,
      1,
      5,
      0,
      5,
      4,
      1,
      2,
      6,
      1,
      6,
      5,
      2,
      3,
      7,
      2,
      7,
      6,
      3,
      0,
      4,
      3,
      4,
      7,
    ),
  };
  const ship = physics.addBody(null, {
    position: [0, 0, 0],
    linearVelocity: [0, 0, speed],
    colliders: { shape: 'box', halfExtents: [0.5, 0.25, 1], mass: hullMass },
  });
  world
    .add(pack, {
      ...still,
      restitution: 0,
      friction: 0,
      seaLevel: 0,
      icebreaking: false,
      vessels: [{ bodyRow: ship.row, length: 2, beam: 1 }],
      floes: [frozen(0.3, 2, 0, 0)],
    })
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: ship.row, mesh }],
      sea: { density: 1025, elevation: () => 0 },
      addedMass: false,
      radiation: false,
      rollDamping: false,
      greenWater: false,
      drag: false,
    })
    .couple(['hull', 'pack-ice', 'rigid'], 'staggered');
  let iceImpulse = [0, 0];
  let yaw = 0;
  for (let i = 1; i <= 12; i++) {
    world.advance(i);
    const j = pack.vesselImpulse(ship.row);
    iceImpulse = [iceImpulse[0] + j.linear[0], iceImpulse[1] + j.linear[1]];
    yaw += j.yaw;
  }
  const [x, z] = pack.sample(0).velocity;
  assert.ok(regionWords(world.arena.memory, hull.exportPorts(12)[0].region)[1] > 0);
  assert.ok(x > 0 && z > 0);
  assert.ok(iceImpulse[0] < 0 && iceImpulse[1] < 0 && yaw !== 0);
  near(iceImpulse[0] + mass(pack.sample(0)) * x, 0, 2048);
  near(iceImpulse[1] + mass(pack.sample(0)) * z, 0, 2048);
  const { linearZ, angularY } = physics.kernel.columns;
  assert.ok(linearZ[ship.row] < speed);
  assert.ok(angularY[ship.row] !== 0);
  assert.ok(Math.abs((linearZ[ship.row] - speed) * hullMass - iceImpulse[1]) <= 24 * 2 ** -23 * hullMass * speed);
  assert.equal(pack.exportPorts(12)[1].field, BODY_IMPULSES_FIELD.name);
});

test('PackIceSolver stages foreign wind rows and retains accepted state after late bad flow', async () => {
  const memory = worldMemory(false);
  const bank = new WebAssembly.Memory({ initial: 1 });
  const region = {
    name: 'foreign-wind',
    type: 'f64',
    layout: PACK_ICE_LAYOUT,
    byteOffset: 80,
    byteLength: 48,
    memory: bank,
  };
  new Float64Array(bank.buffer, region.byteOffset, 6).set([12, 0, 1.23, -14, 0, 1.23]);
  let grow = true;
  let reject = false;
  const current = {
    medium: 'water',
    cell: [0, 0, 0],
    sample(x, _y, _z, _t, out) {
      if (grow) {
        grow = false;
        memory.grow(1);
      }
      out.velocity[0] = reject && x > 0 ? NaN : 0;
      out.velocity[2] = 0;
      out.density = 1025;
      return out;
    },
  };
  using pack = await PackIceSolver.load({ windField: flow });
  const world = new PhysicsWorld({ rate, memory })
    .add(pack, { ...still, airSkinDrag: 0.0017, current, floes: [frozen(-5, 0, 0, 0), frozen(5, 0, 0, 0)] })
    .add(new WindSource(), {});
  const input = { field: flow.name, region, tick: 0, cell: [0, 0, 0] };
  const context = { tick: 0, level: 0, seed: 9, cell: [0, 0, 0], inputs: new Map([[flow.name, input]]) };
  pack.step(context, 1 / 60);
  assert.equal(grow, false);
  assert.ok(pack.sample(0).velocity[0] > 0);
  assert.ok(pack.sample(1).velocity[0] < 0);
  const accepted = world.takeSnapshot();
  const work = pack.readNativeWork();
  reject = true;
  assert.throws(
    () => pack.step(context, 1 / 60),
    (error) =>
      error.name === 'MargoError' && error.code === 'state' && /current X.*Use.*errors#pack-ice/.test(error.message),
  );
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  assert.deepEqual(pack.readNativeWork(), work);
  reject = false;
  const malformed = {
    ...input,
    region: { ...region, byteOffset: bank.buffer.byteLength },
  };
  assert.throws(
    () => pack.step({ ...context, inputs: new Map([[flow.name, malformed]]) }, 1 / 60),
    (error) => error.name === 'MargoError' && /Publish a valid region.*errors#pack-ice/.test(error.message),
  );
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  pack.step(context, 1 / 60);
  const repaired = world.takeSnapshot().bytes;
  assert.notDeepEqual(repaired, accepted.bytes);
  world.restoreSnapshot(accepted.bytes);
  pack.step(context, 1 / 60);
  assert.deepEqual(world.takeSnapshot().bytes, repaired);
});

test('PackIceSolver publishes the accepted live cell after a signed shift and restore', async () => {
  using pack = await PackIceSolver.load();
  const world = new PhysicsWorld({ rate }).add(pack, { floes: [frozen(-9, 3, 0.2, -0.5)] });
  world.setCell('pack-ice', [-2, 0, 3]);
  world.advance(1);
  assert.deepEqual(pack.exportPorts(1)[0].cell, [-2, 0, 3]);
  const initial = world.takeSnapshot();
  const pose = pack.sample(0);
  world.shiftOrigin([-5, 2, 7]);
  assert.deepEqual(pack.exportPorts(1)[0].cell, [3, -2, -4]);
  assert.deepEqual(pack.sample(0), pose);
  world.restoreSnapshot(initial.bytes);
  assert.deepEqual(pack.exportPorts(1)[0].cell, [-2, 0, 3]);
  assert.deepEqual(pack.sample(0), pose);
});
