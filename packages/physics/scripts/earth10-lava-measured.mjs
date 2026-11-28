// Measurements and experimental inputs transcribed from Additional file 1 of
// Dietterich, H. R., Lev, E., Chen, J., Richardson, J. A., & Cashman, K. V. (2017),
// Benchmarking computational fluid dynamics models of lava flow simulation for
// hazard assessment, forecasting, and risk management. https://doi.org/10.1186/s13617-017-0061-x
// Supplement attribution and sheet ranges are in the JSON fixture. The transcribed
// data use CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); SI conversion
// and scoring are performed below. Coordinates and thermal inputs are independent
// of measured held-out fronts.
// Run after building Physics:
// node packages/physics/scripts/earth10-lava-measured.mjs [A|C|D|both|all] [inertial|terminal] [throughSeconds] [fineMetres]
// Thin-film reference: Huppert (1982), https://doi.org/10.1017/S0022112082001797.
// Benchmark geometry/measurements: Cordonnier, Lev & Garel (2016), https://doi.org/10.1144/SP426.7.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LavaSolver } from '../dist/lava.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const data = JSON.parse(await readFile(new URL('./fixtures/earth10-dietterich-2017.json', import.meta.url), 'utf8'));
const [requested = 'both', transport = 'inertial', throughSeconds, fineMetres] = process.argv.slice(2);
assert.ok(['A', 'C', 'D', 'both', 'all'].includes(requested), 'Choose A, C, D, both (A and D), or all.');
assert.ok(transport === 'inertial' || transport === 'terminal', 'Choose inertial or terminal transport.');
const horizon = throughSeconds === undefined ? Infinity : Number(throughSeconds);
const specifiedSpacing = fineMetres === undefined ? undefined : Number(fineMetres);
assert.ok(
  throughSeconds === undefined || (horizon > 0 && Number.isFinite(horizon)),
  'Use a finite positive observation horizon.',
);
assert.ok(
  specifiedSpacing === undefined || (specifiedSpacing > 0 && Number.isFinite(specifiedSpacing)),
  'Use a finite positive grid spacing in metres.',
);
const dist = new URL('../dist/', import.meta.url);
async function artifactHashes() {
  const artifacts = ['lava.js', 'lava-kernel.wasm'];
  const pairs = await Promise.all(
    artifacts.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(new URL(name, dist)))
        .digest('hex'),
    ]),
  );
  return Object.fromEntries(pairs);
}
const artifact = await artifactHashes();
const rate = { num: 60, den: 1 };
if (transport === 'terminal') {
  const solver = await LavaSolver.load();
  const world = new PhysicsWorld({ rate });
  // Older distributions ignore unknown option names. The public terminal mode
  // rejects prescribed initial momentum because it computes terminal discharge.
  assert.throws(
    () => world.add(solver, { cells: [1, 1], spacing: 1, bed: 0, depth: 1, dischargeX: 1, transport }),
    { name: 'MargoError', code: 'state', message: /initial discharge.*inertial transport/ },
    'Build a Physics distribution that supports terminal lava transport.',
  );
}
const threshold = 0.0001; // Published BM-A and BM-D vertical spacing, used as a common depth contour.
const thresholdChecks = [threshold / 2, threshold, 2 * threshold];

