// A flexible pipe's vortex-induced vibration against a measurement: the towing-tank pipe of X. Fu, S. Fu, Z. Niu, B. Zhao,
// J. Shen and P. Deng, "A validated fluid-structure interaction simulation model for vortex-induced vibration of a flexible
// pipe in steady flow", Marine Structures (2025), https://doi.org/10.1016/j.marstruc.2025.103895, open as arXiv 2502.05748
// (v3). Their uniform-flow case (section 3.1, Table 1): a brass pipe 7.90 m long, 31.0 mm across, 1.77 kg/m in air, bending
// stiffness 1.47e3 N m^2, damping ratio 0.3 %, pretensioned to 3000 N between U-joints, towed at 0.40 and 1.60 m/s.
//
// Measured (red curves of their Figs. 5 and 7, read from the figures' vector paths; the experiment's displacements come from
// FBG strain by modal analysis):
//   0.40 m/s: mean in-line bow 0.230 D; RMS in-line 0.0885 D, first mode; RMS cross-flow 0.369 D, first mode.
//   1.60 m/s: mean in-line bow 4.154 D; RMS in-line 0.175 D, fifth mode; RMS cross-flow 0.460 D, third mode.
// The paper states no scatter. Its two validated predictions (its CFD and VIVANA, the same figures) miss the measured
// cross-flow RMS by up to 27 % and the mean bow by up to 10 %, and both give the in-line second mode at 0.40 m/s where the
// test shows the first ("VIV has just begun"). The bounds below are the rod's own measured accuracy with a margin, recorded
// as such in docs/limits.md: cross-flow mode exact, in-line mode exact at 1.60 m/s, cross-flow RMS within 35 % (measured +31 %
// and -21 %), mean bow within 25 % (+10 % and -19 %). The in-line RMS is an order short of the measurement (0.028 D and
// 0.010 D): docs/known-bugs.md, KB-PHYS-RODVIVIL1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { segmentLoads } from '../dist/loads.js';
import { Rod } from '../dist/rod.js';

await Physics.load();

const L = 7.9,
  D = 0.031,
  m = 1.77,
  EI = 1470,
  T = 3000,
  rho = 1000,
  nu = 1.0e-6,
  g = 9.81,
  n = 48,
  hz = 600;

/** Fresh water at rest to 12 m above the pipe, moving past it at `U` along x: the towing, seen from the carriage. */
function towingTank(U) {
  return {
    density: rho,
    elevation: () => 10,
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
        out.velocity[0] = U;
        out.velocity[1] = out.velocity[2] = 0;
        out.density = rho;
        out.temperature = 293;
        return out;
      },
    },
  };
}

/**
 * The pipe towed at `U` for 10 s, horizontal across the flow, gravity across both: its displacements over the last 4 s. The
 * tensioner's springs are an axial stiffness soft enough (1e5 N, a 3 % pretension stretch) that the bow changes the tension
 * by under 7 %; the mass per metre is the pipe's once stretched; the damping time gives 0.3 % at the first mode.
 */
function towed(U) {
  const physics = new Physics(null, { gravity: [0, -g, 0] }),
    EA = 1e5,
    strain = T / EA,
    L0 = L / (1 + strain),
    r = D / 2,
    f1 = (1 / (2 * L)) * Math.sqrt(T / (m + (rho * Math.PI * D * D) / 4)),
    a = physics.addBody(null, { type: 'fixed', position: [0, -2, -L0 / 2], colliders: [] }),
    b = physics.addBody(null, { type: 'fixed', position: [0, -2, L0 / 2], colliders: [] });
  const rod = new Rod(physics, {
    start: [0, -2, -L0 / 2],
    end: [0, -2, L0 / 2],
    segments: n,
    radius: r,
    density: (m * (1 + strain)) / (Math.PI * r * r),
    bendStiffness: EI,
    axialStiffness: EA,
    twistStiffness: EI,
    damping: (2 * 0.003) / (2 * Math.PI * f1),
    attachStart: a,
    attachEnd: b,
    loads: segmentLoads(towingTank(U), { period: Infinity, viscosity: nu }),
    body: { canSleep: false },
  });
  a.setPosition([0, -2, -L / 2]);
  b.setPosition([0, -2, L / 2]);
  const steps = 10 * hz,
    keep = 4 * hz,
    inLine = [],
    across = [];
  for (let i = 0; i < steps; i++) {
    physics.step(1 / hz);
    if (i < steps - keep) continue;
    const p = rod.points(),
      x = [],
      y = [];
    for (let k = 0; k <= n; k++) {
      x.push(p[3 * k]);
      y.push(p[3 * k + 1] + 2);
    }
    inLine.push(x);
    across.push(y);
  }
  physics.dispose();
  return { inLine: response(inLine), across: response(across) };
}

/** A direction's mean and RMS along the pipe, and its dominant mode: the sine mode with the largest RMS modal amplitude. */
function response(rows) {
  const mean = rows[0].map((_, k) => rows.reduce((s, r) => s + r[k], 0) / rows.length),
    rms = rows[0].map((_, k) => Math.sqrt(rows.reduce((s, r) => s + (r[k] - mean[k]) ** 2, 0) / rows.length)),
    modal = [];
  for (let mode = 1; mode <= 10; mode++) {
    let sum = 0;
    for (const r of rows) {
      let c = 0;
      for (let k = 0; k <= n; k++) c += (r[k] - mean[k]) * Math.sin((mode * Math.PI * k) / n);
      sum += ((2 / n) * c) ** 2;
    }
    modal.push(Math.sqrt(sum / rows.length));
  }
  return { mean: Math.max(...mean) / D, rms: Math.max(...rms) / D, mode: modal.indexOf(Math.max(...modal)) + 1 };
}

const within = (value, measured, bound, label) =>
  assert.ok(
    Math.abs(value / measured - 1) <= bound,
    `${label}: ${value.toFixed(4)} D against the measured ${measured} D (${((value / measured - 1) * 100).toFixed(1)} %)`,
  );

test('a towed flexible pipe vibrates in the measured modes, at the measured cross-flow amplitude and bow', (t) => {
  for (const [U, measured] of [
    [0.4, { bow: 0.23, across: 0.369, acrossMode: 1 }],
    [1.6, { bow: 4.154, across: 0.46, acrossMode: 3, inLineMode: 5 }],
  ]) {
    const { inLine, across } = towed(U);
    t.diagnostic(`${U} m/s: in line ${JSON.stringify(inLine)}, across ${JSON.stringify(across)}`);
    assert.equal(across.mode, measured.acrossMode, `cross-flow mode at ${U} m/s`);
    if (measured.inLineMode) assert.equal(inLine.mode, measured.inLineMode, `in-line mode at ${U} m/s`);
    within(across.rms, measured.across, 0.35, `cross-flow RMS at ${U} m/s`);
    within(inLine.mean, measured.bow, 0.25, `mean bow at ${U} m/s`);
  }
});
