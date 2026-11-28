// GPULiquid's dam break against J. C. Martin and W. J. Moyce, "An experimental study of the collapse of liquid columns
// on a rigid horizontal plane", Phil. Trans. R. Soc. A 244 (1952), 312-324, read from the scanned paper's tables (each
// run's T at each Z, not only the means). Their columns collapse in a channel two-dimensionally; here a column a wide
// and n^2 a high stands against the container's wall in a tank four cells deep (free-slip side walls, so the flow is
// two-dimensional), stepped on the CPU twin in both profiles.
//
// Z = front / a against T = n t sqrt(g / a). Martin and Moyce could not time the release, so they set every run's T at
// Z = 1.44 to one value (table 1: 0.80, table 2: 1.19, table 3: 2.00); the simulation is set the same way. Nothing is
// fitted: the case of table 2 (n^2 = 2, a = 2 1/4 in) is the one the solver was first compared with, tables 1 (n^2 = 1)
// and 3 (n^2 = 4, a = 1 1/8 in) are held out.
//
// The bound at each station is the spread of their own runs at that Z (every run of every column size the table gives
// there), widened by the timing errors on both sides: the simulation's two crossings (Z = 1.44 and the station) each
// within one substep, its front (the farthest particle centre) within half a particle spacing s / 2 of the liquid's edge
// at each crossing, read at the slowest front speed in these windows (dZ / dT >= 0.7, from the tables' means), their two
// film readings within half a frame of their 300 frames per second (section 3), and their two-decimal rounding.
//
// The windows end where the tables' runs end (table 3) or where the tongue has thinned to a few millimetres (Z = 9 in
// tables 1 and 2): past that the experiments' fronts slow under bed and side-wall friction, which the free-slip walls
// here leave out, and the simulated fronts run ahead (docs/limits.md gives the numbers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIQUID_PARTICLE_FLOATS as F, createLiquidState, resolveLiquidParams, stepLiquidCPU } from '../dist/liquid.js';

const G = 9.81;
const INCH = 0.0254;

// Each case: column width a, n^2, the normalisation T at Z = 1.44, and per station Z every run's T.
const cases = [
  {
    table: 'table 2, n^2 = 2 (a = 2 1/4 in, and 1 1/8 in at Z = 4.11 and 5)',
    a: 2.25 * INCH,
    n2: 2,
    norm: 1.19,
    runs: {
      2.11: [1.75, 1.78, 1.85, 1.84, 1.88, 1.82, 1.87, 1.87, 1.77],
      3.0: [2.38, 2.4, 2.47, 2.55, 2.57, 2.6, 2.63, 2.66, 2.5],
      4.11: [3.13, 3.21, 3.38, 3.37, 3.46, 3.41, 3.35, 3.25, 3.28, 3.25],
      5.0: [4.09, 4.06, 3.9, 3.89, 3.95, 3.92],
      7.0: [5.16, 5.11, 5.01],
      9.0: [6.31, 6.25, 6.34],
    },
  },
  {
    table: 'table 1, n^2 = 1 (a = 2 1/4 in and 4 1/2 in), held out',
    a: 2.25 * INCH,
    n2: 1,
    norm: 0.8,
    runs: {
      1.89: [1.1, 1.12, 1.13, 1.12, 1.15, 1.14, 1.13, 1.19, 1.17, 1.17, 1.14, 1.17, 1.2, 1.19, 1.18],
      2.56: [1.57, 1.58, 1.57, 1.6, 1.64, 1.61, 1.6, 1.66, 1.61, 1.65, 1.61, 1.69, 1.65, 1.65, 1.69],
      3.0: [1.88, 1.88, 1.97, 1.95, 1.96, 1.9, 1.97, 1.9, 1.96, 1.96, 1.95, 1.91, 1.92, 1.98],
      3.89: [2.54, 2.56, 2.6, 2.5, 2.57, 2.47, 2.54, 2.47, 2.58, 2.32, 2.41, 2.42],
      5.0: [3.28, 3.34, 3.29, 3.37, 3.04, 3.07, 3.17],
      6.0: [3.96, 3.86, 3.9, 3.89, 3.58, 3.62, 3.8],
      7.0: [4.45, 4.45, 4.5, 4.57, 4.19, 4.27, 4.4],
      8.0: [5.11, 5.11, 5.24, 5.24, 4.79, 4.95, 4.98],
      9.0: [5.83, 5.78, 6.03, 6.02, 5.44, 5.82, 5.56],
    },
  },
  {
    table: 'table 3, n^2 = 4 (a = 1 1/8 in), held out',
    a: 1.125 * INCH,
    n2: 4,
    norm: 2.0,
    runs: {
      1.89: [2.58, 2.62, 2.48, 2.52, 2.68, 2.74, 2.78, 2.44, 2.74, 2.7, 2.6],
      2.78: [3.52, 3.6, 3.56, 3.52, 3.76, 3.78, 3.78, 3.38, 3.82, 3.7, 3.66],
      3.67: [4.44, 4.4, 4.52, 4.38, 4.5, 4.36, 4.52, 4.34, 4.56, 4.6, 4.6],
      4.56: [5.34, 5.22, 5.44, 5.18, 5.24, 5.14, 5.32, 5.18, 5.44, 5.4, 5.48],
      5.44: [6.22, 6.18, 6.38, 6.0, 6.0, 5.82, 6.06, 5.96, 6.16, 6.16, 6.34],
      6.33: [6.96, 7.0, 7.22, 6.74, 6.68, 6.56, 6.88, 6.7, 6.9, 6.92, 7.12],
      7.22: [7.92, 7.52, 7.38, 7.14, 7.58, 7.44, 7.6, 7.6, 7.78],
      7.67: [8.22, 7.82, 7.44, 7.96, 7.78, 7.86, 7.92, 8.16],
    },
  },
];

