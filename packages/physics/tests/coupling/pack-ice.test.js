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
