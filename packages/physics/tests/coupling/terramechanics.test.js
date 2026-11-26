import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, TrackedVehicle, Vehicle } from '@margoengine/physics';
import { AirborneParticles } from '@margoengine/physics/airborne';
import { BedCollider, bedVertexAreas, TerrainBed } from '@margoengine/physics/earth';
import { LeggedLocomotion } from '@margoengine/physics/legged';
import { SoilContactRigidSolver, soilPatchField, Terramechanics, wheelSoil } from '@margoengine/physics/terramechanics';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const shape = { columns: 24, rows: 24, width: 2.4, depth: 2.4, centre: [0, 0] };
const patch = { x: 0, z: 0, length: 0.4, width: 0.2, load: 1000, displacement: [0.025, 0] };
const coefficient = 400_000;
const eps = Number.EPSILON;
const close = (actual, expected, error) =>
  assert.ok(Math.abs(actual - expected) <= error, `${actual} vs ${expected}, bound ${error}`);

function planted(soil, terrain, material, { playback = rate, shared = false, floor, patches = [patch] } = {}) {
  const bed = new TerrainBed();
  const world = new PhysicsWorld({ rate: playback, memory: worldMemory(shared) })
    .add(bed, { ...terrain, elevations: () => 0, bedrock: floor === undefined ? undefined : () => floor })
    .add(soil, { terrain, material, patches, floor });
  world.couple(['terramechanics', 'bed'], 'staggered');
  return { world, bed };
}

test('PA-45: Bekker p–z and Janosi–Hanamoto shear agree with the independent closed forms', async () => {
  const soil = await Terramechanics.load();
  const { world, bed } = planted(soil, shape, {
    exponent: 2,
    cohesion: 200,
    friction: 0.55,
    shearLength: 0.025,
    cohesiveModulus: 2000,
    frictionalModulus: coefficient,
    compaction: 0,
    dustFraction: 0,
  });
  world.advance(1);
  const got = soil.read(0);
  const expectedPressure = patch.load / (patch.length * patch.width);
  const expectedDepth = Math.sqrt(expectedPressure / (coefficient + 2000 / patch.width));
  const expectedShear = (200 + 0.55 * expectedPressure) * (1 - Math.exp(-1));
  close(got.pressure, expectedPressure, 8 * eps * expectedPressure);
  close(got.sinkage, expectedDepth, 64 * eps * expectedDepth);
  close(got.shearStress, expectedShear, 64 * eps * expectedShear);
  assert.equal(got.normalForce, patch.load);
  close(bed.elevations()[12 * 25 + 12], -expectedDepth, 64 * eps * expectedDepth);
  close(soil.budget.removed, soil.budget.deposited, 16 * eps);
  close(bed.volume(), 0, 1024 * eps * soil.budget.removed);
  const rim = bed.elevations();
  assert.ok(rim[14 * 25 + 12] > rim[10 * 25 + 12], 'shear biases loose soil along the applied slip');
  const total = soil.budget.removed;
  world.advance(30);
  assert.equal(
    soil.budget.removed,
    total,
    'a static load reaches a permanent settlement instead of eroding every tick',
  );
});

test('a shallow bedrock clips the cut and the material ledger closes on its triangulation', async () => {
  const soil = await Terramechanics.load();
  const floor = -0.005;
  const { world, bed } = planted(soil, shape, { compaction: 0.25, dustFraction: 0.03, density: 1200 }, { floor });
  world.advance(5);
  const budget = soil.budget;
  assert.equal(bed.refusedVolume(), 0);
  close(Math.min(...bed.elevations()), floor, eps);
  close(
    budget.removed,
    budget.compacted + budget.suspended + budget.deposited + budget.exported,
    256 * eps * budget.removed,
  );
  close(bed.volume(), budget.deposited - budget.removed, 2048 * eps * budget.removed);
  assert.ok(budget.compacted > 0 && budget.suspended > 0 && budget.deposited > 0);
});

test('native soil state matches across frame cadence, in-flight restore and memory type', async () => {
  const solvers = await Promise.all(Array.from({ length: 7 }, () => Terramechanics.load()));
  const make = (playback, shared = false) => planted(solvers.pop(), shape, {}, { playback, shared }).world;
  frameRateIndependent((rate) => make(rate));
  seekEqualsContinuous(() => make({ num: 24, den: 1 }));
  const plain = make(rate);
  const shared = make(rate, true);
  plain.advance(25);
  shared.advance(25);
  assert.equal(plain.hash(), shared.hash());
});

