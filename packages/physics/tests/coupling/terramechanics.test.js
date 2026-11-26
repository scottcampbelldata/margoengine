import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, TrackedVehicle, Vehicle } from '@margoengine/physics';
import { AirborneParticles } from '@margoengine/physics/airborne';
import { BedCollider, bedVertexAreas, TerrainBed } from '@margoengine/physics/earth';
import { LeggedLocomotion } from '@margoengine/physics/legged';
import {
  SoilContactRigidSolver,
  soilPatchField,
  soilWheelCamberField,
  soilWheelPhaseField,
  soilWheelReactionField,
  soilWheelSideForceField,
  Terramechanics,
  wheelSoil,
} from '@margoengine/physics/terramechanics';
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

async function rollingBench(
  terrain,
  material,
  wheel,
  {
    width,
    length,
    load,
    speed,
    slip,
    stop = Infinity,
    wheelReaction,
    wheelSideForce,
    lateral = 0,
    sidewallGravity,
    shared,
  },
) {
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
        -0.16 + (speed * Math.min(context.tick, stop)) / 60,
        0,
        1,
        length,
        width,
        context.tick <= stop ? load : 0,
        lateral * length,
        -slip * length,
        0,
      ]);
    },
    exportPorts: (tick) => [{ field: input.name, region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
  const soil = await Terramechanics.load({ tier: 'resolved', input, wheelReaction, wheelSideForce });
  const bed = new TerrainBed();
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) })
    .add(bed, { ...terrain, elevations: () => 0 })
    .add(carriage)
    .add(soil, { terrain, material, inputRows: 1, rollingWheels: [wheel], sidewallGravity })
    .couple(['carriage', 'terramechanics', 'bed'], 'staggered');
  return { world, bed, soil };
}

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
    const { world, bed, soil } = await rollingBench(terrain, material, wheel, { width, length, load, speed, slip });
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

test('native rolling reactions resolve asymmetric normal drag and full-slip axle torque', async () => {
  const terrain = { columns: 72, rows: 160, width: 0.36, depth: 0.8, centre: [0, 0] };
  const width = 0.165;
  const length = 0.12;
  const load = 80;
  const radius = 0.15735;
  const stiffness = 400_000;
  const shearLength = 0.06;
  const wheel = { radius, peakFraction: 0.5, peakSlip: 0 };
  const wheelReaction = soilWheelReactionField('carriage-reaction');
  for (const [slip, cohesion, shared] of [
    [0, 0, false],
    [1, 2500, true],
  ]) {
    const material = { cohesiveModulus: 0, frictionalModulus: stiffness, cohesion, shearLength, friction: 0 };
    const { world, soil } = await rollingBench(terrain, material, wheel, {
      width,
      length,
      load,
      speed: 0,
      slip,
      wheelReaction,
      shared,
    });
    world.advance(1);
    const fields = world.fields.port(wheelReaction.name).region;
    const [normal, drawbar, torque] = regionWords(world.memory, fields);
    const entry = Math.acos(1 - soil.read(0).sinkage / radius);
    const half = 0.5 * entry;
    // The rim-pressure contribution grows by at most b C R² a for each radian of entry.
    const angleError = 0.5e-9;
    const normalError = width * (stiffness * radius * radius * entry + 2 * radius * cohesion) * angleError;
    close(normal, load, normalError);
    if (!cohesion) {
      // The pressure is symmetric about a/2; the paired sine/cosine resultants point there exactly.
      close(drawbar, -normal * Math.tan(half), 4096 * eps * normal);
      assert.equal(torque, 0);
    } else {
      const k = radius / shearLength;
      const coeff = width * radius * radius * cohesion;
      const exact = coeff * (entry + Math.expm1(-k * entry) / k);
      // Composite midpoint on 24 intervals on each half; |f''| <= k² for the dimensionless integrand.
      const midpointError = (coeff * entry * (half / 24) ** 2 * k * k) / 24;
      close(torque, exact, midpointError);
      const falloff = Math.exp(-k * entry);
      const sine = Math.sin(entry);
      const cosine = Math.cos(entry);
      const along = sine - (k * cosine + sine - k * falloff) / (1 + k * k);
      const upward = 1 - cosine - (k * sine - cosine + falloff) / (1 + k * k);
      const lever = Math.tan(half);
      const traction = width * radius * cohesion;
      const expected = traction * along - (normal - traction * upward) * lever;
      const forceError = (traction * entry * (half / 24) ** 2 * (1 + k) ** 2 * (1 + lever)) / 24;
      close(drawbar, expected, forceError);
    }
    const snapshot = world.takeSnapshot();
    world.advance(4);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(4);
    assert.equal(world.hash(), hash);
  }
});

