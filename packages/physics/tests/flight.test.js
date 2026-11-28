// Flight (AERO-03): a wing's lift slope is a finite wing's and its induced drag is lifting-line theory's; it stalls; a pair
// is symmetric; a glider settles where lift and drag balance its weight; a flapping wing's downstroke pushes it forward
// (AVIARY-2, AVIARY-3); a rotor's thrust is bounded by momentum theory, falls in a climb and holds a drone up; a balloon
// floats where the air it displaces weighs what it does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf, flatWingCoefficients, LiftingGas, RotorForce, WingForce } from '../dist/flight.js';
import { Physics } from '../dist/index.js';

await Physics.load();

const RHO = 1.2,
  U = 10;

/** A rectangular wing of span 6 and chord 1 at `twist`, on a body held still in a wind of U from ahead; one step's load. */
function wingLoad(twist, options = {}) {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  // Held still (kinematic), so the load reported is the wing's own at that attitude.
  const body = physics.addBody(null, {
      type: 'kinematicVelocity',
      colliders: { shape: 'box', halfExtents: [0.5, 0.1, 0.5] },
    }),
    wing = new WingForce(physics, body, {
      sections: [
        { leadingEdge: [0, 0, 0], chord: 1, twist },
        { leadingEdge: [3, 0, 0], chord: 1, twist },
      ],
      wind: [0, 0, -U],
      density: RHO,
      panels: [4, 8],
      // The lattice's own load; profile drag is checked on its own.
      profileDrag: 0,
      ...options,
    });
  physics.step();
  const q = 0.5 * RHO * U * U * 6;
  return { cl: wing.force[1] / q, cd: -wing.force[2] / q, wing };
}

test("a wing's lift slope is a finite wing's of its aspect ratio (Helmbold), and nose-up lifts", () => {
  const alpha = (5 * Math.PI) / 180,
    { cl } = wingLoad(alpha),
    helmbold = (2 * Math.PI * 6) / (2 + Math.sqrt(40));
  assert.ok(Math.abs(cl / alpha / helmbold - 1) < 0.05, `slope ${cl / alpha} against ${helmbold}`);
});

test("its induced drag is lifting-line theory's C_L^2 / (pi AR), and a pair carries no side force or roll", () => {
  for (const deg of [3, 8, 12]) {
    const { cl, cd, wing } = wingLoad((deg * Math.PI) / 180),
      elliptic = (cl * cl) / (Math.PI * 6);
    // Near-field Kutta-Joukowski drag runs a few percent under the elliptic wing's (docs/limits.md, "Flight").
    assert.ok(Math.abs(cd / elliptic - 1) < 0.06, `${deg} deg: C_D ${cd} against ${elliptic}`);
    assert.ok(Math.abs(wing.force[0]) < 1e-9 && Math.abs(wing.torque[2]) < 1e-6, 'symmetric');
  }
  // Profile drag adds its coefficient on top: 0.008 by default, both sides' skin friction.
  const bare = wingLoad(0.05),
    skinned = wingLoad(0.05, { profileDrag: undefined });
  assert.ok(Math.abs(skinned.cd - bare.cd - 0.008) < 1e-12 && skinned.cl === bare.cl);
});

test('past the stall angle a fixed wing loses lift as a flat plate does; a flapping wing keeps the lift of Su et al.', () => {
  const attached = wingLoad((14 * Math.PI) / 180),
    alpha = (25 * Math.PI) / 180,
    stalled = wingLoad(alpha),
    // Fully separated, a flat plate's normal force 1.17 sin(a) q A: lift 1.17 sin(a) cos(a), drag 1.17 sin^2(a).
    plateLift = 1.17 * Math.sin(alpha) * Math.cos(alpha),
    plateDrag = 1.17 * Math.sin(alpha) ** 2;
  assert.ok(stalled.cl < 0.6 * attached.cl && stalled.cd > 3 * attached.cd, `${stalled.cl} after ${attached.cl}`);
  assert.ok(Math.abs(stalled.cl / plateLift - 1) < 1e-9 && Math.abs(stalled.cd / plateDrag - 1) < 1e-9);
  const flapping = wingLoad(alpha, { separation: 'flapping' }),
    [cl25, cd25] = flatWingCoefficients(25);
  assert.ok(
    Math.abs(flapping.cl / cl25 - 1) < 1e-9 && Math.abs(flapping.cd / cd25 - 1) < 1e-9,
    `${flapping.cl}, ${flapping.cd}`,
  );
  // The fits of Su et al. at their ends: no lift edge on, a flat plate's drag broadside.
  const [cl0] = flatWingCoefficients(0),
    [, cd90] = flatWingCoefficients(90);
  assert.ok(Math.abs(cl0) < 0.05 && Math.abs(cd90 - 2.04) < 0.01);
});

