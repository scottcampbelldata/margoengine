// DYN-01 and DYN-06 against exact solutions (docs/physics-parity-bar.md, point 2): a dropped ball's rebound height,
// sliding and sticking on an incline, a ball rolling without slipping (which checks the solver's inertia), Newton's
// cradle and a tower of boxes. Each bound is derived in its test from the step, never fitted. The world runs at its
// defaults: 60 steps a second, each of the tier's substeps (8 standard, 32 high; an island may take more).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const G = 9.81;

// Both solver tiers (PhysicsOptions.fidelity) are held to the same exact solutions and bounds.
for (const fidelity of ['standard', 'high']) {
  const floor = (physics, options = {}) =>
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50], ...options },
    });

  test(`${fidelity}: a ball dropped from 2 m rebounds to e² times the height (Newton's law of restitution)`, () => {
    for (const e of [0.3, 0.6, 0.9]) {
      const physics = new Physics(null, { fidelity });
      floor(physics, { restitution: e });
      const r = 0.1,
        drop = 2,
        ball = physics.addBody(null, { position: [0, drop + r, 0], colliders: { shape: 'sphere', radius: r, restitution: e } });
      let fell = false,
        rose = false,
        peak = 0;
      for (let i = 0; i < 600; i++) {
        physics.step();
        const v = ball.linearVelocity[1];
        if (v < -0.1) fell = true;
        if (fell && v > 0) rose = true;
        if (rose) {
          peak = Math.max(peak, ball.position[1] - r);
          if (v < 0) break;
        }
      }
      // The bounce speed e sqrt(2 g h0) is right to within one substep of gravity, g h with h = 1 / (60 substeps), so the height v^2 / 2g is right to
      // within v g h / g = v h; sampling the peak at steps adds at most g dt^2 / 8.
      const v = e * Math.sqrt(2 * G * drop),
        bound = v / (60 * physics.substeps) + G / 3600 / 8;
      assert.ok(Math.abs(peak - e * e * drop) <= bound, `e ${e}: rebound ${peak} against ${e * e * drop} (bound ${bound})`);
    }
  });

  /** A slope of `degrees` about z, rising toward -x, and a body resting on it. */
  function slope(degrees, friction, collider) {
    const physics = new Physics(null, { fidelity }),
      t = (degrees * Math.PI) / 180,
      rotation = [0, 0, Math.sin(t / 2), Math.cos(t / 2)],
      up = [-Math.sin(t), Math.cos(t), 0];
    physics.addBody(null, { type: 'fixed', rotation, colliders: { shape: 'box', halfExtents: [50, 0.5, 5], friction } });
    const lift = 0.5 + (collider.radius ?? collider.halfExtents[1]);
    const body = physics.addBody(null, {
      position: [up[0] * lift, up[1] * lift, 0],
      rotation,
      colliders: { ...collider, friction },
    });
    return { physics, body, t };
  }
  /** The body's speed gained over one second after half a second to settle. */
  function acceleration(physics, body) {
    for (let i = 0; i < 30; i++) physics.step();
    const a = body.linearVelocity;
    for (let i = 0; i < 60; i++) physics.step();
    const b = body.linearVelocity;
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }

  test(`${fidelity}: a block slides down an incline at g (sin t - mu cos t), and holds where tan t is under mu (Coulomb)`, () => {
    for (const [degrees, mu] of [
      [30, 0.3],
      [45, 0.5],
      [20, 0.1],
    ]) {
      const { physics, body, t } = slope(degrees, mu, { shape: 'box', halfExtents: [0.25, 0.25, 0.25] }),
        exact = G * (Math.sin(t) - mu * Math.cos(t));
      // Constant acceleration: the steps integrate it exactly but for f32 rounding of the speeds (a few ulp of 10 m/s).
      assert.ok(Math.abs(acceleration(physics, body) - exact) < 1e-3, `${degrees} degrees, mu ${mu}`);
    }
    for (const [degrees, mu] of [
      [30, 0.7],
      [10, 0.2],
    ]) {
      const { physics, body } = slope(degrees, mu, { shape: 'box', halfExtents: [0.25, 0.25, 0.25] });
      assert.ok(acceleration(physics, body) < 1e-3, `${degrees} degrees, mu ${mu}: it sticks`);
    }
  });

  test(`${fidelity}: a ball rolls down an incline without slipping at 5/7 g sin t, from the inertia its shape gives (DYN-06)`, () => {
    for (const degrees of [10, 20]) {
      const { physics, body, t } = slope(degrees, 1, { shape: 'sphere', radius: 0.3 }),
        exact = (5 / 7) * G * Math.sin(t);
      // A sliding ball would gain g sin t; the 2/7 a solid sphere's inertia takes is 0.7 m/s² at 20 degrees.
      assert.ok(Math.abs(acceleration(physics, body) - exact) < 1e-3, `${degrees} degrees`);
    }
  });

  /** Five balls on a line, `gap` apart, the first struck toward the rest at 1 m/s, with no gravity. */
  function cradle(gap) {
    const physics = new Physics(null, { fidelity });
    physics.gravity = [0, 0, 0];
    const r = 0.1,
      balls = [];
    for (let i = 0; i < 5; i++)
      balls.push(
        physics.addBody(null, {
          position: [i * (2 * r + gap) - (i === 0 ? 0.05 : 0), 0, 0],
          colliders: { shape: 'sphere', radius: r, restitution: 1, friction: 0 },
        }),
      );
    balls[0].setLinearVelocity([1, 0, 0]);
    for (let i = 0; i < 240; i++) physics.step();
    const v = balls.map((b) => b.linearVelocity[0]);
    return { v, momentum: v.reduce((s, x) => s + x, 0), energy: v.reduce((s, x) => s + x * x, 0) / 2 };
  }

  test(`${fidelity}: Newton's cradle: spaced balls pass the strike down the line, and no line ever gains energy`, () => {
    // Elastic collisions of equal masses one after another: the struck ball stops and the next takes its speed.
    for (const gap of [0.02, 0.005, 0.002]) {
      const { v, momentum, energy } = cradle(gap);
      for (let i = 0; i < 4; i++) assert.ok(Math.abs(v[i]) < 1e-3, `gap ${gap}: ball ${i} stops (${v})`);
      assert.ok(Math.abs(v[4] - 1) < 1e-3, `gap ${gap}: the last ball leaves at 1 m/s (${v})`);
      assert.ok(Math.abs(momentum - 1) < 1e-5 && energy <= 0.5 * (1 + 1e-5), `gap ${gap}: p ${momentum}, E ${energy}`);
    }
    // Touching balls are struck together in one solve, which shares the strike out (docs/limits.md); momentum still holds
    // and no energy is made.
    const { momentum, energy } = cradle(0);
    assert.ok(Math.abs(momentum - 1) < 1e-5 && energy <= 0.5 * (1 + 1e-5), `touching: p ${momentum}, E ${energy}`);
  });

  test(`${fidelity}: a tower of ten boxes stands for ten seconds and falls asleep where it was built`, () => {
    const physics = new Physics(null, { fidelity });
    floor(physics);
    const boxes = [];
    for (let i = 0; i < 10; i++)
      boxes.push(physics.addBody(null, { position: [0, 0.5 + i, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }));
    for (let i = 0; i < 600; i++) physics.step();
    const [x, y, z] = boxes[9].position;
    // Each of the ten contacts rests within the solver's slop of touching, under a millimetre each.
    assert.ok(Math.hypot(x, z) < 1e-3 && Math.abs(y - 9.5) < 1e-2, `the top box at ${[x, y, z]}`);
    assert.ok(
      boxes.every((b) => b.sleeping),
      'the tower sleeps',
    );
  });
}
