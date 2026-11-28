// DYN-01 and DYN-06 against exact solutions (docs/physics-parity-bar.md, point 2): a dropped ball's rebound height,
// sliding and sticking on an incline, a ball rolling without slipping (which checks the solver's inertia), Newton's
// cradle, spaced and touching, and a tower of boxes. Each bound is derived in its test from the step, never fitted. The world runs at its
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
        ball = physics.addBody(null, {
          position: [0, drop + r, 0],
          colliders: { shape: 'sphere', radius: r, restitution: e },
        });
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
      assert.ok(
        Math.abs(peak - e * e * drop) <= bound,
        `e ${e}: rebound ${peak} against ${e * e * drop} (bound ${bound})`,
      );
    }
  });

  /** A slope of `degrees` about z, rising toward -x, and a body resting on it. */
  function slope(degrees, friction, collider) {
    const physics = new Physics(null, { fidelity }),
      t = (degrees * Math.PI) / 180,
      rotation = [0, 0, Math.sin(t / 2), Math.cos(t / 2)],
      up = [-Math.sin(t), Math.cos(t), 0];
    physics.addBody(null, {
      type: 'fixed',
      rotation,
      colliders: { shape: 'box', halfExtents: [50, 0.5, 5], friction },
    });
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
      const { physics, body, t } = slope(degrees, mu, {
          shape: 'box',
          halfExtents: [0.25, 0.25, 0.25],
        }),
        exact = G * (Math.sin(t) - mu * Math.cos(t));
      // Constant acceleration: the steps integrate it exactly but for f32 rounding of the speeds (a few ulp of 10 m/s).
      assert.ok(Math.abs(acceleration(physics, body) - exact) < 1e-3, `${degrees} degrees, mu ${mu}`);
    }
    for (const [degrees, mu] of [
      [30, 0.7],
      [10, 0.2],
    ]) {
      const { physics, body } = slope(degrees, mu, {
        shape: 'box',
        halfExtents: [0.25, 0.25, 0.25],
      });
      assert.ok(acceleration(physics, body) < 1e-3, `${degrees} degrees, mu ${mu}: it sticks`);
    }
  });

  test(`${fidelity}: a ball rolls down an incline without slipping at 5/7 g sin t, from the inertia its shape gives (DYN-06)`, () => {
    for (const degrees of [10, 20]) {
      const { physics, body, t } = slope(degrees, 1, {
          shape: 'sphere',
          radius: 0.3,
        }),
        exact = (5 / 7) * G * Math.sin(t);
      // A sliding ball would gain g sin t; the 2/7 a solid sphere's inertia takes is 0.7 m/s² at 20 degrees.
      assert.ok(Math.abs(acceleration(physics, body) - exact) < 1e-3, `${degrees} degrees`);
    }
  });

  /** Five balls on a line, `gap` apart, the first `struck` sent toward the rest at 1 m/s from `off` back, with no gravity. */
  function cradle(gap, struck = 1, off = 0.05) {
    const physics = new Physics(null, { fidelity });
    physics.gravity = [0, 0, 0];
    const r = 0.1,
      balls = [];
    for (let i = 0; i < 5; i++)
      balls.push(
        physics.addBody(null, {
          position: [i * (2 * r + gap) - (i < struck ? off : 0), 0, 0],
          colliders: {
            shape: 'sphere',
            radius: r,
            restitution: 1,
            friction: 0,
          },
        }),
      );
    for (let i = 0; i < struck; i++) balls[i].setLinearVelocity([1, 0, 0]);
    for (let i = 0; i < 240; i++) physics.step();
    const v = balls.map((b) => b.linearVelocity[0]);
    return {
      v,
      momentum: v.reduce((s, x) => s + x, 0),
      energy: v.reduce((s, x) => s + x * x, 0) / 2,
    };
  }

  test(`${fidelity}: Newton's cradle: the strike passes down the line, spaced or touching, and no line gains energy`, () => {
    // Elastic collisions of equal masses one after another: the struck ball stops and the next takes its speed. Touching
    // balls are struck one pair at a time before the contact solve (Guendelman, Bridson and Fedkiw 2003), so two struck
    // balls send two off. The strike lands at a different point of a substep for each `off`.
    for (const [gap, struck, off] of [
      [0.02, 1, 0.05],
      [0.005, 1, 0.05],
      [0.002, 1, 0.05],
      [0, 1, 0.05],
      [0, 1, 0.0537],
      [0, 2, 0.0513],
      [0, 2, 0.0571],
    ]) {
      const { v, momentum, energy } = cradle(gap, struck, off);
      for (let i = 0; i < 5 - struck; i++)
        assert.ok(Math.abs(v[i]) < 1e-3, `gap ${gap}, ${struck} struck: ball ${i} stops (${v})`);
      for (let i = 5 - struck; i < 5; i++)
        assert.ok(Math.abs(v[i] - 1) < 1e-3, `gap ${gap}, ${struck} struck: ball ${i} leaves at 1 m/s (${v})`);
      assert.ok(
        Math.abs(momentum - struck) < 1e-5 && energy <= 0.5 * struck * (1 + 1e-5),
        `gap ${gap}: p ${momentum}, E ${energy}`,
      );
    }
  });

  /**
   * Five touching 26 mm steel balls, each hung from one fixed body by a revolute joint about z on a 247 mm arm, the first
   * lifted 34 degrees and let go (KB-PHYS-HUNGCRADLE1). `watch(t, balls)` runs after every step until `seconds` have passed.
   */
  function hungCradle({ e = 1, mu = 0, seconds = 60, watch = () => {} } = {}) {
    const physics = new Physics(null, { fidelity });
    const r = 0.026,
      arm = 0.247,
      rest = 0.1,
      pivot = rest + arm,
      lift = (34 * Math.PI) / 180;
    const frame = physics.addBody(null, { type: 'fixed', position: [0, pivot, 0] });
    const balls = [];
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 2 * r,
        a = i === 0 ? -lift : 0;
      balls.push(
        physics.addBody(null, {
          position: [x + arm * Math.sin(a), pivot - arm * Math.cos(a), 0],
          colliders: { shape: 'sphere', radius: r, restitution: e, friction: mu, density: 'steel' },
        }),
      );
      physics.addJoint(frame, balls[i], {
        type: 'revolute',
        axis: [0, 0, 1],
        anchorA: [x, 0, 0],
        anchorB: [-arm * Math.sin(a), arm * Math.cos(a), 0],
      });
    }
    const start = balls[0].position[1] - rest;
    for (let step = 1; step <= seconds * 60; step++) {
      physics.step();
      watch(step / 60, balls);
    }
    return { r, arm, rest, pivot, start, substeps: fidelity === 'high' ? 32 : 8 };
  }

  /**
   * The turning heights of the end balls over `rest` (a swing, not the millimetres a stopped ball rocks), each found from
   * three steps by the parabola through them.
   */
  function turns(rest) {
    const seen = [[], []],
      heights = [];
    return {
      heights,
      watch(t, balls) {
        [balls[0], balls[4]].forEach((ball, k) => {
          const y = ball.position[1],
            last = seen[k];
          if (last.length === 2 && last[1] > last[0] && last[1] > y && last[1] - rest > 0.01)
            heights.push(last[1] + (y - last[0]) ** 2 / (8 * (2 * last[1] - last[0] - y)) - rest);
          seen[k] = [last[1] ?? y, y];
        });
      },
    };
  }

  test(`${fidelity}: a hung touching Newton's cradle swings one in, one out for 60 s and keeps its energy (KB-PHYS-HUNGCRADLE1)`, () => {
    // A ball hung from its joint is struck with the joints holding it (held_response): through the strike its mass along the
    // line is m + I / l^2 about the pivot, not its free m, so the joint takes nothing back after. A strike into a line that
    // closes inside a substep meets it at its time of impact (Mirtich and Canny 1995) and is the pass's, not the contact
    // solve's, and the few micronewton-seconds two hung balls press on each other do not make the line a resting pile.
    // Regression: the joints took back about 1% of every strike, the end pair rested on its micro-load and shared the
    // strike, and 75 s in the cradle swung as one.
    // Bounds: an exchange shared by 1% of the strike would swing a middle ball 1% of 34 degrees. Symplectic Euler keeps a
    // modified energy, not the energy: it differs by about h v . grad V, and a strike hands the swing from a ball still
    // falling to one leaving level, so each strike moves the swing's energy by about g h^2 / l (measured 1.1 g h^2 / l at
    // both tiers: 0.019% per strike at 8 substeps, 0.0012% at 32, a quarter per halving of h). The bound is twice that.
    const { heights, watch } = turns(0.1);
    let middle = 0;
    const xs = [-1, 0, 1].map((i) => i * 0.052),
      pivot = 0.347;
    const { arm, start, substeps } = hungCradle({
      watch(t, balls) {
        watch(t, balls);
        for (let i = 1; i < 4; i++)
          middle = Math.max(
            middle,
            Math.abs(Math.atan2(balls[i].position[0] - xs[i - 1], pivot - balls[i].position[1])),
          );
      },
    });
    const h = 1 / 60 / substeps,
      strikes = heights.length;
    assert.ok(middle < 0.01 * ((34 * Math.PI) / 180), `a middle ball swung ${(middle * 180) / Math.PI} degrees`);
    assert.ok(strikes >= 110, `${strikes} turns in 60 s`);
    const last = heights[strikes - 1] / start,
      floor = 1 - strikes * ((2 * G * h * h) / arm);
    assert.ok(last >= floor && last <= 1 + 1e-4, `the swing keeps ${last} of its height, at least ${floor}`);
    if (fidelity === 'high') assert.ok(last >= 0.99, `within 1% at 60 s: ${last}`);
  });

  test(`${fidelity}: a hung cradle at e = 0.995 hands on (1 + e) / 2 of the speed at each of its four pairs, and no less`, () => {
    // Equal balls struck pair by pair: each pair passes on (1 + e) / 2 of the speed, so the end ball rises to ((1 + e) / 2)^8
    // of the release height after the first strike, within the step's bound above and the parabola's fit.
    const e = 0.995,
      { heights, watch } = turns(0.1);
    const { arm, start, substeps } = hungCradle({ e, seconds: 0.6, watch });
    const h = 1 / 60 / substeps,
      first = heights[0] / start,
      want = ((1 + e) / 2) ** 8;
    assert.ok(
      Math.abs(first - want) <= (2 * G * h * h) / arm + 1e-4,
      `rose to ${first} of the height, (1 + e)^8 / 2^8 is ${want}`,
    );
  });

  test(`${fidelity}: a hung cradle's strike rubs with the joints holding the balls (Coulomb, mu = 0.1)`, () => {
    // A hung ball turns with its swing at v / l, so its contact point slips across the line at v r / l and rubs through the
    // whole strike (stopping it would take l / 2r times the strike). With the joints holding, a rub T on a pair turns both
    // pendulums back by T r / J, and T = mu P = mu J omega / l: each pair keeps 1 - mu r / l of the speed and sends the ball
    // behind back at mu r / l of it. So the end ball leaves at (1 - mu r / l)^4 of the speed it leaves at with no friction.
    // Regression: the rub took the free mass, spun the ball, and the joint turned the spin into swing.
    const speed = (mu) => {
      let v = 0;
      hungCradle({ mu, seconds: 0.27, watch: (t, balls) => (v = balls[4].linearVelocity[0]) });
      return v;
    };
    const mu = 0.1,
      r = 0.026,
      arm = 0.247,
      want = (1 - (mu * r) / arm) ** 4,
      got = speed(mu) / speed(0);
    assert.ok(
      Math.abs(got - want) < 0.1 * (1 - want),
      `the end ball keeps ${got} of its speed, (1 - mu r / l)^4 is ${want}`,
    );
  });

  test(`${fidelity}: a ball struck sideways into a touching line slides under Coulomb friction through the strike`, () => {
    // Equal solid balls, e = 1, mu = 0.1, the first at 1 m/s along the line and 1 m/s across it into two that touch. The strike
    // is resolved pair by pair (collide_pairwise): its normal impulse is (1 + e) v m / 2 = m, and friction may take up to mu m
    // across it, where stopping the slip would take m / 7 (each ball gives 1 / m + R^2 / I = 3.5 / m along the slip). So the ball
    // slides: it leaves with 1 - mu = 0.9 m/s across the line and R omega = mu m R^2 / I = 0.25 m/s, and stops along it.
    // Regression: the pairwise pass rubbed nothing, so the ball kept its whole 1 m/s across. The bound is f32 rounding.
    const physics = new Physics(null, { fidelity });
    physics.gravity = [0, 0, 0];
    const r = 0.1,
      balls = [];
    for (let i = 0; i < 3; i++)
      balls.push(
        physics.addBody(null, {
          position: [i * 2 * r - (i === 0 ? 0.001 : 0), 0, 0],
          colliders: { shape: 'sphere', radius: r, restitution: 1, friction: 0.1 },
        }),
      );
    balls[0].setLinearVelocity([1, 1, 0]);
    for (let i = 0; i < 6; i++) physics.step();
    const [vx, vy] = balls[0].linearVelocity,
      spin = Math.abs(balls[0].angularVelocity[2]) * r;
    assert.ok(Math.abs(vx) < 1e-3, `along the line ${vx}`);
    assert.ok(Math.abs(vy - 0.9) < 1e-3, `across the line ${vy}`);
    assert.ok(Math.abs(spin - 0.25) < 1e-3, `R omega ${spin}`);
  });

  test(`${fidelity}: a tower of ten boxes stands for ten seconds and falls asleep where it was built, bouncy or not`, () => {
    // The pairwise strike pass acts only on points approaching faster than two substeps of gravity, so a bouncy pile rests
    // as a dead one does.
    for (const restitution of [0, 0.5, 1]) {
      const physics = new Physics(null, { fidelity });
      floor(physics, { restitution });
      const boxes = [];
      for (let i = 0; i < 10; i++)
        boxes.push(
          physics.addBody(null, {
            position: [0, 0.5 + i, 0],
            colliders: {
              shape: 'box',
              halfExtents: [0.5, 0.5, 0.5],
              restitution,
            },
          }),
        );
      for (let i = 0; i < 600; i++) physics.step();
      const [x, y, z] = boxes[9].position;
      // Each of the ten contacts rests within the solver's slop of touching, under a millimetre each.
      assert.ok(Math.hypot(x, z) < 1e-3 && Math.abs(y - 9.5) < 1e-2, `e ${restitution}: the top box at ${[x, y, z]}`);
      assert.ok(
        boxes.every((b) => b.sleeping),
        `e ${restitution}: the tower sleeps`,
      );
    }
  });
}