test('profile drag is absent from fully separated plate and flapping panels', () => {
  const alpha = (25 * Math.PI) / 180;
  const plate = 1.17 * Math.sin(alpha) ** 2;
  for (const profileDrag of [0.008, 0.1]) {
    const fixed = wingLoad(alpha, { profileDrag, separation: 'plate' });
    assert.ok(Math.abs(fixed.cd - plate) < 128 * Number.EPSILON, `${fixed.cd} instead of plate drag ${plate}`);
    const plain = wingLoad(alpha, { separation: 'flapping' });
    const skinned = wingLoad(alpha, { profileDrag, separation: 'flapping' });
    assert.deepEqual(skinned.wing.force, plain.wing.force);
    assert.deepEqual(skinned.wing.torque, plain.wing.torque);
  }
});

test('profile drag covers only the attached area of a wing in spatially varying flow', () => {
  const alpha = (25 * Math.PI) / 180;
  // The inner half of this rectangular wing sees edge-on flow. The outer half is past stall.
  const wind = ([x]) => (Math.abs(x) < 1.5 ? [0, 0, -U] : [0, U * Math.sin(alpha), -U * Math.cos(alpha)]);
  const profileDrag = 0.1;
  const plain = wingLoad(0, { wind });
  const skinned = wingLoad(0, { wind, profileDrag });
  const addedDrag = skinned.cd - plain.cd;
  assert.ok(Math.abs(addedDrag - profileDrag / 2) < 128 * Number.EPSILON, `added drag coefficient ${addedDrag}`);
  assert.equal(skinned.cl, plain.cl);
  assert.ok(skinned.wing.circulation.every((circulation) => circulation === 0));
});

test('angleOf is the arctangent to the last bit or two, from arithmetic alone', () => {
  for (const [y, x] of [
    [0, 1],
    [0.3, 1],
    [1, 1],
    [3, 1],
    [1e9, 1],
    [1, 0],
  ])
    assert.ok(Math.abs(angleOf(y, x) - Math.atan2(y, x)) < 4e-16, `${y}, ${x}`);
});

test('a glider settles where lift and drag balance its weight: the glide angle is atan(D / L) (AVIARY-4)', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, {
      linearVelocity: [0, 0, 15],
      lockRotations: true,
      colliders: { shape: 'box', halfExtents: [0.2, 0.1, 0.5], mass: 20 },
    }),
    wing = new WingForce(physics, body, {
      sections: [
        { leadingEdge: [0, 0, 0.3], chord: 0.6, twist: 0.08 },
        { leadingEdge: [3, 0, 0.2], chord: 0.4, twist: 0.06 },
      ],
      density: RHO,
    });
  for (let i = 0; i < 60 * 30; i++) physics.step();
  const [, vy, vz] = body.linearVelocity,
    glide = Math.atan2(-vy, vz),
    lift = (wing.force[1] * vz) / Math.hypot(vy, vz) - (wing.force[2] * vy) / Math.hypot(vy, vz),
    drag = -(wing.force[2] * vz + wing.force[1] * vy) / Math.hypot(vy, vz);
  assert.ok(vy < 0 && vz > 0, 'gliding forward and down');
  assert.ok(
    Math.abs(glide - Math.atan2(drag, lift)) < 0.01,
    `glide ${glide} rad against atan(D/L) ${Math.atan2(drag, lift)}`,
  );
  // And the weight is carried: the air's force balances gravity.
  assert.ok(Math.abs(wing.force[1] - 20 * 9.81) < 0.01 * 20 * 9.81 && Math.abs(wing.force[2]) < 0.01 * 20 * 9.81);
});

