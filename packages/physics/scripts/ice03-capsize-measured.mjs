// Burton et al. (2012), Laboratory investigations of iceberg capsize dynamics, energy dissipation and
// tsunamigenesis, https://doi.org/10.1029/2011JF002055, §2.1 and Fig. 5. The WHOI copy preserves the individual
// vector markers: https://website.whoi.edu/gfd/wp-content/uploads/sites/14/2018/10/Burton2012_146467.pdf
// The published run uses sparse factual marker readouts. The exact MacAyeal NetCDF
// (https://doi.org/10.7265/N56H4FCJ, CC BY-NC 4.0) requires CAPTCHA on its download site.
//
// Heller et al. (2019), Large-scale experiments into the tsunamigenic potential of different iceberg
// calving mechanisms, https://doi.org/10.1038/s41598-018-36634-3. Processed measured motion from the
// authors' https://www.spheric-sph.org/tests/test-15, capsizing (not hinged overturning), Tables 1 and 3.
// Download SPHERIC_TestCase15.zip, extract post_processed_t1c_motion_capsizing_block2_100cm_-73.9cm.txt,
// and pass the path as the optional argument for the separate guided-motion comparison. Data stay external.
// Run node scripts/run-with-timeout.mjs --max=2 -- node packages/physics/scripts/ice03-capsize-measured.mjs [motion.txt]

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { IcebergSolver } from '../dist/iceberg.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const hz = 60;
const rad = Math.PI / 180;
const degrees = (radians) => radians / rad;
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

async function trajectory(setup, duration, timeRefinement = 1) {
  // Gravity/inertia and quadratic panel drag have the same Froude similarity. Scale all lengths by
  // k², linear speeds by k and body angular velocity by 1/k to run k times as many ticks for the
  // same laboratory time. Map the resulting state back to the original lengths, time and speeds.
  // Keep still fluids, zero melt and fixed densities and drag. No wave feedback or wall model is active.
  const lengthScale = timeRefinement ** 2;
  const berg = await IcebergSolver.load();
  const world = new PhysicsWorld({ rate: { num: hz, den: 1 }, gravity: [0, -9.81, 0], memory: worldMemory(false) });
  world.add(berg, {
    iceDensity: setup.iceDensity,
    waterDensity: setup.waterDensity ?? 997,
    bodies: [
      {
        size: setup.size.map((length) => length * lengthScale),
        position: [setup.x * lengthScale, setup.y * lengthScale, 0],
        orientation: [0, 0, Math.sin(setup.angle / 2), Math.cos(setup.angle / 2)],
        velocity: [setup.vx * timeRefinement, setup.vy * timeRefinement, 0],
        spin: [0, 0, setup.spin / timeRefinement],
      },
    ],
  });
  const rows = [];
  for (let frame = 0; frame <= Math.ceil(duration * hz * timeRefinement); frame++) {
    world.advance(frame);
    const { orientation, position, spin, velocity } = berg.sample(0);
    rows.push({
      t: frame / (hz * timeRefinement),
      angle: 2 * Math.atan2(orientation[2], orientation[3]),
      x: position[0] / lengthScale,
      y: position[1] / lengthScale,
      vx: velocity[0] / timeRefinement,
      vy: velocity[1] / timeRefinement,
      spin: spin[2] * timeRefinement,
    });
  }
  return rows;
}

function crossing(rows, angleDegrees) {
  const threshold = angleDegrees * rad;
  const right = rows.findIndex(({ angle }) => angle >= threshold);
  assert.ok(right > 0, `The modeled block must cross ${angleDegrees} degrees.`);
  const a = rows[right - 1];
  const b = rows[right];
  return a.t + ((b.t - a.t) * (threshold - a.angle)) / (b.angle - a.angle);
}

function interpolate(rows, time, key) {
  const right = rows.findIndex(({ t }) => t >= time);
  assert.ok(right > 0, `Missing observed clock position ${time} s.`);
  const a = rows[right - 1];
  const b = rows[right];
  return a[key] + ((b[key] - a[key]) * (time - a.t)) / (b.t - a.t);
}

function burtonScore(rows) {
  const t10 = crossing(rows, 10);
  const t45 = crossing(rows, 45);
  const t80 = crossing(rows, 80);
  const t90 = crossing(rows, 90);
  const peak = Math.max(...rows.filter(({ t }) => t >= t90 && t <= t90 + 0.35).map(({ angle }) => degrees(angle)));
  const marker = (t) => ({
    timeAfter90S: t,
    xCm: 100 * interpolate(rows, t90 + t, 'x'),
    yCm: 100 * interpolate(rows, t90 + t, 'y'),
  });
  return {
    intervalsS: [t45 - t10, t80 - t45, t90 - t10],
    peakAfter90Deg: peak,
    translation: [0.2, 0.7, 1, 2].map(marker),
  };
}

