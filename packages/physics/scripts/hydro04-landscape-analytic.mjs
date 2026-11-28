// Analytic controls for the live LandscapeEvolution and TerrainBed, in SI units.
// Braun & Willett (2013), https://doi.org/10.1016/j.geomorph.2012.10.008.
// Roering, Kirchner & Dietrich (1999), https://doi.org/10.1029/1998WR900090.
// Hasbargen & Paola (2000), Geology 28, 1067–1070, demonstrate autocyclic
// erosion under controlled rainfall and uplift, without a matching material law
// available for these controls. Lague et al. (2003), §5,
// https://doi.org/10.1029/2002JB001785, infer erosion/transport parameters from
// the topographic response. The XLM experiments of Sweeney et al. (2020),
// https://doi.org/10.1029/2020JF005525, publish elevation histories. The related
// 2015 Supplement Table S1 (https://doi.org/10.1126/science.aab0017) takes K and
// m from slope–area data and diffusivity from observed hillslope geometry.
// None supplies measured-parameter validation of both controls here.
// Run after building Physics: node packages/physics/scripts/hydro04-landscape-analytic.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TerrainBed } from '../dist/earth.js';
import { LandscapeEvolution } from '../dist/landscape.js';
import { PhysicsWorld, regionWords } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const noOtherProcesses = {
  rainfall: 0,
  erodibility: 0,
  hillslopeDiffusivity: 0,
  thermalDiffusivity: 0,
  alluvialDepth: 0,
};
const builds = ['landscape.js', 'landscape-kernel.wasm'];
const artifacts = Object.fromEntries(
  await Promise.all(
    builds.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(new URL(`../dist/${name}`, import.meta.url)))
        .digest('hex'),
    ]),
  ),
);

function make(grid, elevations, model, params) {
  const terrain = new TerrainBed();
  const world = new PhysicsWorld({ rate });
  world.add(terrain, { ...grid, elevations });
  world.add(model, { grid, ...noOtherProcesses, ...params });
  return { world, terrain };
}