test('resolved rounded footprints integrate the independent square-profile solution and spread a conservative berm', async () => {
  const soil = await Terramechanics.load({ tier: 'resolved' });
  const spacing = 0.025;
  const terrain = { columns: 64, rows: 64, width: 64 * spacing, depth: 64 * spacing, centre: [0, 0] };
  const halfCells = 8;
  const side = 2 * halfCells * spacing;
  const load = 1600;
  const { world, bed } = planted(
    soil,
    terrain,
    { cohesiveModulus: 0, frictionalModulus: coefficient, compaction: 0, dustFraction: 0, reposeSlope: 0.2 },
    { patches: [{ x: 0, z: 0, length: side, width: side, load, rounded: true }] },
  );
  world.advance(1);
  const port = world.fields.port(soil.pressureField.name);
  const pressure = regionWords(world.memory, port.region);
  const area = bedVertexAreas(terrain);
  const normal = pressure.reduce((sum, pressure, vertex) => sum + pressure * area[vertex], 0);
  // Independently count the 8k vertices in each Chebyshev ring of a square contact. Interior
  // nodal areas are dx², and the parabolic profile gives zero pressure on the outer ring.
  let nodalArea = spacing * spacing;
  for (let k = 1; k < halfCells; k++) nodalArea += 8 * k * (1 - (k * k) / (halfCells * halfCells)) * spacing * spacing;
  const crest = load / nodalArea;
  close(pressure[32 * 65 + 32], crest, 512 * eps * crest);
  close(normal, load, 1024 * eps * load);
  close(bed.elevations()[32 * 65 + 32], -crest / coefficient, (1024 * eps * crest) / coefficient);
  close(bed.volume(), 0, 2048 * eps * soil.budget.removed);
  assert.ok(soil.work.relaxedVolume > 0 && soil.work.rasterVisits > 0);
  assert.equal(soil.work.reposeFaces, 2 * 64 * 65);
  const mark = world.takeSnapshot();
  world.advance(15);
  const hash = world.hash();
  world.restoreSnapshot(mark.bytes);
  world.advance(15);
  assert.equal(world.hash(), hash);
});

async function steps(kind, speed) {
  const terrain = { columns: 48, rows: 120, width: 3.6, depth: 9, centre: [0, 2] };
  const legged = await LeggedLocomotion.load({ bedShape: terrain });
  const soil = await Terramechanics.load({ legged: true });
  const dust = await AirborneParticles.load({ terrain: true, dustField: soil.dustField });
  const bed = new TerrainBed();
  const feet = kind === 'biped' ? 2 : 4;
  const density = 1600;
  const world = new PhysicsWorld({ rate })
    .add(bed, { ...terrain, elevations: () => 0 })
    .add(legged, { bodies: [{ kind, velocity: [0, 0, speed], target: { speed, heading: 0 } }] })
    .add(soil, {
      terrain,
      feet: Array.from({ length: feet }, (_, row) => ({
        row,
        length: kind === 'biped' ? 0.24 : 0.15,
        width: kind === 'biped' ? 0.1 : 0.14,
        elliptical: kind === 'quadruped',
      })),
      // A prepared running surface: a 100 kPa bearing pressure settles 5 mm for n = 1.
      material: { density, frictionalModulus: 20_000_000 },
    })
    .add(dust, { terrain, capacity: 512, dustReleaseHeight: 0.02, dustLiftVelocity: 0.4 });
  world.couple(['legged-locomotion', 'terramechanics', 'bed'], 'staggered');
  assert.equal(bed.volume(), 0);
  assert.equal(dust.budget.supplied, 0);
  world.advance(60);
  const budget = soil.budget;
  const volume = bed.volume();
  assert.ok(volume < 0 && budget.removed > 0 && dust.budget.airborne > 0);
  const latest = regionWords(world.memory, world.fields.port(soil.dustField.name).region);
  const areas = bedVertexAreas(terrain);
  const massFlux = latest.reduce((sum, density, vertex) => sum + density * areas[vertex], 0);
  // The 240 Hz receiver has consumed the first of four held samples of the newest 60 Hz release.
  const held = (massFlux / 60) * 0.75;
  close(dust.budget.supplied + held, budget.suspended * density, 4096 * eps * budget.suspended * density);
  assert.ok(dust.readParticles().every((parcel) => parcel.kind === 'mineral-dust'));
  const shifted = bed.elevations();
  assert.ok(shifted.some((h) => h < 0) && shifted.some((h) => h > 0));
  return { removed: budget.removed, dust: dust.budget.supplied, gait: legged.read(0).gait };
}