test('cross-track wheel berms conserve each side allocation and export an absent bank', async () => {
  const base = { columns: 90, rows: 140, width: 0.36, depth: 0.8, centre: [0, 0] };
  const offCentre = { ...base, width: 0.18, centre: [-0.06, 0] };
  const wheel = { radius: 0.12, bermProfile: 'cross-track' };
  const material = {
    cohesiveModulus: 0,
    frictionalModulus: 800_000,
    compaction: 0,
    dustFraction: 0,
    reposeSlope: 0.55,
  };
  const rig = { width: 0.1, length: 0.16, load: 100, speed: 0.03, slip: 0 };
  for (const [terrain, amount, shared] of [
    [base, 1, false],
    [offCentre, 0.5, true],
  ]) {
    const { world, soil, bed } = await rollingBench(terrain, material, wheel, { ...rig, shared });
    world.advance(1);
    const budget = soil.budget;
    assert.ok(budget.removed > 0);
    close(budget.deposited, budget.removed * amount, 512 * eps * budget.removed);
    close(budget.exported, budget.removed * (1 - amount), 512 * eps * budget.removed);
    close(bed.volume(), -budget.exported, 2048 * eps * budget.removed);
    const elevations = bed.elevations();
    const positive = (left) =>
      elevations.some((height, i) => {
        const x = terrain.centre[0] + terrain.width * (Math.floor(i / (terrain.rows + 1)) / terrain.columns - 0.5);
        return height > 0 && (left ? x < 0 : x > 0);
      });
    assert.ok(positive(true));
    assert.equal(positive(false), amount === 1);
    const snapshot = world.takeSnapshot();
    world.advance(16);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(16);
    assert.equal(world.hash(), hash);
  }
});

test('turning grousers return a bounded share of the cut while locked grousers carry none', async () => {
  const terrain = { columns: 100, rows: 200, width: 0.4, depth: 0.8, centre: [0, 0] };
  const wheel = { radius: 0.12, lugHeight: 0.012, bermProfile: 'cross-track', skidExponent: 0 };
  const material = {
    cohesiveModulus: 0,
    frictionalModulus: 800_000,
    compaction: 0,
    dustFraction: 0,
    reposeSlope: 0.55,
  };
  const rig = { width: 0.1, length: 0.16, load: 100, speed: 0.03 };
  for (const slip of [1, -1]) {
    const empty = await rollingBench(terrain, material, wheel, { ...rig, slip });
    const carrying = await rollingBench(
      terrain,
      material,
      { ...wheel, grouserFill: 1 },
      { ...rig, slip, shared: true },
    );
    empty.world.advance(1);
    carrying.world.advance(1);
    const before = empty.bed.elevations();
    const after = carrying.bed.elevations();
    assert.equal(carrying.soil.budget.removed, empty.soil.budget.removed);
    close(carrying.bed.volume(), 0, 2048 * eps * carrying.soil.budget.removed);
    if (slip === -1) {
      assert.deepEqual(after, before);
    } else {
      const row = 50 * (terrain.rows + 1);
      const track = before.subarray(row, row + terrain.rows + 1);
      const filled = after.subarray(row, row + terrain.rows + 1);
      assert.ok(track.some((height, i) => height < 0 && filled[i] > height));
      assert.ok(track.some((height, i) => height < 0 && filled[i] === height));
    }
  }

  const lateral = 3;
  const oblique = await rollingBench(terrain, material, { ...wheel, grouserFill: 1 }, { ...rig, slip: 1, lateral });
  oblique.world.advance(1);
  const matched = oblique.soil.read(0).sinkage - wheel.lugHeight;
  const halfArc = 0.5 * Math.sqrt(matched * (2 * wheel.radius - matched));
  const zMid = -0.16 + halfArc;
  const positive = oblique.bed.elevations();
  let oppositeBank = 0;
  let leadingBank = 0;
  for (let x = 0; x <= terrain.columns; x++) {
    for (let z = 0; z <= terrain.rows; z++) {
      const rx = terrain.width * (x / terrain.columns - 0.5);
      const rz = terrain.depth * (z / terrain.rows - 0.5) - zMid;
      if (rx + lateral * rz > 0) leadingBank += Math.max(0, positive[x * (terrain.rows + 1) + z]);
      else oppositeBank += Math.max(0, positive[x * (terrain.rows + 1) + z]);
    }
  }
  assert.ok(oppositeBank > 0);
  assert.equal(leadingBank, 0);
  close(oblique.bed.volume(), 0, 2048 * eps * oblique.soil.budget.removed);
});

