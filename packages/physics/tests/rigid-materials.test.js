// DYN-01 and DYN-06 against measured material pairs (docs/physics-parity-bar.md, point 2): restitution and friction go in as
// measured by their own experiments, and what is checked is what neither number says on its own, the oblique bounce. Source:
// R. Cross, "Measurements of the horizontal coefficient of restitution for a superball and a tennis ball", American Journal of
// Physics 70(5), 482-489 (2002), https://doi.org/10.1119/1.1450571. A 57 g tennis ball (R 33.0 mm, shell radius R1 30 mm, so
// I = 2 m R1^2 / 3, alpha = I / m R^2 = 0.551) dropped with no spin onto three surfaces tilted to meet it at 20 or 45 degrees:
//   - the inputs, each from a separate experiment: restitution 0.77 +- 0.01 from vertical drops of 0.3 to 1 m, the same on all
//     three surfaces; sliding friction from four balls held in a weighted box and dragged, 0.23 +- 0.02 on polished timber,
//     0.60 +- 0.03 on Rebound Ace (the Australian Open's court) and 0.67 +- 0.03 on fine emery paper;
//   - the outputs, Table II (h = 60 cm), each bounce's horizontal speed kept, vx2 / vx1, its rebound angle to the surface,
//     and the time-average friction F dt / N dt (mu_A), and Table I (emery, 20 degrees, 2.24 m/s).
// Nothing is fitted: all seven bounces are held out. A rigid ball under Coulomb friction (Brody 1984; Cross's eqs. 11 to 15)
// either slides through the whole bounce, losing mu (1 + e) vy1 along the surface, or grips once its contact point stops and
// leaves rolling with vx2 = vx1 / (1 + alpha), 0.645 vx1, whatever the friction. Wood at 20 degrees slides; the other five
// grip. What a rigid ball does not do, Cross measured too: a real ball stores some energy in shear and comes off spinning 17
// to 41 percent faster than rolling, steeper by up to 3.7 degrees on emery at 20 (docs/limits.md, "Oblique bounce").
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const m = 0.057,
  R = 0.033,
  R1 = 0.03,
  I = (2 / 3) * m * R1 * R1,
  alpha = I / (m * R * R),
  e = 0.77,
  degrees = Math.PI / 180;
const friction = { wood: 0.23, reboundAce: 0.6, emery: 0.67 };
// Table II: surface, incidence above the surface, v1, vx2 / vx1, rebound angle, mu_A.
const tableII = [
  ['wood', 20, 3.72, 0.84, 19.2, 0.25],
  ['wood', 45, 3.8, 0.6, 50.4, 0.23],
  ['emery', 20, 3.53, 0.6, 27.2, 0.59],
  ['emery', 45, 3.7, 0.63, 51.3, 0.2],
  ['reboundAce', 20, 3.35, 0.62, 23.4, 0.6],
  ['reboundAce', 45, 3.6, 0.68, 49.3, 0.18],
];

/**
 * The ball meeting a fixed floor of `surface` at `angle` degrees and `speed` m/s with no spin, in no gravity so the reading
 * is the bounce alone (the measured speeds are those just before and after it). Returns its velocity and spin just after.
 */
function bounce(surface, angle, speed, fidelity) {
  const physics = new Physics(null, { gravity: [0, 0, 0], fidelity }),
    mu = friction[surface];
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 5], friction: mu, restitution: e },
  });
  const ball = physics.addBody(null, {
    position: [0, R + 0.002, 0],
    colliders: { shape: 'sphere', radius: R, friction: mu, restitution: e },
  });
  ball.setMassProperties({ mass: m, inertia: [I, I, I] });
  const t = angle * degrees,
    vx1 = speed * Math.cos(t),
    vy1 = speed * Math.sin(t);
  ball.setLinearVelocity([vx1, -vy1, 0]);
  for (let i = 0; i < 60 && !(ball.linearVelocity[1] > 0 && ball.position[1] > R + 0.004); i++) physics.step();
  const [vx2, vy2] = ball.linearVelocity;
  return { vx1, vy1, vx2, vy2, spin: -ball.angularVelocity[2] * R, mu };
}