function steadyShear(grid) {
  const field = { name: 'analyticShear', kind: 'uniformGrid', quantity: 'pressure', unit: 'Pa', centring: 'vertex' };
  let region;
  return {
    field,
    describe: () => ({ id: field.name, rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(host) {
      region = host.allocate('uniform-transport-shear', 8 * (grid.columns + 1) * (grid.rows + 1), 'f64', 1);
      regionWords(host.memory, region).fill(1000);
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: field.name, tick, cell: [0, 0, 0], region }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

function vertices(grid, evaluate) {
  const rows = grid.rows + 1;
  return Float64Array.from({ length: (grid.columns + 1) * rows }, (_, i) => evaluate(Math.floor(i / rows), i % rows));
}

function appliedTerrain({ terrain, world }, model, ticks) {
  const initial = terrain.volume();
  world.advance(ticks);
  const { uplift, exported, elapsed } = model.budget;
  // TerrainBed applies the accumulated bed change on the next coupling tick.
  world.advance(ticks + 1);
  const exportedVolume = exported.reduce((a, b) => a + b, 0);
  const actual = terrain.volume();
  const expected = initial + uplift - exportedVolume;
  const ledgerErrorM3 = actual - expected;
  const roundoff =
    16 * ticks * Number.EPSILON * Math.max(Math.abs(initial), Math.abs(actual), Math.abs(uplift), exportedVolume);
  assert.ok(Math.abs(ledgerErrorM3) <= roundoff, 'Applied bed volume must close against uplift and sediment export.');
  return { elapsed, uplift, exportedVolume, ledgerErrorM3 };
}

async function streamPower(columns) {
  const width = 1.2; // Cross-channel width of the active central row.
  const length = 12;
  const upstreamArea = 6;
  const rainfall = 0.005;
  const uplift = 0.004;
  const k = 0.4;
  const m = 0.5;
  const grid = { columns, rows: 2, width: length, depth: 2 * width, centre: [0, 0] };
  const dx = length / columns;
  const runoff = (x) => rainfall * (upstreamArea + width * x);
  const prefactor = uplift / (k * (rainfall * width) ** m);
  const areaLength = upstreamArea / width;
  const surface = (x) => (prefactor * ((length + areaLength) ** (1 - m) - (x + areaLength) ** (1 - m))) / (1 - m);
  // The raised dry side rows force a fixed-width 1-D channel without replacing
  // the drainage implementation. Add upstream catchment water at the first
  // vertex's half control volume. Seed from 75% of the independent target.
  const elevations = vertices(grid, (x, z) => (z === 1 ? 0.75 * surface(x * dx) : 10));
  const rain = vertices(grid, (x, z) =>
    z === 1 ? rainfall * (1 + (x === 0 ? upstreamArea / ((width * dx) / 2) : 0)) : 0,
  );
  const lift = vertices(grid, (_x, z) => (z === 1 ? uplift : 0));
  const shear = steadyShear(grid);
  const model = await LandscapeEvolution.load({ shearField: shear.field });
  const scene = make(grid, elevations, model, {
    rainfall: rain,
    uplift: lift,
    erodibility: k,
    dischargeExponent: m,
    secondsPerSecond: 15,
    outlets: { maxX: true },
  });
  // Prescribed high shear makes transport capacity ample. The analytical law
  // tests threshold-free incision in the detachment-limited regime.
  scene.world.add(shear, {});
  const receipt = appliedTerrain(scene, model, 3200);
  assert.ok(model.budget.alluvium <= 1e-12, 'Transport capacity limited the analytic incision control.');
  const accepted = scene.terrain.elevations();
  const headM = accepted[1];
  const exactHeadM = surface(0);
  const expectedOutflow = runoff(length);
  assert.ok(
    Math.abs(model.read(columns, 1).discharge - expectedOutflow) <= 32 * columns * Number.EPSILON * expectedOutflow,
  );
  // Midpoint quadrature of S(x)=U/(KQ(x)^m) has error <= L dx² max|S''|/24.
  const curvatureBound = (prefactor * m * (m + 1)) / areaLength ** (m + 2);
  const heightBoundM = (length * dx * dx * curvatureBound) / 24;
  let maxHeightErrorM = 0;
  let maxIncisionErrorMPerS = 0;
  for (let x = 0; x < columns; x++) {
    maxHeightErrorM = Math.max(maxHeightErrorM, Math.abs(accepted[3 * x + 1] - surface(x * dx)));
    maxIncisionErrorMPerS = Math.max(maxIncisionErrorMPerS, Math.abs(model.read(x, 1).incision - uplift));
  }
  assert.ok(maxHeightErrorM <= heightBoundM, 'Steady stream-power profile misses independent midpoint error bound.');
  return { columns, headM, exactHeadM, maxHeightErrorM, heightBoundM, maxIncisionErrorMPerS, ...receipt };
}

async function closedCreep(columns) {
  const length = 4;
  const amplitude = 0.15;
  const diffusivity = 0.06;
  const k = Math.PI / length;
  const grid = { columns, rows: columns / 2, width: length, depth: 2, centre: [0, 0] };
  // Keep D·dt/dx² fixed under refinement so that the split time step refines too.
  const refinement = (columns / 24) ** 2;
  const shape = (t, x) => 1 + amplitude * Math.exp(-diffusivity * k * k * t) * Math.cos(k * x);
  const elevations = vertices(grid, (x) => shape(0, (x * length) / columns));
  const model = await LandscapeEvolution.load();
  const scene = make(grid, elevations, model, { hillslopeDiffusivity: diffusivity, secondsPerSecond: 1 / refinement });
  const receipt = appliedTerrain(scene, model, 600 * refinement);
  const expected = vertices(grid, (x) => shape(receipt.elapsed, (x * length) / columns));
  const actual = scene.terrain.elevations();
  const maxHeightErrorM = Math.max(...expected.map((z, i) => Math.abs(z - actual[i])));
  assert.equal(receipt.exportedVolume, 0);
  return { columns, rows: grid.rows, stepS: 1 / (rate.num * refinement), maxHeightErrorM, ...receipt };
}

async function openParabola() {
  const length = 4;
  const diffusivity = 0.06;
  const uplift = 0.006;
  const grid = { columns: 32, rows: 8, width: length, depth: 2, centre: [0, 0] };
  // Classical Dirichlet steady state for h_t=U+D h_xx with endpoints at zero.
  const elevations = vertices(grid, (i) => {
    const x = (i * length) / grid.columns;
    return (uplift * x * (length - x)) / (2 * diffusivity);
  });
  const model = await LandscapeEvolution.load();
  const scene = make(grid, elevations, model, {
    uplift,
    hillslopeDiffusivity: diffusivity,
    outlets: { minX: true, maxX: true },
  });
  const receipt = appliedTerrain(scene, model, 600);
  const actual = scene.terrain.elevations();
  const maxHeightDriftM = Math.max(...elevations.map((z, i) => Math.abs(z - actual[i])));
  return {
    boundary: 'The solver omits creep across faces incident to fixed outlets.',
    expectedSteadyDiffusiveExportM3: uplift * length * grid.depth * receipt.elapsed,
    maxHeightDriftM,
    ...receipt,
  };
}

const stream = [await streamPower(16), await streamPower(32)];
const creep = [await closedCreep(24), await closedCreep(48)];
assert.ok(stream[1].maxHeightErrorM < stream[0].maxHeightErrorM);
assert.ok(creep[1].maxHeightErrorM < creep[0].maxHeightErrorM);
console.log(
  JSON.stringify(
    {
      artifacts,
      evidence: 'Analytic controls. Independent measured landscape validation remains open.',
      steadyThresholdFreeStreamPower: stream,
      closedLinearHillslopeCreep: creep,
      parabolaWithFixedOutlets: await openParabola(),
    },
    null,
    2,
  ),
);