test('cross-track banks keep mirror symmetry and settle after the wheel load ends', async () => {
  const terrain = { columns: 128, rows: 240, width: 0.32, depth: 1.2, centre: [0, 0] };
  const wheel = { radius: 0.048, lugHeight: 0.005, skidExponent: 0, bermProfile: 'cross-track' };
  const slope = Math.tan((29 * Math.PI) / 180);
  const material = {
    cohesiveModulus: 0,
    frictionalModulus: 8_000_000,
    exponent: 1.46,
    cohesion: 0,
    friction: slope,
    shearLength: 0.021,
    dustFraction: 0,
    compaction: 0.0576,
    reposeSlope: slope,
  };
  const rig = { width: 0.05, length: 0.07, load: 9.78314, speed: 0.03, slip: -1, stop: 120 };
  for (const shared of [false, true]) {
    const { world, soil, bed } = await rollingBench(terrain, material, wheel, { ...rig, shared });
    world.advance(121);
    const initialCrest = bed.elevations().reduce((highest, value) => Math.max(highest, value), 0);
    const stopped = soil.budget;
    const snapshot = world.takeSnapshot();
    world.advance(240);
    assert.deepEqual(soil.budget, stopped);
    assert.ok(soil.work.relaxedVolume > 0);
    const elevations = bed.elevations();
    const crest = elevations.reduce((highest, value) => Math.max(highest, value), 0);
    assert.ok(crest > 0 && crest < 0.5 * initialCrest);
    const stride = terrain.rows + 1;
    for (let x = 1; x < terrain.columns / 2; x++) {
      for (let z = 1; z < terrain.rows; z++) {
        close(elevations[x * stride + z], elevations[(terrain.columns - x) * stride + z], 64 * eps * initialCrest);
      }
    }
    close(bed.volume(), -stopped.compacted, 2048 * eps * stopped.removed);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(240);
    assert.equal(world.hash(), hash);
  }
});

test('rolling grousers reuse older trailing cut capacity without excavating it twice', async () => {
  const terrain = { columns: 100, rows: 200, width: 0.4, depth: 0.8, centre: [0, 0] };
  const wheel = { radius: 0.12, lugHeight: 0.012, bermProfile: 'cross-track', skidExponent: 0 };
  const material = {
    cohesiveModulus: 0,
    frictionalModulus: 800_000,
    compaction: 0,
    dustFraction: 0,
    reposeSlope: 0.55,
  };
  const rig = { width: 0.1, length: 0.16, load: 100, speed: 0.03, slip: 1 };
  for (const shared of [false, true]) {
    const fresh = await rollingBench(terrain, material, wheel, { ...rig, shared });
    const carrying = await rollingBench(terrain, material, { ...wheel, grouserFill: 1 }, { ...rig, shared });
    fresh.world.advance(240);
    carrying.world.advance(120);
    const snapshot = carrying.world.takeSnapshot();
    carrying.world.advance(240);
    // At four seconds these two stations trail the axle by four and seven centimetres.
    const axle = -0.16 + rig.speed * 4;
    for (const behind of [0.04, 0.07]) {
      assert.ok(fresh.bed.bed.sample(0, axle - behind).elevation < 0);
      assert.equal(carrying.bed.bed.sample(0, axle - behind).elevation, 0);
    }
    const budget = carrying.soil.budget;
    assert.equal(budget.removed, fresh.soil.budget.removed);
    assert.equal(budget.deposited, budget.removed);
    assert.equal(budget.exported, 0);
    close(carrying.bed.volume(), 0, 2048 * eps * budget.removed);
    const hash = carrying.world.hash();
    carrying.world.restoreSnapshot(snapshot.bytes);
    carrying.world.advance(240);
    assert.equal(carrying.world.hash(), hash);
  }
});