// Measured pose at nominal t = −1.20 s relative to the paper's near-90° time origin. Use only t ≤ −1.20
// to seed rate: the t = −1.30 marker gives 4.304°, x = −0.2081 cm and y = −4.3845 cm.
const burton = {
  size: [0.0515, 0.103, 0.267],
  iceDensity: 920,
  angle: 5.701 * rad,
  x: -0.002366,
  y: -0.043657,
  vx: -0.00285,
  vy: 0.00188,
  spin: ((5.701 - 4.304) * rad) / 0.1,
};
// Approximate 1° camera allowance (two pixels at 16 px/cm across 10.3 cm). Interpolate 9–11, 44–46,
// 79–81 and 89–91 degree marker crossings, then add one 1/30 s camera interval in each direction.
const burtonMeasured = {
  intervalsS: [0.62027, 0.27791, 0.99758],
  intervalsAllowanceS: [0.1, 0.06, 0.1],
  peakAfter90Deg: 96.07,
  peakAllowanceDeg: 1,
  positionAllowanceCm: 0.13,
  // Interpolate the nearest 30 fps vector markers after the reconstructed first 90° crossing.
  translation: [
    { timeAfter90S: 0.2, xCm: -1.18, yCm: -2.28 },
    { timeAfter90S: 0.7, xCm: -1.72, yCm: -2.32 },
    { timeAfter90S: 1, xCm: -2.01, yCm: -2.39 },
    { timeAfter90S: 2, xCm: -2.87, yCm: -2.38 },
  ],
};
const base = burtonScore(await trajectory(burton, 5));
const refined = burtonScore(await trajectory(burton, 5, 2));
const perturbations = [];
for (const direction of [-1, 1]) {
  // Independent initial-state sensitivity: ±1° and a 14°/s rate scale from two readings over 0.1 s.
  const setup = { ...burton, angle: burton.angle + direction * rad, spin: burton.spin + direction * 14 * rad };
  perturbations.push(burtonScore(await trajectory(setup, 5)));
}
const positionRmsCm = ['xCm', 'yCm'].map((key) =>
  Math.sqrt(mean(refined.translation.map((row, i) => (row[key] - burtonMeasured.translation[i][key]) ** 2))),
);
console.log(
  JSON.stringify({
    experiment: 'Burton Fig. 5, free capsize, aspect 0.5',
    burtonMeasured,
    base,
    refined,
    perturbations,
    positionRmsCm,
  }),
);

const motionFile = process.argv[2];
if (motionFile) {
  const bytes = await readFile(motionFile);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '94b82ad2533c04f26253a51ebca143673ee78f6dada7ef3907db96f306102b2f',
    'Use the exact extracted SPHERIC test 15 capsizing motion file.',
  );
  const samples = bytes
    .toString()
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((row) => row.trim().split(/\s+/).map(Number));
  const [t0, vr0, vz0, r0] = samples[0];
  assert.equal(t0, 0);
  const sensor = 0.403;
  const angle = Math.asin(r0 / sensor);
  const spin = vr0 / (sensor * Math.cos(angle));
  // Measured guide leaves roll and heave free, and restricts surge. The engine's block has no such
  // guide. Use roll, heave and surge from its free motion when predicting the same sensor position.
  // Use measured rod+block mass, assigning 92.43 kg to the uniform 0.1 m³ cuboid in the model.
  const setup = {
    size: [0.25, 0.8, 0.5],
    iceDensity: 924.3,
    waterDensity: 1000, // nominal basin freshwater, distinct from Burton's measured tap-water value
    x: 0,
    y: -0.339,
    vx: 0,
    vy: vz0 + vr0 * Math.tan(angle),
    angle,
    spin,
  };
  const peak = (rows) => rows.reduce((a, b) => (b.speed > a.speed ? b : a));
  const measured = peak(samples.filter(([t]) => t < 4).map(([t, vr, vz]) => ({ t, speed: Math.hypot(vr, vz) })));
  const predicted = [];
  for (const refinement of [1, 2]) {
    const rows = await trajectory(setup, 4, refinement);
    predicted.push(
      peak(
        rows.map(({ t, angle, spin, vx, vy }) => ({
          t,
          speed: Math.hypot(vx - sensor * Math.cos(angle) * spin, vy - sensor * Math.sin(angle) * spin),
        })),
      ),
    );
  }
  console.log(
    JSON.stringify({
      experiment: 'Heller and Chen SPHERIC 15, free model against surge-guided lab capsize',
      measured,
      publishedSpeedAllowanceMps: 0.05,
      predicted,
    }),
  );
}
