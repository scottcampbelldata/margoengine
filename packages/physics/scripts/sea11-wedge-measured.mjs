// Reproduce with node packages/physics/scripts/sea11-wedge-measured.mjs after building Physics.
// Tveitnes, Fairlie-Clarke and Varyani (2008), Ocean Engineering 35, 1463–1478.
// https://doi.org/10.1016/j.oceaneng.2008.06.012
// https://strathprints.strath.ac.uk/13792/1/OE-KSV_an_experimental_invest.pdf
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import { HullSolver } from '../dist/seakeeping.js';
import { BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../dist/world.js';

const length = 0.3;
const breadth = 0.6;
const boxHeight = 0.3;
const density = 1000;
const zeroGravity = [0, 0, 0];
const rates = [240, 480, 960];
const approachHeight = 0.02;

// Fig. 4(g, j, l), printed page 1468. Four isolated experimental x-markers nearest fixed z/d anchors
// 0.25, 0.45, 0.85 and 1.05. Center each four-piece vector mark and interpolate between the surrounding
// printed ticks in both axes. PDF SHA-256 c4881622c5cff06a9ba56cea2e3d4fc06ac31a8aeb3badeafc7bc26499cad1c0.
// These twelve rounded coordinate pairs are the only transcribed observations. They are weight-removed averaged
// load-cell forces (N), not fitted force curves, and are used only after running the fixed physical model.
// §6.1 warns that impact-face velocity was unmeasured and that measured force includes structural
// vibration. The motor speeds are inputs from Table 2. Water density is nominal fresh water.
const cases = [
  {
    figure: '4g',
    deadrise: 15,
    speed: 0.94,
    forceCeiling: 1000,
    marks: [
      [0.241, 293],
      [0.459, 648],
      [0.841, 638],
      [1.041, 211],
    ],
  },
  {
    figure: '4j',
    deadrise: 30,
    speed: 0.94,
    forceCeiling: 700,
    marks: [
      [0.25, 185],
      [0.452, 341],
      [0.845, 243],
      [1.049, 276],
    ],
  },
  {
    figure: '4l',
    deadrise: 45,
    speed: 1.19,
    forceCeiling: 700,
    marks: [
      [0.243, 193],
      [0.443, 166],
      [0.85, 354],
      [1.049, 452],
    ],
  },
];

function wedge(chine) {
  const half = breadth / 2;
  const profile = [
    [0, 0],
    [chine, half],
    [chine + boxHeight, half],
    [chine + boxHeight, -half],
    [chine, -half],
  ];
  const count = profile.length;
  const vertices = Float64Array.from([-length / 2, length / 2].flatMap((x) => profile.flatMap(([y, z]) => [x, y, z])));
  const triangles = [];
  for (let i = 1; i + 1 < count; i++) triangles.push(0, i, i + 1, count, count + i + 1, count + i);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    triangles.push(i, count + i, count + j, i, count + j, j);
  }
  return { vertices, indices: Uint32Array.from(triangles) };
}