test('a yawed smooth wheel reproduces the sidewall earth pressure integral', async () => {
  const terrain = { columns: 72, rows: 160, width: 0.36, depth: 0.8, centre: [0, 0] };
  const radius = 0.14;
  const gravity = 9.81;
  const density = 1300;
  const wheelSideForce = soilWheelSideForceField('smooth-sidewall');
  const material = { cohesiveModulus: 0, frictionalModulus: 250_000, cohesion: 0, friction: 0, density };
  const wheel = { radius, peakFraction: 0.5, peakSlip: 0, exitFraction: -1 };
  const rig = { width: 0.1, length: 0.16, load: 100, speed: 0.03, slip: 0, sidewallGravity: gravity, wheelSideForce };
  let previous;
  for (const [lateral, shared] of [
    [1, false],
    [-1, true],
    [0, true],
  ]) {
    const { world, soil } = await rollingBench(terrain, material, wheel, { ...rig, lateral, shared });
    world.advance(1);
    const side = regionWords(world.memory, world.fields.port(wheelSideForce.name).region)[0];
    if (!lateral) {
      assert.equal(side, 0);
      continue;
    }
    const a = Math.acos(1 - soil.read(0).sinkage / radius);
    const s = Math.sin(a);
    const c = Math.cos(a);
    const integral = 2 * (s - s ** 3 / 3 - c * (a + 0.5 * Math.sin(2 * a)) + c * c * s);
    const pressure = (density * gravity * radius ** 3) / 4;
    const largestInterval = (1.5 * a) / 24;
    const curvatureBound = 2 + 6 * (1 - c) + (1 - c) ** 2;
    const midpointError = (pressure * 2 * a * largestInterval ** 2 * curvatureBound) / 24;
    close(side, lateral * pressure * integral, midpointError);
    if (previous === undefined) previous = side;
    else assert.equal(side, -previous);
  }
});

test('a locked smooth wheel has the exact saturated two-region axle moment', async () => {
  const terrain = { columns: 72, rows: 160, width: 0.36, depth: 0.8, centre: [0, 0] };
  const radius = 0.125;
  const width = 0.14;
  const cohesion = 1200;
  const exitFraction = -0.48;
  const wheelReaction = soilWheelReactionField('skid-reaction');
  const wheel = { radius, peakFraction: 0.2, exitFraction, skidExponent: 0.55 };
  const material = { cohesiveModulus: 0, frictionalModulus: 800_000, friction: 0, cohesion, shearLength: 0.021 };
  const rig = { width, length: 0.16, load: 70, speed: 0.05, wheelReaction };
  const free = await rollingBench(terrain, material, wheel, { ...rig, slip: 0 });
  const locked = await rollingBench(terrain, material, wheel, { ...rig, slip: -1, shared: true });
  free.world.advance(1);
  locked.world.advance(1);
  const angle = (model) => Math.acos(1 - model.soil.read(0).sinkage / radius);
  const entry = angle(locked);
  const rear = exitFraction * angle(free);
  const transition = 0.5 * entry;
  const reversal = Math.acos((Math.sin(entry) - Math.sin(transition)) / (entry - transition));
  const [, drawbar, torque] = regionWords(locked.world.memory, locked.world.fields.port(wheelReaction.name).region);
  close(torque, width * radius * radius * cohesion * (entry + rear - 2 * reversal), 8192 * eps * Math.abs(torque));
  assert.ok(drawbar < 0 && torque < 0 && entry > angle(free));
  assert.ok(locked.bed.bed.sample(0, -0.16).elevation < 0);
});

