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

function planted(
  soil,
  terrain,
  material,
  { playback = rate, shared = false, floor, patches = [patch], profiles, hardpan, hardpanDepths } = {},
) {
  const bed = new TerrainBed();
  const bedrock = typeof floor === 'number' ? () => floor : floor;
  const world = new PhysicsWorld({ rate: playback, memory: worldMemory(shared) })
    .add(bed, { ...terrain, elevations: () => 0, bedrock })
    .add(soil, {
      terrain,
      material,
      patches,
      profiles,
      hardpan,
      hardpanDepths,
      ...(typeof floor === 'number' ? { floor } : { floorGrid: floor }),
    });
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

test('a varying bedrock shares the terrain grid and closes the mass ledger on both sides', async () => {
  const terrain = { columns: 64, rows: 64, width: 2, depth: 2, centre: [0, 0] };
  const floor = (x) => (x < 0 ? -0.004 - 0.001 * x : -0.012 - 0.002 * x);
  const load = { x: 0, z: 0, width: 0.25, length: 0.25, load: 1500 };
  for (const tier of ['mean', 'resolved']) {
    const soil = await Terramechanics.load({ tier });
    const { world, bed } = planted(soil, terrain, { compaction: 0.2, dustFraction: 0.01 }, { floor, patches: [load] });
    world.advance(1);
    const elevations = bed.elevations();
    close(elevations[30 * 65 + 32], floor(-0.0625), 8 * eps);
    close(elevations[34 * 65 + 32], floor(0.0625), 8 * eps);
    assert.equal(bed.refusedVolume(), 0);
    const budget = soil.budget;
    close(bed.volume(), budget.deposited - budget.removed, 2048 * eps * budget.removed);
    close(
      budget.removed,
      budget.compacted + budget.suspended + budget.deposited + budget.exported,
      2048 * eps * budget.removed,
    );
    const saved = world.takeSnapshot();
    world.advance(8);
    const hash = world.hash();
    world.restoreSnapshot(saved.bytes);
    world.advance(8);
    assert.equal(world.hash(), hash);
  }
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
  assert.ok(soil.work.reposeFaces > 0 && soil.work.reposeFaces < 2 * 64 * 65);
  const mark = world.takeSnapshot();
  world.advance(15);
  const hash = world.hash();
  world.restoreSnapshot(mark.bytes);
  world.advance(15);
  assert.equal(world.hash(), hash);
});

test('a projected tread rotates two unequal lugs while their gap stays unloaded', async () => {
  const terrain = { columns: 64, rows: 64, width: 2, depth: 2, centre: [0, 0] };
  const profile = {
    columns: 9,
    rows: 2,
    depth: [0, 1, 1, 0, 0, 0, 0.5, 0.5, 0].flatMap((depth) => [depth, depth]),
    area: 0.75,
    perimeter: 5.5,
  };
  const areas = bedVertexAreas(terrain);
  const load = 900;
  // There are 33 along rows and the two linear trapezoids integrate to 3/8 m across.
  const nodalArea = (33 / 32) * (3 / 8);
  const crest = load / nodalArea;
  const stiffness = coefficient + 12_000 / ((2 * 0.75) / 5.5);
  for (const [forward, points] of [
    [[0, 1], [-0.25, 0, 0.25].map((x) => [x, 0])],
    [[1, 0], [-0.25, 0, 0.25].map((x) => [0, -x])],
  ]) {
    const soil = await Terramechanics.load({ tier: 'resolved' });
    const { world, bed } = planted(
      soil,
      terrain,
      { cohesiveModulus: 12_000, frictionalModulus: coefficient, compaction: 1 },
      { patches: [{ x: 0, z: 0, length: 1, width: 1, load, forward }], profiles: [profile] },
    );
    world.advance(1);
    const pressure = regionWords(world.memory, world.fields.port(soil.pressureField.name).region);
    const normal = pressure.reduce((sum, value, i) => sum + value * areas[i], 0);
    close(normal, load, 1024 * eps * load);
    const elevations = bed.elevations();
    const heights = points.map(([x, z]) => elevations[(32 + 32 * x) * 65 + 32 + 32 * z]);
    close(heights[0], -crest / stiffness, 512 * eps);
    assert.equal(heights[1], 0);
    close(heights[2], -crest / (2 * stiffness), 512 * eps);
    const saved = world.takeSnapshot();
    world.advance(20);
    const hash = world.hash();
    world.restoreSnapshot(saved.bytes);
    world.advance(20);
    assert.equal(world.hash(), hash);
  }
});

test('sparse repose matches a complete ordered face sweep on a large bed', async () => {
  const terrain = { columns: 256, rows: 384, width: 8, depth: 12, centre: [0, 0] };
  const nx = terrain.columns + 1;
  const nz = terrain.rows + 1;
  const patches = [
    { ...patch, x: -2.875, z: -4.25, rounded: true, load: 1800 },
    { ...patch, x: 2.875, z: 4.25, rounded: true, load: 3100 },
  ];
  const material = { compaction: 0.17, dustFraction: 0 };
  const baseline = await Terramechanics.load({ tier: 'resolved' });
  const flat = planted(baseline, terrain, { ...material, reposeSlope: 1e6 }, { patches });
  flat.world.advance(1);
  const areas = bedVertexAreas(terrain);
  const original = regionWords(flat.world.memory, baseline.stateRegions()[0]).slice();
  const pressure = regionWords(flat.world.memory, flat.world.fields.port(baseline.pressureField.name).region);
  for (const slope of [0.2, 0]) {
    const expected = original.slice();
    let transferred = 0;
    const limitX = (slope * terrain.width) / terrain.columns;
    const limitZ = (slope * terrain.depth) / terrain.rows;
    const face = (a, b, maxRise) => {
      if (pressure[a] > 0 || pressure[b] > 0) return;
      const [src, dst] = expected[a] > expected[b] ? [a, b] : [b, a];
      const excess = expected[src] - expected[dst] - maxRise;
      if (excess <= 0 || expected[src] <= 0) return;
      const volume = Math.min(excess / (1 / areas[src] + 1 / areas[dst]), expected[src] * areas[src]);
      expected[src] -= volume / areas[src];
      expected[dst] += volume / areas[dst];
      transferred += volume;
    };
    for (let x = 0; x < nx; x++)
      for (let z = 0; z < nz; z++) {
        const i = x * nz + z;
        if (x + 1 < nx) face(i, i + nz, limitX);
        if (z + 1 < nz) face(i, i + 1, limitZ);
      }
    const soil = await Terramechanics.load({ tier: 'resolved' });
    const actual = planted(soil, terrain, { ...material, reposeSlope: slope }, { patches });
    actual.world.advance(1);
    const deltas = regionWords(actual.world.memory, soil.stateRegions()[0]);
    for (let i = 0; i < deltas.length; i++) {
      assert.equal(deltas[i], expected[i], `native bed increment at vertex ${i}`);
    }
    assert.equal(soil.work.relaxedVolume, transferred);
    if (slope > 0) {
      const fullFaces = (nx - 1) * nz + (nz - 1) * nx;
      assert.ok(soil.work.reposeFaces < fullFaces / 100, `${soil.work.reposeFaces} of ${fullFaces} faces`);
    }
  }
});

test('layered soil balances the pressure on both sides of an independently integrated hardpan transition', async () => {
  const spacing = 0.025;
  const terrain = { columns: 64, rows: 64, width: 64 * spacing, depth: 64 * spacing, centre: [0, 0] };
  const halfCells = 8;
  const side = 2 * halfCells * spacing;
  const material = { cohesiveModulus: 0, frictionalModulus: 100_000, friction: 0, compaction: 1 };
  const hardpan = { thickness: 0.27, frictionalModulus: 600_000, exponent: 2 };
  const transition = 0.07;
  const stress = (z) => (z <= transition ? 100_000 * z : 7000 + 600_000 * (z * z - transition * transition));
  const peak = 0.12;
  let load = stress(peak) * spacing * spacing;
  for (let ring = 1; ring < halfCells; ring++) {
    const depth = peak * (1 - (ring * ring) / (halfCells * halfCells));
    load += 8 * ring * stress(depth) * spacing * spacing;
  }
  const soil = await Terramechanics.load({ tier: 'resolved' });
  const { world, bed } = planted(soil, terrain, material, {
    hardpan,
    patches: [{ x: 0, z: 0, length: side, width: side, load, rounded: true }],
  });
  world.advance(1);
  const pressure = regionWords(world.memory, world.fields.port(soil.pressureField.name).region);
  const areas = bedVertexAreas(terrain);
  const force = pressure.reduce((sum, value, i) => sum + value * areas[i], 0);
  close(force, load, 1024 * eps * load);
  const centre = 32 * 65 + 32;
  close(pressure[centre], stress(peak), 2048 * eps * stress(peak));
  close(pressure[centre + 3], stress(peak * (1 - 9 / 64)), 2048 * eps * stress(peak));
  close(pressure[centre + 6], stress(peak * (1 - 36 / 64)), 2048 * eps * stress(peak));
  close(bed.elevations()[centre], -peak, 1024 * eps);
  const saved = world.takeSnapshot();
  world.advance(14);
  const hash = world.hash();
  world.restoreSnapshot(saved.bytes);
  world.advance(14);
  assert.equal(world.hash(), hash);
});

test('Salman et al. sandy loam follows the measured 200 mm plate beyond the hardpan transition', async () => {
  const terrain = { columns: 192, rows: 192, width: 1, depth: 1, centre: [0, 0] };
  const diameter = 0.2;
  const patchArea = Math.PI * (diameter / 2) * (diameter / 2);
  // Table 2 equivalent moduli and exact printed regressions for the 200 mm plate.
  const material = {
    cohesiveModulus: 0,
    frictionalModulus: 702_020,
    exponent: 0.9815,
    friction: Math.tan((37.59 * Math.PI) / 180),
  };
  const hardpan = { thickness: 0.3, frictionalModulus: 9_549_600, exponent: 2.1037 };
  for (const tier of ['mean', 'resolved']) {
    const soil = await Terramechanics.load({ tier });
    const { world, bed } = planted(soil, terrain, material, {
      hardpan,
      patches: [{ x: 0, z: 0, length: diameter, width: diameter, load: 110_000 * patchArea, elliptical: true }],
    });
    world.advance(1);
    const sinkage = -bed.bed.sample(0, 0).elevation;
    // Fig. 6 samples at 118.5 and 122.2 mm bracket 110 kPa. The bounds include one rendered PDF pixel.
    assert.ok(sinkage >= 0.1182 && sinkage <= 0.1225, `${tier}: ${sinkage} m`);
  }
});

test('two otherwise identical footprints distinguish a shallow and deep layer from one mapped bed', async () => {
  const terrain = { columns: 64, rows: 64, width: 2, depth: 2, centre: [0, 0] };
  const material = { friction: 0, cohesiveModulus: 0, frictionalModulus: 100_000, compaction: 1 };
  const patches = [-0.5, 0.5].map((x) => ({ x, z: 0, length: 0.25, width: 0.25, load: 1000 }));
  const hardpan = { thickness: 0.25, frictionalModulus: 500_000 };
  const hardpanDepths = (x) => Math.max(0.03125, 0.25 + 0.375 * x);
  for (const tier of ['mean', 'resolved']) {
    const soil = await Terramechanics.load({ tier });
    const { world } = planted(soil, terrain, material, { hardpan, hardpanDepths, patches });
    world.advance(1);
    const shallow = soil.read(0).sinkage;
    const deep = soil.read(1).sinkage;
    assert.ok(shallow > 0 && deep > 0);
    close(shallow * 5, deep, 2048 * eps * deep);
  }
});

test('Ding et al. Wh32 rolling contact follows observed sinkage at zero and moderate powered slip', async () => {
  const terrain = { columns: 72, rows: 160, width: 0.36, depth: 0.8, centre: [0, 0] };
  const width = 0.165;
  const length = 0.12;
  const load = 80;
  const speed = 0.08;
  const material = {
    cohesiveModulus: 15_600,
    frictionalModulus: 2_407_400,
    exponent: 0.84,
    cohesion: 250,
    friction: Math.tan((31.9 * Math.PI) / 180),
    shearLength: 0.0114,
    dustFraction: 0,
  };
  const wheel = { radius: 0.15735, lugHeight: 0.01, lugSupport: 0.0015, slipExponent: 0.72 };
  // At 0.2 slip, Table 4 reports 0.25 mm at 2.89% relative scatter. Propagating their printed
  // precision gives a mean in [8.46, 8.84] mm; use two of the measured 0.25 mm scatter widths.
  for (const [slip, lower, upper] of [
    [0, 0.00264, 0.00314],
    [0.2, 0.00796, 0.00934],
  ]) {
    const input = soilPatchField('lab-wheel-assembly');
    let memory, region;
    const carriage = {
      describe: () => ({ id: 'carriage', rate: 0, stableRate: () => 0, fields: [{ field: input, access: 'write' }] }),
      init(host) {
        memory = host.memory;
        region = host.allocate('carriage-load', 80, 'f64', 1);
      },
      step(context) {
        regionWords(memory, region).set([
          0,
          -0.16 + (speed * context.tick) / 60,
          0,
          1,
          length,
          width,
          load,
          0,
          -slip * length,
          0,
        ]);
      },
      exportPorts: (tick) => [{ field: input.name, region, tick, cell: [0, 0, 0] }],
      importPorts() {},
      stateRegions: () => [region],
      extraState: () => [],
    };
    const soil = await Terramechanics.load({ tier: 'resolved', input });
    const bed = new TerrainBed();
    const world = new PhysicsWorld({ rate })
      .add(bed, { ...terrain, elevations: () => 0 })
      .add(carriage)
      .add(soil, { terrain, material, inputRows: 1, rollingWheels: [wheel] })
      .couple(['carriage', 'terramechanics', 'bed'], 'staggered');
    const areas = bedVertexAreas(terrain);
    world.advance(40);
    const result = soil.read(0);
    assert.ok(result.sinkage >= lower && result.sinkage <= upper, `slip ${slip}: ${result.sinkage} m`);
    const pressure = regionWords(world.memory, world.fields.port(soil.pressureField.name).region);
    close(
      pressure.reduce((sum, value, i) => sum + value * areas[i], 0),
      load,
      1024 * eps * load,
    );
    world.advance(100);
    assert.ok(bed.bed.sample(0, -0.11).elevation < 0);
    assert.ok(bed.bed.sample(0, -0.02).elevation < 0);
    const saved = world.takeSnapshot();
    world.advance(120);
    const hash = world.hash();
    world.restoreSnapshot(saved.bytes);
    world.advance(120);
    assert.equal(world.hash(), hash);
  }
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
  const lug = {
    columns: 5,
    rows: 2,
    depth: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
    area: 0.21,
    perimeter: 2.18,
  };
  world.add(soil, {
    terrain,
    inputRows: 6,
    material: { dustFraction: 0 },
    profiles: tier === 'resolved' ? [null, null, null, null, lug, lug] : undefined,
    rollingWheels: tier === 'resolved' ? [...wheels.map(({ radius }) => ({ radius })), null, null] : undefined,
  });
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
