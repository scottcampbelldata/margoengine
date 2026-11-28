// DYN-01 against a published measured experiment (docs/physics-parity-bar.md, point 2): the speed of a toppling wave down a
// row of dominoes, the classic test of contact, friction and toppling together. Measured: R. Larham, "Validation of a Model
// of the Domino Effect?", arXiv:0803.2898 (2008), appendix A table 1, dominoes standing on end, wave speed over sqrt(g H)
// against the gap over the height d / H (the less reliable end points 0.04, 0.14 and 0.82 left out, as the author marks):
//   d / H        0.23  0.33  0.43  0.53  0.62
//   V / sqrt(gH) 1.53  1.51  1.47  1.50  1.40
// One number is fitted, the friction between dominoes, to the 0.33 point (mu = 0.12); the other four are held out. The
// bound is the scatter of those five measurements about their mean, twice its standard deviation, 0.1. Every published
// measurement Larham surveys lies between 0.9 and 1.7.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const G = 9.81;

/**
 * Forty dominoes of height H (thickness 0.15 H, width 0.5 H, pine) `ratio` H apart on a floor, the first tipped; the wave's
 * speed over dominoes 10 to 35 (a domino counts as struck once it has turned 0.2 rad), over sqrt(g H).
 */
function wave(ratio, H, { solver, ...options } = {}) {
  const physics = new Physics(null, options);
  if (solver) physics.setSolver(solver);
  const T = 0.15 * H,
    gap = ratio * H,
    count = 40;
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 5], friction: 0.8 },
  });
  const dominoes = [];
  for (let i = 0; i < count; i++)
    dominoes.push(
      physics.addBody(null, {
        position: [i * (gap + T), H / 2, 0],
        colliders: {
          shape: 'box',
          halfExtents: [T / 2, H / 2, H / 4],
          friction: 0.12,
          density: 'pine',
        },
      }),
    );
  dominoes[0].applyImpulseAtPoint([0.9 * Math.sqrt(G * H) * dominoes[0].mass, 0, 0], [0, H, 0]);
  // A domino is struck when its tilt passes 0.2 rad, timed between the two steps either side of it by the tilt's straight
  // line: counted in whole steps a speed is good only to 2 percent.
  const struck = new Array(count).fill(-1),
    tilts = new Array(count).fill(0);
  for (let step = 1; step <= 1200 && struck[count - 1] < 0; step++) {
    physics.step();
    for (let i = 0; i < count; i++) {
      if (struck[i] >= 0) continue;
      const q = dominoes[i].rotation,
        tilt = 2 * Math.asin(Math.min(1, Math.hypot(q[0], q[1], q[2])));
      if (tilt > 0.2) struck[i] = (step - 1 + (0.2 - tilts[i]) / (tilt - tilts[i])) * physics.fixedTimestep;
      tilts[i] = tilt;
    }
  }
  assert.ok(struck[35] > 0, `the wave reached domino 35 at d/H ${ratio}`);
  return (25 * (gap + T)) / (struck[35] - struck[10]) / Math.sqrt(G * H);
}

test('a domino wave runs at the measured speed: one point fitted, four held out (Larham 2008)', () => {
  const measured = [
    [0.23, 1.53],
    [0.33, 1.51],
    [0.43, 1.47],
    [0.53, 1.5],
    [0.62, 1.4],
  ];
  for (const [ratio, speed] of measured) {
    const model = wave(ratio, 0.2);
    assert.ok(Math.abs(model - speed) <= 0.1, `d/H ${ratio}: ${model.toFixed(3)} against the measured ${speed}`);
  }
});

test('the high tier agrees, and dominoes of a real 48 mm height lie in the band of every published measurement', () => {
  for (const ratio of [0.33, 0.53])
    assert.ok(Math.abs(wave(ratio, 0.2, { fidelity: 'high' }) - wave(ratio, 0.2)) <= 0.1, `d/H ${ratio}`);
  // At the default 60 Hz step a 48 mm domino's fall, sqrt(H / g) = 70 ms, spans four steps where a 0.2 m one spans nine, so
  // the wave is coarser; it still lies within the measured 0.9 to 1.7.
  for (const ratio of [0.33, 0.53]) {
    const model = wave(ratio, 0.048);
    assert.ok(model >= 0.9 && model <= 1.7, `48 mm, d/H ${ratio}: ${model.toFixed(3)}`);
  }
});

// KB-PHYS-DOMINOSCALE1: the separating axis test held a face as the reference while it lost by up to 1 mm, a bias fixed in
// metres; on a domino 7 mm thick that kept the domino's own side as the normal while its edge pressed on the next one. The
// bias now follows the smaller shape below a reach of 0.2 m. Two rows the same in every dimensionless number must give one
// speed: the 0.2 m row at the defaults, and the 48 mm row with lengths, tolerances (`lengthUnit`) scaled by 0.24 and times by
// its square root, Froude similarity with g held (Buckingham's pi theorem: a speed over sqrt(g H) depends only on the
// dimensionless groups; Langhaar, "Dimensional Analysis and Theory of Models", 1951, ch. 5). Every time in the solver scales
// with the step, the contacts' stiffness too: it is a frequency, so the 48 mm row's is 120 / sqrt(0.24) Hz. Left at 120 Hz
// the 0.2 m row's contacts sat at a quarter of its substep rate and the 48 mm row's at an eighth, half as stiff over a fall,
// and the small row kept to the slower of the two speeds the large row falls into by chance (a thousandth more or less of
// the first push moves the 0.2 m row between 1.587 and 1.616; the 48 mm row stayed at 1.586). Struck times are timed between
// steps, so the bound, 0.05, is the two rows' chaotic spread, not the step's grain. Before the fix the 48 mm row ran 0.14
// and 0.18 slower at these spacings.
test('a row scaled in every dimension topples at one speed (KB-PHYS-DOMINOSCALE1)', () => {
  const scale = 0.048 / 0.2;
  for (const ratio of [0.23, 0.33]) {
    const large = wave(ratio, 0.2),
      small = wave(ratio, 0.048, {
        lengthUnit: scale,
        fixedTimestep: Math.sqrt(scale) / 60,
        solver: { contactHertz: 120 / Math.sqrt(scale) },
      });
    assert.ok(
      Math.abs(small - large) <= 0.05,
      `d/H ${ratio}: 48 mm ${small.toFixed(3)} against 0.2 m ${large.toFixed(3)}`,
    );
  }
});

test('real 48 mm dominoes, with the tolerances and step set for their size, run at the measured speed (Larham 2008)', () => {
  // lengthUnit 0.05 shrinks the tolerances to the dominoes' size (Rapier's guide sets its lengthUnit to the typical size of the
  // scene's bodies), and a 1/240 s step resolves the 70 ms fall in 17 steps. All five measurements are held out (the friction
  // was fitted at 0.2 m).
  for (const [ratio, speed] of [
    [0.23, 1.53],
    [0.33, 1.51],
    [0.43, 1.47],
    [0.53, 1.5],
    [0.62, 1.4],
  ]) {
    const model = wave(ratio, 0.048, {
      lengthUnit: 0.05,
      fixedTimestep: 1 / 240,
    });
    assert.ok(Math.abs(model - speed) <= 0.1, `48 mm, d/H ${ratio}: ${model.toFixed(3)} against the measured ${speed}`);
  }
});