test('held-out Ding et al. Wh2 drawbar and torque at 60% tip slip', async () => {
  const terrain = { columns: 72, rows: 160, width: 0.36, depth: 0.8, centre: [0, 0] };
  const radius = 0.15735;
  const lugHeight = 0.01;
  const wheelReaction = soilWheelReactionField('wh2-reaction');
  // Eq. 8 converts the test's 0.6 tip slip to our r + h/2 shearing radius.
  const slip = 1 - (0.4 * (radius + lugHeight)) / (radius + 0.5 * lugHeight);
  const { world, bed } = await rollingBench(
    terrain,
    {
      cohesiveModulus: 15_600,
      frictionalModulus: 2_407_400,
      exponent: 0.84,
      cohesion: 251,
      friction: Math.tan((31.9 * Math.PI) / 180),
      shearLength: 0.0114,
      dustFraction: 0,
    },
    { radius, lugHeight, lugSupport: 0.0015, slipExponent: 0.72 },
    { width: 0.165, length: 0.12, load: 80, speed: 0.01, slip, wheelReaction },
  );
  world.advance(120);
  const [, drawbar, torque] = regionWords(world.memory, world.fields.port(wheelReaction.name).region);
  // Figure 6(a) and (c), projected marker edges and corresponding labelled ticks in PDF points.
  const pull = (y) => 30 - ((y - 208.38) * 40) / (276.18 - 208.38);
  const moment = (y) => ((361.26 - y) * 8) / (361.26 - 304.68);
  assert.ok(drawbar >= pull(217.92) && drawbar <= pull(216.54), `Wh2 drawbar ${drawbar} N`);
  assert.ok(torque >= moment(310.217) && torque <= moment(308.58), `Wh2 torque ${torque} N·m`);
  assert.ok(bed.bed.sample(0, -0.145).elevation < 0);
});