/** Cross's rigid ball (eqs. 11 to 15): vx2 and R omega2 after a bounce with no incoming spin. */
function rigid(vx1, vy1, mu) {
  const slide = mu * (1 + e) * vy1,
    grip = vx1 * (alpha / (1 + alpha));
  if (slide < grip) return { vx2: vx1 - slide, spin: slide / alpha };
  return { vx2: vx1 / (1 + alpha), spin: vx1 / (1 + alpha) };
}

for (const fidelity of ['standard', 'high']) {
  test(`${fidelity}: an oblique bounce is the rigid ball's exact solution, sliding through it or gripping (Brody 1984)`, () => {
    // Regression: friction was held to the cone of the normal impulse before the bounce, mu vy1 where Coulomb's law gives
    // mu (1 + e) vy1, so wood at 20 degrees kept 0.92 of vx1 and every bounce slid. One substep's gravity is the only other
    // term, and there is none here: the bound is a thousandth of the speed, f32 rounding through the solver's passes.
    for (const [surface, angle, speed] of [...tableII, ['emery', 20, 2.24]]) {
      const got = bounce(surface, angle, speed, fidelity),
        want = rigid(got.vx1, got.vy1, got.mu),
        bound = 1e-3 * speed;
      assert.ok(Math.abs(got.vx2 - want.vx2) <= bound, `${surface} ${angle}: vx2 ${got.vx2} against ${want.vx2}`);
      assert.ok(
        Math.abs(got.spin - want.spin) <= bound,
        `${surface} ${angle}: R omega2 ${got.spin} against ${want.spin}`,
      );
      assert.ok(Math.abs(got.vy2 - e * got.vy1) <= bound, `${surface} ${angle}: vy2 ${got.vy2} against ${e * got.vy1}`);
    }
  });
}

test("a tennis ball bounced on wood, Rebound Ace and emery matches Cross's measurements (2002), nothing fitted", () => {
  // Bounds, from the paper's stated errors: speeds along the surface to 2 percent, so a ratio of two to 4 percent; mu_A to
  // +- 0.05 (Table I); angles to +- 1.5 degrees (Table I). A gripping ball's vx2 / vx1 does not depend on the friction or the
  // bounce, so the five gripping bounces are held to their own scatter as well: twice the standard deviation of the five
  // measured ratios about their mean, 0.066, the convention of the domino test (tests/rigid-measured.test.js).
  const gripped = tableII.filter(([surface, angle]) => !(surface === 'wood' && angle === 20)).map((row) => row[3]),
    mean = gripped.reduce((sum, value) => sum + value, 0) / gripped.length,
    spread = 2 * Math.sqrt(gripped.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (gripped.length - 1));
  for (const [surface, angle, speed, ratio, rebound, average] of tableII) {
    const got = bounce(surface, angle, speed),
      kept = got.vx2 / got.vx1,
      muA = (got.vx1 - got.vx2) / ((1 + e) * got.vy1),
      slid = got.spin < got.vx2 - 1e-3 * speed;
    assert.equal(slid, surface === 'wood' && angle === 20, `${surface} ${angle}: slid ${slid}`);
    assert.ok(Math.abs(muA - average) <= 0.05, `${surface} ${angle}: mu_A ${muA.toFixed(3)} against ${average}`);
    if (slid) {
      // The friction's own error moves the sliding ratio by (1 + e) tan(theta1) d mu = 0.013 on top of the 4 percent.
      const bound = 0.04 * ratio + (1 + e) * Math.tan(angle * degrees) * 0.02;
      assert.ok(Math.abs(kept - ratio) <= bound, `${surface} ${angle}: vx2/vx1 ${kept.toFixed(3)} against ${ratio}`);
    } else
      assert.ok(
        Math.abs(kept - ratio) <= spread,
        `${surface} ${angle}: vx2/vx1 ${kept.toFixed(3)} against ${ratio} (bound ${spread.toFixed(3)})`,
      );
    // At 45 degrees the angle is the rolling ball's, tan(theta2) = e (1 + alpha) tan(theta1), on every surface.
    if (angle === 45) {
      const angleOut = Math.atan2(got.vy2, got.vx2) / degrees;
      assert.ok(
        Math.abs(angleOut - rebound) <= 1.5,
        `${surface} ${angle}: rebound ${angleOut.toFixed(2)} against ${rebound}`,
      );
    }
  }
});