function setup(which, dx) {
  const { inputs } = data[which];
  const slope = (inputs.slopeDegrees * Math.PI) / 180;
  const cos = Math.cos(slope);
  // A centred, cropped patch suffices for the early axisymmetric run. The
  // observations are accepted only while every contour stays inside it.
  const [width, depth] = which === 'C' ? [0.08, 0.08] : inputs.extentCm.map((value) => value / 100);
  const [nx, nz] = [Math.ceil((width * cos) / dx), Math.ceil(depth / dx)];
  const [vx, vz] =
    which === 'C'
      ? [0.5 * nx * dx, 0.5 * nz * dx]
      : [(inputs.sourceCenterCm[0] * cos) / 100, inputs.sourceCenterCm[1] / 100];
  const halfSide = inputs.sourceSideCm / 200;
  const bed = Float64Array.from({ length: nx * nz }, (_, i) => (vx - ((i % nx) + 0.5) * dx) * Math.tan(slope));
  const overlap = (cell, center, radius) =>
    Math.max(0, Math.min((cell + 1) * dx, center + radius) - Math.max(cell * dx, center - radius));
  const hot = (inputs.inletCelsius ?? 20) + 273.15;
  const ambient = (inputs.ambientCelsius ?? 20) + 273.15;
  const supply = inputs.flowMlPerS * 1e-6;
  const vents = [];
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const area = overlap(x, vx, halfSide * cos) * overlap(z, vz, halfSide);
      if (area > 0) {
        vents.push({
          cell: [x, z],
          temperature: hot,
          flow: (supply * area) / (4 * halfSide * halfSide * cos),
          end: inputs.supplySeconds,
        });
      }
    }
  }
  assert.ok(Math.abs(vents.reduce((sum, vent) => sum + vent.flow, 0) - supply) < 1e-13 * supply);

  // A is the paper's isothermal Newtonian analogue. For D, the benchmark
  // includes only the temperature-dependent viscosity as a proxy for freezing.
  // LavaSolver uses one bulk temperature and an exponential viscosity, so
  // linearise ln(mu) at the published inlet temperature, include the documented
  // default phase interval down to 1253 K, and use no unreported latent heat or
  // yield strength. The basal skin depth reproduces the paper's initial
  // model conductance k / delta = 30 W/(m² K). The lab fed lava through a chute
  // with initial momentum and time-varying outflow. The published nominal model
  // represents it with the square inlet and 220 mL/s. See Dietterich §BM-D and
  // Hyman et al. (2022), https://doi.org/10.1029/2022JB024998, §4.2.
  // VFT material coefficients are Dietterich 2017 Supplement 1, BM-D parameters
  // row 5. The sign follows d[ln(10)·(a+b/(T−c))]/dT = −ln(10)·b/(T−c)².
  const thermal =
    which === 'D'
      ? {
          liquidus: hot,
          solidus: 1253,
          viscosityRise: (Math.LN10 * 5500) / (hot - 610) ** 2,
          heatCapacity: inputs.heatCapacity,
          latentHeat: 0,
          conductivity: inputs.conductivity,
          skinDepth: inputs.conductivity / inputs.modelBasalConductance,
          convection: inputs.convection,
          emissivity: inputs.emissivity,
        }
      : {
          // C tests only the kinematics of the fully liquid, isoviscous
          // regime. Its temperature is passive in the published benchmark.
          liquidus: which === 'C' ? ambient - 1 : hot,
          solidus: which === 'C' ? ambient - 2 : hot - 1,
          viscosityRise: 0,
          latentHeat: 0,
          conductivity: 0,
          convection: 0,
          emissivity: 0,
        };
  const options = {
    ...thermal,
    cells: [nx, nz],
    spacing: dx,
    bed,
    vents,
    viscosity: inputs.viscosityPaS,
    density: inputs.densityKgPerM3,
    yieldStrength: 0,
    waterHeatTransfer: 0,
    airTemperature: ambient,
    groundTemperature: ambient,
  };
  if (transport === 'terminal') options.transport = transport;
  return { options, cos, vx, vz, supply };
}

function measure(lava, [nx, nz], dx, cos, vx, vz) {
  const probes = thresholdChecks.map((cut) => ({
    cut,
    hiX: -Infinity,
    loZ: Infinity,
    hiZ: -Infinity,
    touchesUpstream: false,
    occupied: 0,
  }));
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const depth = lava.sample(x, z).depth;
      for (const p of probes) {
        if (depth < p.cut) continue;
        p.occupied++;
        p.hiX = Math.max(p.hiX, x + 1);
        p.loZ = Math.min(p.loZ, z);
        p.hiZ = Math.max(p.hiZ, z + 1);
        p.touchesUpstream ||= x === 0;
      }
    }
  }
  return probes.map((p) => ({
    x: Math.max(0, (p.hiX * dx - vx) / cos),
    width: Math.max(0, (p.hiZ - p.loZ) * dx),
    crossExtent: Math.max(0, p.hiZ * dx - vz, vz - p.loZ * dx),
    radius: Math.sqrt(p.occupied / Math.PI) * dx,
    touchesUpstream: p.touchesUpstream,
    touchesOuterEdge: p.hiX === nx || p.loZ === 0 || p.hiZ === nz,
  }));
}

async function simulate(which, dx) {
  const { options, cos, vx, vz, supply } = setup(which, dx);
  const lava = await LavaSolver.load();
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) }).add(lava, options);
  const measured = which === 'C' ? data.C.measuredRadius : data[which].measuredXY;
  const records = measured.filter(([t]) => t > 0 && t <= horizon);
  assert.ok(records.length > 0, 'Extend the observation horizon to the first measured point.');
  const points = records.map(([time, ...distances]) => {
    const frames = time * rate.num;
    const lowerFrame = Math.floor(frames);
    const upperFrame = Math.ceil(frames);
    world.advance(lowerFrame);
    const lower = measure(lava, options.cells, dx, cos, vx, vz);
    world.advance(upperFrame);
    const upper = upperFrame === lowerFrame ? lower : measure(lava, options.cells, dx, cos, vx, vz);
    const nearest = Math.round(frames);
    const front = nearest === lowerFrame ? lower : upper;
    return {
      measuredTime: time,
      time: nearest / rate.num,
      measured: distances.map((cm) => cm / 100),
      front,
      lower,
      upper,
    };
  });
  const { suppliedVolume, storedVolume, environmentalHeat } = lava.budget;
  const finalFrame = Math.ceil(points.at(-1).measuredTime * rate.num);
  const expected = supply * Math.min(finalFrame / rate.num, data[which].inputs.supplySeconds);
  const roundoff = 64 * (finalFrame + options.cells[0] * options.cells[1]) * Number.EPSILON * expected;
  assert.ok(Math.abs(suppliedVolume - expected) <= roundoff);
  assert.ok(Math.abs(storedVolume - suppliedVolume) <= roundoff);
  assert.deepEqual(await artifactHashes(), artifact, 'Physics dist changed during the run');
  return { dx, cells: options.cells, points, suppliedVolume, storedVolume, environmentalHeat, cos };
}