test('live spin phase cuts with a discrete grouser and repeats at one tooth pitch', async (t) => {
  const terrain = { columns: 100, rows: 100, width: 0.2, depth: 0.2, centre: [0, 0] };
  const input = soilPatchField('grouser-load');
  const wheelPhase = soilWheelPhaseField('grouser-phase');
  const wheelCamber = soilWheelCamberField('grouser-camber');
  const radius = 0.15735;
  const lugHeight = 0.01;
  const lugCount = 4;
  const wheel = { radius, lugHeight, lugCount, lugWidth: 0.008 };
  const material = { cohesiveModulus: 0, frictionalModulus: 2_407_400, exponent: 0.84, compaction: 1 };
  async function stamp(angle, shared, geometry = wheel, tilt = 0) {
    let load, phase, camber;
    const bench = {
      describe: () => ({
        id: 'grouser-rig',
        rate: 0,
        stableRate: () => 0,
        fields: [
          { field: input, access: 'write' },
          { field: wheelPhase, access: 'write' },
          { field: wheelCamber, access: 'write' },
        ],
      }),
      init(host) {
        load = host.allocate('grouser-load', 80, 'f64', 1);
        phase = host.allocate('grouser-phase', 8, 'f64', 1);
        camber = host.allocate('grouser-camber', 8, 'f64', 1);
        regionWords(host.memory, load).set([0, 0, 0, 1, 0.12, 0.08, 80, 0, 0, 0]);
        regionWords(host.memory, phase)[0] = angle;
        regionWords(host.memory, camber)[0] = tilt;
      },
      step() {},
      exportPorts: (tick) => [
        { field: input.name, region: load, tick, cell: [0, 0, 0] },
        { field: wheelPhase.name, region: phase, tick, cell: [0, 0, 0] },
        { field: wheelCamber.name, region: camber, tick, cell: [0, 0, 0] },
      ],
      importPorts() {},
      stateRegions: () => [load, phase, camber],
      extraState: () => [],
    };
    const soil = await Terramechanics.load({ tier: 'resolved', input, wheelPhase, wheelCamber });
    const bed = new TerrainBed();
    const world = new PhysicsWorld({ rate, memory: worldMemory(shared) })
      .add(bed, { ...terrain, elevations: () => 0 })
      .add(bench)
      .add(soil, { terrain, material, inputRows: 1, rollingWheels: [geometry] })
      .couple(['grouser-rig', 'terramechanics', 'bed'], 'staggered');
    world.advance(1);
    const areas = bedVertexAreas(terrain);
    const pressure = regionWords(world.memory, world.fields.port(soil.pressureField.name).region);
    close(
      pressure.reduce((sum, value, i) => sum + value * areas[i], 0),
      80,
      1024 * eps * 80,
    );
    const centre = 50 * 101 + 50;
    return { elevations: bed.elevations(), centre, rim: soil.read(0).sinkage, pressure: pressure[centre] };
  }
  const down = await stamp(0, false);
  const pitch = (2 * Math.PI) / lugCount;
  const gap = await stamp(0.5 * pitch, false);
  const repeat = await stamp(pitch, true);
  close(-down.elevations[down.centre], down.rim + lugHeight, 1024 * eps);
  assert.equal(gap.elevations[gap.centre], 0);
  assert.ok(down.pressure > 0 && gap.pressure === 0);
  assert.deepEqual(repeat.elevations, down.elevations);
  assert.equal(gap.rim, down.rim);

  await t.test('an offset indexed tread intersects the bed only when it rotates down', async () => {
    const y = -(radius + lugHeight);
    const treadMesh = {
      positions: [0.05, y, -0.004, 0.07, y, -0.004, 0.07, y, 0.004, 0.05, y, 0.004],
      indices: [0, 1, 2, 0, 2, 3],
    };
    const geometry = { radius, lugHeight, treadMesh };
    const down = await stamp(0, true, geometry);
    const repeat = await stamp(0, false, geometry);
    const sideways = await stamp(Math.PI / 2, false, geometry);
    const atTread = 80 * 101 + 50;
    const acrossFromTread = 20 * 101 + 50;
    close(-down.elevations[atTread], down.rim + lugHeight, 1024 * eps);
    assert.equal(down.elevations[acrossFromTread], 0);
    assert.equal(sideways.elevations[atTread], 0);
    assert.equal(down.rim, sideways.rim);
    assert.deepEqual(down.elevations, repeat.elevations);
  });

  await t.test('camber moves the indexed contact to its exact angled plane', async () => {
    const y = -(radius + lugHeight);
    const treadMesh = {
      positions: [0.03, y, -0.008, 0.09, y, -0.008, 0.09, y, 0.008, 0.03, y, 0.008],
      indices: [0, 1, 2, 0, 2, 3],
      columns: 129,
    };
    const geometry = { radius, lugHeight, treadMesh };
    const lowered = await stamp(0, true, geometry, -0.6);
    const raised = await stamp(0, false, geometry, 0.6);
    const x = -0.06;
    const authoredX = (x - 0.6 * y) / 0.8;
    const rotatedHeight = -0.6 * authoredX + 0.8 * y;
    const atTread = 20 * 101 + 50;
    close(-lowered.elevations[atTread], lowered.rim - radius - rotatedHeight, 1024 * eps);
    assert.equal(raised.elevations[atTread], 0);
  });
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
  const wheelPhase = tier === 'resolved' ? soilWheelPhaseField() : undefined;
  const wheelCamber = tier === 'resolved' ? soilWheelCamberField() : undefined;
  const soil = await Terramechanics.load({ input: contact, tier, wheelPhase, wheelCamber });
  const rigid = new SoilContactRigidSolver(contact, { terrain, wheelPhase, wheelCamber });
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
      axle: tier === 'resolved' ? [-0.8, -0.6, 0] : undefined,
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
    rollingWheels:
      tier === 'resolved'
        ? [...wheels.map(({ radius }) => ({ radius, lugHeight: 0.012, lugWidth: 0.03, lugCount: 8 })), null, null]
        : undefined,
  });
  world.couple(['rigid', 'terramechanics', 'bed'], 'staggered');
  world.advance(7);
  assert.ok(soil.read(0).normalForce > 0 && soil.read(4).normalForce > 0);
  assert.equal(soil.read(0).normalForce, vehicle.wheel(0).load);
  assert.equal(soil.read(4).normalForce, tracked.track(0).load);
  assert.ok(vehicle.wheelGround(0).sinkage > 0);
  assert.ok(floor.collider.heightfieldHeights().some((h) => h < 0));
  if (wheelPhase) {
    const phases = regionWords(world.memory, world.fields.port(wheelPhase.name).region);
    assert.equal(phases[0], vehicle.wheel(0).rotation);
    const cambers = regionWords(world.memory, world.fields.port(wheelCamber.name).region);
    assert.equal(cambers[0], vehicle.wheelCamberSine(0));
    assert.ok(cambers[0] > 0.5);
  }
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