test('HORSE-5 and MAKING-3: actual walking and trotting hoof loads leave ruts and feed live airborne dust', async () => {
  const walk = await steps('quadruped', 0.8);
  const trot = await steps('quadruped', 3.2);
  assert.equal(walk.gait, 'walk');
  assert.equal(trot.gait, 'trot');
  assert.ok(trot.removed > walk.removed && trot.dust > walk.dust, JSON.stringify({ walk, trot }));
});

test('COURIER-3: real biped stance produces a persistent change and launches mineral particles', async () => {
  const foot = await steps('biped', 1.1);
  assert.ok(foot.removed > 0 && foot.dust > 0);
});

async function coupledVehicles(tier) {
  await Physics.load();
  const terrain = { columns: 28, rows: 40, width: 4.2, depth: 6, centre: [0, 1] };
  const contact = soilPatchField();
  const soil = await Terramechanics.load({ input: contact, tier });
  const rigid = new SoilContactRigidSolver(contact, { terrain });
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  const bed = new TerrainBed();
  world.add(bed, { ...terrain, elevations: () => 0 });
  using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60 });
  const floor = new BedCollider(physics, bed.bed);
  const chassisAt = (x) =>
    physics.addBody(null, {
      type: 'dynamic',
      position: [x, 0.39, 0],
      colliders: { shape: 'box', halfExtents: [0.32, 0.1, 0.55], mass: 120 },
    });
  const wheelShape = { length: 0.3, width: 0.21 };
  const wheels = [-0.26, 0.26].flatMap((x) =>
    [-0.38, 0.38].map((z) => ({
      position: [x, 0, z],
      radius: 0.15,
      suspensionRestLength: 0.31,
      suspensionStiffness: 25,
      width: wheelShape.width,
    })),
  );
  using vehicle = new Vehicle(physics, chassisAt(-0.95), {
    wheels,
    groundMaterial: () => ({
      grip: 0.8,
      soil: wheelSoil(
        wheelShape.width,
        wheelShape.length,
        undefined,
        true,
        tier === 'resolved' ? { rounded: true } : undefined,
      ),
    }),
  });
  const beltPatches = [-0.27, 0.27].map((x) => ({ length: 0.84, width: 0.25, centre: [x, 0, 0] }));
  using tracked = new TrackedVehicle(physics, chassisAt(0.95), {
    tracks: beltPatches.map(({ centre, length, width }) => ({
      position: centre,
      length,
      width,
      suspensionRestLength: 0.46,
    })),
  });
  vehicle.setInput({ throttle: 0.12 });
  tracked.setInput({ throttle: 0.12 });
  world.add(rigid, {
    physics,
    ground: floor,
    wheels: [{ vehicle, patches: wheels.map(() => wheelShape), ground: floor.collider }],
    tracks: [{ vehicle: tracked, patches: beltPatches }],
  });
  world.add(soil, { terrain, inputRows: 6, material: { dustFraction: 0 } });
  world.couple(['rigid', 'terramechanics', 'bed'], 'staggered');
  world.advance(7);
  assert.ok(soil.read(0).normalForce > 0 && soil.read(4).normalForce > 0);
  assert.equal(soil.read(0).normalForce, vehicle.wheel(0).load);
  assert.equal(soil.read(4).normalForce, tracked.track(0).load);
  assert.ok(vehicle.wheelGround(0).sinkage > 0);
  assert.ok(floor.collider.heightfieldHeights().some((h) => h < 0));
  const mark = world.takeSnapshot();
  world.advance(24);
  const hash = world.hash();
  assert.ok(soil.budget.removed > 0);
  world.restoreSnapshot(mark.bytes);
  world.advance(24);
  assert.equal(world.hash(), hash);
}

for (const tier of ['mean', 'resolved']) {
  test(`${tier}: real wheel and belt loads change the registered collider and survive seek`, () =>
    coupledVehicles(tier));
}