/** Runs one case; returns the simulated T at each station and the bound's timing part. */
function collapse({ a, n2, norm, runs }, profile) {
  const perA = 8;
  const h = a / perA;
  const stations = Object.keys(runs).map(Number);
  const far = Math.max(...stations) + 1;
  const length = far * a,
    height = Math.max(n2 + 0.5, 2.5) * a,
    depth = 4 * h;
  const p = resolveLiquidParams({
    count: perA * perA * n2 * 4 * 8,
    box: { min: [0, 0, 0], max: [length, height, depth] },
    fill: { min: [0, 0, 0], max: [a, n2 * a, depth] },
    resolution: Math.round(length / h),
    viscosity: 1e-6,
    profile,
  });
  const s = createLiquidState(p);
  const k = Math.sqrt(n2) * Math.sqrt(G / a);
  const dt = p.maxSubstep;
  const marks = [1.44, ...stations];
  const crossed = new Map();
  let previous = 1,
    t = 0;
  while (crossed.size < marks.length && t < 2) {
    stepLiquidCPU(s, p, dt);
    t += dt;
    let front = 0;
    for (let i = 0; i < s.live; i++) front = Math.max(front, s.particles[i * F]);
    const Z = front / a;
    for (const m of marks)
      if (!crossed.has(m) && Z >= m) crossed.set(m, k * (t - dt + (dt * (m - previous)) / Math.max(Z - previous, 1e-12)));
    previous = Z;
  }
  assert.equal(crossed.size, marks.length, `${profile}: the front reaches Z = ${far - 1}`);
  const offset = crossed.get(1.44) - norm;
  const timing = 2 * k * dt + (2 * (p.lattice[0] / 2 / a)) / 0.7 + k / 300 + 0.01;
  return { T: stations.map((Z) => crossed.get(Z) - offset), stations, timing };
}

for (const profile of ['accurate', 'fast'])
  for (const c of cases)
    test(`${profile} profile: Martin and Moyce's ${c.table}, every station inside their runs' spread`, { timeout: 600000 }, () => {
      const { T, stations, timing } = collapse(c, profile);
      stations.forEach((Z, i) => {
        const lo = Math.min(...c.runs[Z]) - timing,
          hi = Math.max(...c.runs[Z]) + timing;
        assert.ok(T[i] >= lo && T[i] <= hi, `Z = ${Z}: T ${T[i].toFixed(3)} outside ${lo.toFixed(3)} to ${hi.toFixed(3)}`);
      });
    });

// The three-dimensional tank of L. Lobovsky, E. Botia-Vera, F. Castellana, J. Mas-Soler and A. Souto-Iglesias,
// "Experimental investigation of dynamic pressure loads during dam break", J. Fluids Struct. 48 (2014), 407-434
// (arXiv:1308.0115): 1.61 m long and 0.15 m wide, water H deep behind a gate 0.6 m from its end, the gate gone at once
// here. The front's mean speed along the dry bed after t* = t sqrt(g / H) = 1, fitted by least squares to the
// farthest particle within 5 cm of the bed until it nears the far wall, in units of sqrt(g H). Their Table 1 gathers
// it from the measured dam breaks: 1.56 and 1.34 at their own H = 300 and 600 mm, 1.14 to 1.74 across all of them
// (Martin and Moyce, Dressler, Hu, Koshizuka), whose spread with gate, bed and scale is the bound. H = 600 mm is held
// out (its coarser cells, 4 cm, keep the run short).
for (const [H, cell] of [
  [0.3, 0.03],
  [0.6, 0.04],
])
  test(`accurate profile: Lobovsky et al.'s ${H * 1000} mm dam break, the front's speed inside the measured ones`, { timeout: 600000 }, () => {
    const length = 1.61,
      width = 0.15,
      top = H > 0.4 ? 1.2 : 0.6;
    const blocks = [Math.round(0.6 / cell), Math.round(H / cell), Math.round(width / cell)];
    const p = resolveLiquidParams({
      count: blocks[0] * blocks[1] * blocks[2] * 8,
      box: { min: [0, 0, 0], max: [length, top, width] },
      fill: { min: [0, 0, 0], max: [0.6, H, width] },
      resolution: Math.round(Math.max(length, top) / cell),
      viscosity: 1e-6,
      profile: 'accurate',
    });
    const s = createLiquidState(p);
    const run = [];
    for (let t = 1 / 240; t < 3 * Math.sqrt(H / G); t += 1 / 240) {
      stepLiquidCPU(s, p, 1 / 240);
      let x = 0;
      for (let i = 0; i < s.live; i++) if (s.particles[i * F + 1] < 0.05) x = Math.max(x, s.particles[i * F]);
      if (t * Math.sqrt(G / H) >= 1 && x < length - 0.05) run.push([t, x]);
    }
    const n = run.length,
      mt = run.reduce((a, r) => a + r[0], 0) / n,
      mx = run.reduce((a, r) => a + r[1], 0) / n;
    const speed =
      run.reduce((a, r) => a + (r[0] - mt) * (r[1] - mx), 0) / run.reduce((a, r) => a + (r[0] - mt) ** 2, 0) / Math.sqrt(G * H);
    assert.ok(n > 10, 'the front crosses the bed');
    assert.ok(speed >= 1.14 && speed <= 1.74, `front ${speed.toFixed(3)} sqrt(g H) against 1.14 to 1.74`);
    assert.equal(s.live, p.count, 'the water is all kept');
  });