async function withWheelReaction(initialSpin, initialSpeed, check, sideSpeed = 0) {
  await Physics.load({ threads: true });
  const terrain = { columns: 72, rows: 96, width: 1.8, depth: 2.4, centre: [0, 0] };
  const input = soilPatchField();
  const wheelReaction = soilWheelReactionField();
  const wheelSideForce = sideSpeed ? soilWheelSideForceField() : undefined;
  const soil = await Terramechanics.load({ tier: 'resolved', input, wheelReaction, wheelSideForce });
  const rigid = new SoilContactRigidSolver(input, { terrain, wheelReaction, wheelSideForce });
  const world = new PhysicsWorld({ rate, memory: worldMemory(true) });
  const bed = new TerrainBed();
  world.add(bed, { ...terrain, elevations: () => 0 });
  using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60 });
  const ground = new BedCollider(physics, bed.bed);
  const mass = 60;
  const radius = 0.16;
  const inertia = 0.6;
  const chassis = physics.addBody(null, {
    type: 'dynamic',
    position: [0, 0.28, 0],
    lockRotations: true,
    enabledTranslations: [sideSpeed !== 0, false, true],
    colliders: { shape: 'box', halfExtents: [0.1, 0.05, 0.1], mass },
  });
  chassis.setLinearVelocity([sideSpeed, 0, initialSpeed]);
  using vehicle = new Vehicle(physics, chassis, {
    wheels: [{ position: [0, 0, 0], radius, inertia, suspensionRestLength: 0.3, suspensionStiffness: 8 }],
    tyre: { forces: () => ({ longitudinal: 0, lateral: 0 }) },
  });
  const seed = new Float64Array(vehicle.motionStateWords);
  vehicle.writeMotionState(seed);
  seed[3] = initialSpin; // First wheel's spin after the three recorded driver controls.
  vehicle.readMotionState(seed);
  if (initialSpin === 0) vehicle.setInput({ brake: 1 });
  world.add(rigid, {
    physics,
    ground,
    wheels: [{ vehicle, patches: [{ width: 0.165, length: 0.16 }], shearRadii: [radius] }],
  });
  world.add(soil, {
    terrain,
    inputRows: 1,
    material: initialSpin
      ? { cohesion: 6000, friction: 0.7, compaction: 1 }
      : {
          cohesiveModulus: 0,
          frictionalModulus: 8_000_000,
          exponent: 1.46,
          cohesion: 1000,
          friction: Math.tan((29 * Math.PI) / 180),
          shearLength: 0.021,
          compaction: 1,
        },
    rollingWheels: [{ radius, skidExponent: 0.55 }],
  });
  world.couple(['rigid', 'terramechanics', 'bed'], 'staggered');
  check({ physics, world, ground, chassis, vehicle, mass, radius, inertia, wheelReaction, wheelSideForce, seed });
}