test("a flapping wing's downstroke pushes it forward while it keeps its lift (AVIARY-2, AVIARY-3)", () => {
  const mean = (flap) => {
    const physics = new Physics(null);
    physics.gravity = [0, 0, 0];
    const body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.3], mass: 1e6 } }),
      wing = new WingForce(physics, body, {
        sections: [
          { leadingEdge: [0.1, 0, 0], chord: 0.3, twist: 0.08 },
          { leadingEdge: [0.9, 0, -0.05], chord: 0.2, twist: 0.08 },
        ],
        wind: [0, 0, -8],
        density: RHO,
        flap,
      });
    let lift = 0,
      thrust = 0;
    // Two seconds: four whole beats at 2 Hz.
    for (let i = 0; i < 120; i++) {
      physics.step();
      lift += wing.force[1] / 120;
      thrust += wing.force[2] / 120;
    }
    return { lift, thrust };
  };
  const gliding = mean(undefined),
    // The stroke down and up at 2 Hz, the wing pitched nose down through the downstroke.
    flapping = mean((t) => ({ stroke: 0.7 * Math.sin(4 * Math.PI * t), pitch: 0.3 * Math.cos(4 * Math.PI * t) }));
  assert.ok(gliding.thrust < 0, 'a gliding wing only drags');
  assert.ok(flapping.thrust > 0, `the beat gives net thrust: ${flapping.thrust} N`);
  assert.ok(flapping.lift > 0.5 * gliding.lift, 'and keeps most of its lift');
});

test("a rotor's thrust is bounded by momentum theory, rises with pitch and falls in a climb", () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.2, 0.1, 0.2], mass: 1e6 } });
  let last = 0;
  for (const pitch of [0.08, 0.15, 0.25]) {
    const rotor = new RotorForce(physics, body, { radius: 1, blades: 2, chord: 0.08, pitch, speed: 60, density: RHO }),
      hover = rotor.evaluate(60, 0, RHO),
      climb = rotor.evaluate(60, 3, RHO),
      // The ideal power of momentum theory, T^(3/2) / sqrt(2 rho A): no rotor does better.
      ideal = hover.thrust ** 1.5 / Math.sqrt(2 * RHO * Math.PI),
      merit = ideal / hover.power;
    assert.ok(merit > 0.4 && merit < 1, `figure of merit ${merit}`);
    assert.ok(hover.thrust > last && climb.thrust < hover.thrust);
    const reversed = rotor.evaluate(-60, 0, RHO);
    assert.ok(Math.abs(reversed.thrust - hover.thrust) < 1e-9 && reversed.torque === -hover.torque);
    last = hover.thrust;
    rotor.remove();
  }
});

test('a drone whose rotors carry its weight holds its height, and turns against its rotor torque', () => {
  const physics = new Physics(null),
    mass = 5,
    body = physics.addBody(null, {
      position: [0, 10, 0],
      colliders: { shape: 'box', halfExtents: [0.3, 0.05, 0.3], mass },
    }),
    rotor = new RotorForce(physics, body, { radius: 0.4, blades: 2, chord: 0.04, pitch: 0.2, speed: 0, density: RHO }),
    // The speed whose hover thrust is the weight, by bisection on the rotor's own evaluation.
    weight = body.mass * -physics.gravity[1];
  let lo = 0,
    hi = 2000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (rotor.evaluate(mid, 0, RHO).thrust < weight) lo = mid;
    else hi = mid;
  }
  rotor.remove();
  const held = new RotorForce(physics, body, {
    radius: 0.4,
    blades: 2,
    chord: 0.04,
    pitch: 0.2,
    speed: lo,
    density: RHO,
  });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(
    Math.abs(body.position[1] - 10) < 1e-3 && Math.abs(body.linearVelocity[1]) < 1e-4,
    `height ${body.position[1]}`,
  );
  assert.ok(body.angularVelocity[1] < 0 && held.torque > 0, 'the body spins against the rotor');
});