function run(chine, speed, hz) {
  // The rig imposes translation. A zero-gravity, nearly prescribed rigid carriage suffices to collect the
  // fluid port alone, which still includes the solver's hydrostatic pressure using standard gravity.
  using physics = new Physics(null, { fixedTimestep: 1 / hz, substeps: 1, gravity: zeroGravity });
  const body = physics.addBody(null, {
    position: [0, approachHeight, 0],
    linearVelocity: [0, -speed, 0],
    enabledTranslations: [false, true, false],
    enabledRotations: [false, false, false],
    colliders: { shape: 'box', halfExtents: [length / 2, chine, breadth / 2], mass: 1e7 },
  });
  const hull = new HullSolver();
  const world = new PhysicsWorld({ rate: { num: hz, den: 1 }, gravity: zeroGravity })
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh: wedge(chine) }],
      sea: { density, elevation: () => 0 },
      level: Math.log2(hz / 60),
      addedMass: false,
      radiation: false,
      rollDamping: false,
      greenWater: false,
    })
    .couple(['hull', 'rigid'], 'staggered');

  // With one rigid substep HullSolver takes the load on the tick's initial pose. Start dry to give the
  // impact kernel its successive depth samples, and stop after all selected observations are bracketed.
  const trace = [];
  let speedError = 0;
  const steps = Math.ceil(((approachHeight + 1.2 * chine) * hz) / speed) + 1;
  for (let frame = 1; frame <= steps; frame++) {
    const depthRatio = -body.position[1] / chine;
    world.advance(frame);
    speedError = Math.max(speedError, Math.abs(body.linearVelocity[1] + speed));
    const port = hull.exportPorts(frame).find((p) => p.field === BODY_FORCES_FIELD.name);
    const force = regionWords(world.arena.memory, port.region)[body.row * FORCE_WORDS + 1];
    assert.ok(Number.isFinite(force), 'Expected a finite upward hydrodynamic force.');
    trace.push([depthRatio, force]);
  }
  assert.ok(speedError < 0.001 * speed, `Rigid carriage drifted ${speedError} m/s from the reported speed.`);
  return { trace, speedError };
}

function forceAt(trace, depthRatio) {
  const right = trace.findIndex(([z]) => z >= depthRatio);
  assert.ok(right > 0, `Expected the trace to bracket z/d=${depthRatio}.`);
  const [a, lo] = trace[right - 1];
  const [b, hi] = trace[right];
  return lo + ((hi - lo) * (depthRatio - a)) / (b - a);
}

function compare(chine, forceCeiling, marks, runs) {
  const [{ trace: coarse }, { trace: medium }, { trace: fine }] = runs;
  // §3.4 reports 1–3% of peak force across repeats for z/d <= 2. Use 3% of the figure's upper axis as a
  // conservative peak ceiling. Add 1 pt of graphics rounding on Fig. 4g's tightest force axis (~6 N).
  // Depth allowance is 1 pt on the widest z/d range (~0.035), 0.25 mm of entry tracking (§2.2.4), and the
  // paper's maximum applied nondimensional phase shift of 0.012 (§6.1). It estimates a comparison band,
  // not an instrument confidence interval or a bound on surface compliance or oscillation.
  const measurementForceAllowance = 0.03 * forceCeiling + 7;
  const measurementDepthAllowance = 0.035 + 0.00025 / chine + 0.012;
  return marks.map(([zOverD, observedN]) => {
    const low = zOverD - measurementDepthAllowance;
    const high = zOverD + measurementDepthAllowance;
    const coarseN = forceAt(coarse, zOverD);
    const mediumN = forceAt(medium, zOverD);
    const predictedN = forceAt(fine, zOverD);
    const timeRefinementN = Math.max(Math.abs(predictedN - mediumN), Math.abs(mediumN - coarseN));
    const forces = [forceAt(fine, low), forceAt(fine, high)];
    for (const [depth, force] of fine) if (depth > low && depth < high) forces.push(force);
    const allowance = measurementForceAllowance + timeRefinementN;
    const predictionBandN = [Math.min(...forces) - allowance, Math.max(...forces) + allowance];
    return {
      zOverD,
      observedN,
      predictedN,
      residualN: predictedN - observedN,
      timeRefinementN,
      predictionBandN,
      withinBand: observedN >= predictionBandN[0] && observedN <= predictionBandN[1],
    };
  });
}

await Physics.load();
for (const { figure, deadrise, speed, forceCeiling, marks } of cases) {
  const chine = (breadth / 2) * Math.tan((deadrise * Math.PI) / 180);
  const runs = rates.map((hz) => run(chine, speed, hz));
  const rows = compare(chine, forceCeiling, marks, runs);
  console.log(
    JSON.stringify({
      figure,
      deadrise,
      speed,
      rates,
      speedErrors: runs.map(({ speedError }) => speedError),
      matched: rows.filter(({ withinBand }) => withinBand).length,
      rows,
    }),
  );
}