test('a powered wheel consumes the native drawbar force and axle moment without adding kinetic energy', async () => {
  await withWheelReaction(
    10,
    0.2,
    ({ physics, world, ground, chassis, vehicle, mass, radius, inertia, wheelReaction, seed }) => {
      world.advance(1);
      const energy = () => 0.5 * (mass * vehicle.speed ** 2 + inertia * vehicle.wheel(0).spin ** 2);
      const before = energy();
      const spin = vehicle.wheel(0).spin;
      const speed = vehicle.speed;
      const [normal, drawbar, torque] = regionWords(world.memory, world.fields.port(wheelReaction.name).region);
      assert.ok(normal > 0 && drawbar > 0 && torque > 0);
      assert.ok(Math.abs(vehicle.wheel(0).forwardImpulse) <= (mass * Math.abs(10 * radius - 0.2)) / 2 ** 15);
      world.advance(2);
      const wheel = vehicle.wheel(0);
      assert.ok(
        wheel.forwardImpulse > 0 && wheel.spin < spin,
        `traction: ${wheel.forwardImpulse} N·s, spin ${spin} → ${wheel.spin} rad/s, load ${wheel.load} N`,
      );
      const scale = (60 * wheel.forwardImpulse) / drawbar;
      close(wheel.spin - spin, -(torque * scale) / (60 * inertia), 2048 * eps * spin);
      const [nx, ny, nz] = wheel.contactNormal;
      const tangent = Math.hypot(ny, nz);
      const normalImpulse = (wheel.load * nz) / 60;
      const tyreImpulse = (wheel.forwardImpulse * ny + wheel.sideImpulse * nx * nz) / tangent;
      close(vehicle.speed - speed, (normalImpulse + tyreImpulse) / mass, 2 ** -23 * vehicle.speed);
      assert.ok(energy() < before);
      const mark = world.takeSnapshot();
      world.advance(14);
      const hash = world.hash();
      world.restoreSnapshot(mark.bytes);
      world.advance(14);
      assert.equal(world.hash(), hash);
      vehicle.readMotionState(seed);
      chassis.setLinearVelocity([0, 0, 0.2]);
      vehicle.setWheelGroundTraction(0, { collider: ground.collider, load: 100, drawbar: 250, axleTorque: 0 });
      physics.step();
      assert.equal(vehicle.wheel(0).forwardImpulse, 0, 'force with no driving work is rejected by the discrete bound');
      assert.equal(vehicle.wheel(0).spin, 10);
    },
  );
});

test('a live locked wheel uses the reverse axle moment and brakes at crawl speed', async () => {
  await withWheelReaction(0, 0.09, ({ world, vehicle, mass, inertia, wheelReaction }) => {
    world.advance(1);
    const [normal, drawbar, torque] = regionWords(world.memory, world.fields.port(wheelReaction.name).region);
    assert.ok(normal > 0 && drawbar < 0 && torque < 0);
    const speed = vehicle.speed;
    world.advance(2);
    const wheel = vehicle.wheel(0);
    assert.ok(wheel.forwardImpulse < 0 && wheel.spin > 0);
    const accepted = (60 * wheel.forwardImpulse) / drawbar;
    close(wheel.spin, (-torque * accepted) / (60 * inertia), 2048 * eps * wheel.spin);
    // Isolate the tangential coupling. The sloped live bed also gives the suspension impulse a z component.
    const afterSuspension = speed + (wheel.contactNormal[2] * wheel.load) / (60 * mass);
    const before = 0.5 * mass * afterSuspension ** 2;
    const after = 0.5 * (mass * vehicle.speed ** 2 + inertia * wheel.spin ** 2);
    assert.ok(vehicle.speed < afterSuspension && after - before <= 2 ** -22 * before);
    const snapshot = world.takeSnapshot();
    world.advance(10);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(10);
    assert.equal(world.hash(), hash);
  });
});

test('live yawed soil contact damps side slip with the exported right-axis force', async () => {
  await withWheelReaction(
    10,
    0.24,
    ({ world, chassis, vehicle, mass, wheelSideForce }) => {
      world.advance(1);
      const movement = chassis.linearVelocity[0];
      const [side] = regionWords(world.memory, world.fields.port(wheelSideForce.name).region);
      assert.ok(side < 0);
      world.advance(2);
      const wheel = vehicle.wheel(0);
      assert.ok(wheel.sideImpulse > 0);
      const [nx, ny, nz] = wheel.contactNormal;
      const rightX = Math.hypot(ny, nz);
      const suspended = movement + (nx * wheel.load) / (60 * mass);
      assert.ok(chassis.linearVelocity[0] < suspended);
      close(chassis.linearVelocity[0] - suspended, (-rightX * wheel.sideImpulse) / mass, 2 ** -22 * suspended);
      const snapshot = world.takeSnapshot();
      world.advance(12);
      const hash = world.hash();
      world.restoreSnapshot(snapshot.bytes);
      world.advance(12);
      assert.equal(world.hash(), hash);
    },
    0.16,
  );
});