test('a balloon floats where the air it displaces weighs what it does', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1, mass: 3 } }),
    gas = new LiftingGas(physics, body, { volume: 4 });
  // Helium at sea level: (1.225 - 0.169) kg/m^3 of lift per cubic metre.
  assert.ok(Math.abs(gas.liftAt(0, 9.81) / (4 * 9.81) - 1.056) < 0.002);
  let lo = 0,
    hi = 20000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (gas.liftAt(mid, 9.81) > 3 * 9.81) lo = mid;
    else hi = mid;
  }
  assert.ok(lo > 3000 && lo < 4000, `floats at ${lo} m`);
  physics.step();
  const dt = physics.fixedTimestep;
  // The kernel keeps masses and gravity in f32: a part in a million.
  const expected = ((gas.lift - body.mass * -physics.gravity[1]) / body.mass) * dt;
  assert.ok(Math.abs(body.linearVelocity[1] / expected - 1) < 1e-6, 'rising at (L - W) / m');
  const hot = new LiftingGas(physics, body, { volume: 2000, gas: 'hotAir', temperature: 373.15 });
  assert.ok(hot.liftAt(0, 9.81) > 4000 && hot.liftAt(0, 9.81) < 6000, 'a hot-air balloon lifts about half a tonne');
});

test('a light body with a large wing stays stable at 60 steps a second (the load is taken implicitly)', () => {
  // 8 kg under a 4 m wing, free to turn: its roll damping times a 1/60 s step passes 2, where a load applied explicitly sent
  // the body past 1e15 within a second and a half.
  for (const flap of [undefined, (t) => ({ stroke: 0.5 * Math.sin(6 * t) })]) {
    const physics = new Physics(null),
      body = physics.addBody(null, {
        linearVelocity: [0, 0, 12],
        colliders: { shape: 'box', halfExtents: [0.2, 0.1, 0.5], mass: 8 },
      });
    new WingForce(physics, body, {
      sections: [
        { leadingEdge: [0, 0, 0.3], chord: 0.5, twist: 0.1 },
        { leadingEdge: [2, 0, 0], chord: 0.3 },
      ],
      flap,
    });
    let spin = 0,
      speed = 0;
    for (let i = 0; i < 180; i++) {
      physics.step();
      spin = Math.max(spin, Math.hypot(...body.angularVelocity));
      speed = Math.max(speed, Math.hypot(...body.linearVelocity));
    }
    // Gliding it barely turns; flapping it rocks with the beat, never running away.
    assert.ok(
      spin < (flap ? 40 : 5) && speed < 20,
      `${flap ? 'flapping' : 'gliding'}: spin ${spin} rad/s, speed ${speed} m/s`,
    );
  }
});

test('the same flight from the same start, bit for bit', () => {
  const run = () => {
    const physics = new Physics(null),
      body = physics.addBody(null, {
        linearVelocity: [0, 0, 12],
        colliders: { shape: 'box', halfExtents: [0.2, 0.1, 0.5], mass: 8 },
      });
    new WingForce(physics, body, {
      sections: [
        { leadingEdge: [0, 0, 0.3], chord: 0.5, twist: 0.1 },
        { leadingEdge: [2, 0, 0], chord: 0.3 },
      ],
      flap: (t) => ({ stroke: 0.5 * Math.sin(6 * t) }),
    });
    for (let i = 0; i < 90; i++) physics.step();
    return [...body.position, ...body.linearVelocity, ...body.angularVelocity];
  };
  assert.deepEqual(run(), run());
});

test('settings out of range are refused with what to pass', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1, mass: 1 } });
  assert.throws(
    () => new WingForce(physics, body, { sections: [{ leadingEdge: [0, 0, 0], chord: 1 }] }),
    /two or more/,
  );
  assert.throws(
    () =>
      new WingForce(physics, body, {
        sections: [
          { leadingEdge: [0, 0, 0], chord: 1 },
          { leadingEdge: [1, 0, 0], chord: 0 },
        ],
      }),
    /chord/,
  );
  assert.throws(() => new RotorForce(physics, body, { radius: 0, chord: 0.1, pitch: 0.1, speed: 1 }), /radius/);
  assert.throws(() => new LiftingGas(physics, body, { volume: 1, gas: 'neon' }), /helium/);
});

const flightError = (code, pattern) => (error) =>
  error?.name === 'MargoError' &&
  error.code === code &&
  pattern.test(error.message) &&
  error.message.endsWith('https://margoengine.com/errors#physics-flight');