function gradeRows(coarse, fine, axis, dimension, reportedPrecision) {
  let coarseSquares = 0;
  const fineSquares = thresholdChecks.map(() => 0);
  let observed = 0;
  let outOfAllowance = 0;
  let maxDeviation = 0;
  const offsets = fine.points.map((record, i) => {
    const target = record.measured[dimension];
    const predicted = record.front[1][axis];
    const other = coarse.points[i].front[1][axis];
    const error = predicted - target;
    // First-order grid error indicator and the interval of front positions when
    // the cut moves one factor of two. This is a diagnostic bound. The published
    // workbook's decimal precision is not a statement of optical uncertainty.
    const thresholdShift = Math.max(...record.front.map((p) => Math.abs(p[axis] - predicted)));
    const frameShift = Math.abs(record.upper[1][axis] - record.lower[1][axis]);
    const allowance =
      reportedPrecision +
      frameShift +
      fine.dx * (axis === 'x' ? 1 / fine.cos : axis === 'width' ? 2 : 1) +
      Math.abs(predicted - other) +
      thresholdShift;
    coarseSquares += (other - target) ** 2;
    for (let j = 0; j < fineSquares.length; j++) fineSquares[j] += (record.front[j][axis] - target) ** 2;
    observed += target;
    outOfAllowance += Number(Math.abs(error) > allowance);
    maxDeviation = Math.max(maxDeviation, Math.abs(error));
    return {
      measuredTime: record.measuredTime,
      modelTime: record.time,
      target,
      predicted,
      coarse: other,
      error,
      allowance,
    };
  });
  const normalise = (squares) => Math.sqrt(squares / offsets.length) / (observed / offsets.length);
  const contourNrmse = fineSquares.map(normalise);
  return {
    nrmse: contourNrmse[1],
    coarseNrmse: normalise(coarseSquares),
    contourNrmse,
    maxDeviation,
    outOfAllowance,
    first: offsets[0],
    last: offsets.at(-1),
  };
}

const cases = { both: ['A', 'D'], all: ['A', 'C', 'D'] };
for (const which of cases[requested] ?? [requested]) {
  const fineSpacing = specifiedSpacing ?? (which === 'C' ? 0.002 : 0.01);
  const coarse = await simulate(which, 2 * fineSpacing);
  const fine = await simulate(which, fineSpacing);
  const edgeCounts = [coarse, fine].map(({ points }) => ({
    upstream: points.filter((p) => p.front[1].touchesUpstream).length,
    downstreamOrSide: points.filter((p) => p.front[1].touchesOuterEdge).length,
  }));
  // Dietterich et al. §Assessment of model accuracy call <10% NRMSE a good fit.
  let scores;
  if (which === 'C') {
    // Garel et al. camera radii measure the physical outline. The area-equivalent
    // radius is a deterministic estimator for a nearly axisymmetric outline.
    const radius = gradeRows(coarse, fine, 'radius', 0, 0.000005);
    const openPatch = [coarse, fine].every(({ points }) =>
      points.every(({ front }) => front.every((p) => !p.touchesUpstream && !p.touchesOuterEdge)),
    );
    const meetsPublishedErrorBar =
      openPatch &&
      radius.outOfAllowance === 0 &&
      radius.coarseNrmse < 0.1 &&
      radius.contourNrmse.every((nrmse) => nrmse < 0.1);
    if (transport === 'terminal' && throughSeconds === undefined && fineMetres === undefined)
      assert.ok(
        meetsPublishedErrorBar,
        `BM-C held-out radius misses the published error bar: ${JSON.stringify(radius)}`,
      );
    scores = { radius, meetsPublishedErrorBar };
  } else {
    // In the BM-D OpenFOAM t=0 row, the benchmark's 6 cm square has X=Y=3 cm,
    // consistent with one-sided extents from the vent centre. Compare total
    // width as a sensitivity and measure X along the sloping plane.
    const longitudinal = gradeRows(coarse, fine, 'x', 0, 0.000005);
    const crossSlopeWidth = gradeRows(coarse, fine, 'width', 1, 0.000005);
    const crossSlopeExtent = gradeRows(coarse, fine, 'crossExtent', 1, 0.000005);
    const meetsPublishedErrorBar = longitudinal.nrmse < 0.1 && edgeCounts.every((v) => v.downstreamOrSide === 0);
    scores = { longitudinal, crossSlopeWidth, crossSlopeExtent, meetsPublishedErrorBar };
  }
  console.log(
    JSON.stringify(
      {
        case: which,
        transport,
        source: data.source,
        artifact,
        observations: fine.points.length,
        spacing: [coarse.dx, fine.dx],
        cells: [coarse.cells, fine.cells],
        depthContours: thresholdChecks,
        edgeCounts,
        ...scores,
        volume: fine.storedVolume,
        suppliedVolume: fine.suppliedVolume,
        environmentalHeat: fine.environmentalHeat,
      },
      null,
      2,
    ),
  );
}