test('wing load rejects late malformed wind and a derived overflow before replacing the accepted wrench', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.2], mass: 12 } });
  let mode = 'normal';
  const wing = new WingForce(physics, body, {
    sections: [
      { leadingEdge: [0, 0, 0], chord: 1, twist: 0.08 },
      { leadingEdge: [2, 0, 0], chord: 1, twist: 0.08 },
    ],
    panels: [2, 4],
    density: 1.2,
    wind: ([x]) =>
      x > 1 ? [0, 0, mode === 'malformed' ? Number.NaN : mode === 'excessive' ? -1e100 : -12] : [0, 0, -12],
  });
  physics.step();
  const accepted = () => [
    [...wing.force],
    [...wing.torque],
    [...wing.circulation],
    physics.kernel.hash,
    physics.stepCount,
  ];
  const before = accepted();
  assert.ok(wing.force[1] > 1);
  mode = 'malformed';
  assert.throws(() => physics.step(), flightError('unsupported', /wind sample.*finite/));
  assert.deepEqual(accepted(), before);
  mode = 'excessive';
  assert.throws(() => physics.step(), flightError('failed', /rigid force range/));
  assert.deepEqual(accepted(), before);
  mode = 'normal';
  physics.step();
  assert.equal(physics.stepCount, before[4] + 1);
  assert.ok(wing.force[1] > 1);
  physics.dispose();
});

test('body-centered wing loads retain small panel geometry far from the origin', () => {
  function load(x) {
    const physics = new Physics(null);
    const body = physics.addBody(null, { type: 'kinematicVelocity', position: [x, 3, 0] });
    const wing = new WingForce(physics, body, {
      sections: [
        { leadingEdge: [0, 0, 0], chord: 0.25, twist: 0.08 },
        { leadingEdge: [0.5, 0, 0], chord: 0.2, twist: 0.05 },
      ],
      wind: [0, 0, -12],
      density: 1.2,
      panels: [2, 3],
    });
    physics.step();
    const load = [[...wing.force], [...wing.torque], [...wing.circulation]];
    assert.ok(wing.force[1] > 1 && wing.circulation.some((value) => value !== 0));
    physics.dispose();
    return load;
  }
  assert.deepEqual(load(2 ** 49), load(0));
});

test('rotor and envelope reject invalid settings and callback results with coded fixes', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, { type: 'kinematicVelocity' });
  const settings = { radius: 0.4, chord: 0.04, pitch: 0.2, speed: 45, density: 1.2 };
  assert.throws(
    () => new RotorForce(physics, body, { ...settings, stall: NaN }),
    flightError('unsupported', /stall threshold/),
  );
  const rotor = new RotorForce(physics, body, {
    ...settings,
    axis: [0, Number.MIN_VALUE, 0],
    chord: (radius) => (radius > 0.35 ? NaN : settings.chord),
  });
  assert.throws(() => rotor.evaluate(45, 0, 1.2), flightError('unsupported', /blade station/));
  assert.throws(() => rotor.evaluate(45, 0, 0), flightError('unsupported', /positive finite density/));
  rotor.remove();
  const extreme = new RotorForce(physics, body, { ...settings, axis: [0, Number.MAX_VALUE, 0] });
  physics.step();
  assert.ok(extreme.thrust > 0 && Number.isFinite(extreme.power));
  assert.throws(() => extreme.evaluate(1e151, 0, 1e20), flightError('failed', /unrepresentable/));
  assert.throws(
    () => new LiftingGas(physics, body, { volume: 1, altitude: Infinity }),
    flightError('unsupported', /altitude/),
  );
  const gas = new LiftingGas(physics, body, { volume: 5, seaLevelTemperature: 50 });
  assert.throws(() => gas.liftAt(11_000, 9.81), flightError('failed', /atmosphere/));
  assert.throws(() => gas.liftAt(0, -9.81), flightError('unsupported', /gravity/));
  physics.dispose();
});

test('an overflow in combined air loads can be corrected without retaining the abandoned force', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 100 } });
  const control = physics.addBody(null, {
    position: [5, 0, 0],
    colliders: { shape: 'sphere', radius: 0.5, mass: 100 },
  });
  const own = [0, 0.75, 0];
  body.addForce(own, undefined, false);
  control.addForce(own, undefined, false);
  const held = [new LiftingGas(physics, body, { volume: 2e37 }), new LiftingGas(physics, body, { volume: 2e37 })];
  assert.throws(() => physics.step(), flightError('failed', /Combined air loads/));
  assert.equal(physics.stepCount, 0);
  held.forEach((load) => load.remove());
  physics.step();
  assert.deepEqual(body.linearVelocity, control.linearVelocity);
  assert.equal(physics.kernel.columns.forceY[body.row], 0.75);
  physics.dispose();
});
