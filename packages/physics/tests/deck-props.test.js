// Loose props on a ship's moving deck (EF-3 of docs/physics-demo-review.md, through the rigid solver): cups, plates and
// chairs that stick, slide or tip as the deck's accelerations ask, against closed forms of the deck's motion. The deck is
// a laker's hull in a storm making way at 7.5 m/s: roll 20 degrees at 12 s, pitch 4 degrees at 9 s and heave 2 m at 9 s,
// about the hull's centre of flotation, the props 4 m above the roll axis and 60 m aft of the pitch axis (a dining room in
// the stern). A prop's friction demand is the ratio of the specific force across the deck to the one into it, R^T (a - g),
// from the deck's motion in doubles: it sticks while its friction exceeds the demand, slides when it does not, and tips
// (high friction) when its half width over the height of its centre of mass is below the demand. The deck is driven to
// its pose each step with the motion's velocity and spin (`setNextVelocity`), so it moves on a smooth path through the step
// as a real hull does; driven at one speed a step, its whole change of speed lands in a step's first substep, where a prop's
// friction holds only mu N h (KB-PHYS-KINJUMP1). Each prop takes the
// smaller of its friction and the deck's (`frictionCombine: 'min'`), so its own is the one that counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

const DT = 1 / 60;
const SPEED = 7.5;
const deg = Math.PI / 180;
const ROLL = { amplitude: 20 * deg, period: 12 };
const PITCH = { amplitude: 4 * deg, period: 9, phase: 1 };
const HEAVE = { amplitude: 2, period: 9, phase: 0.4 };
/** Where a prop stands in the deck's frame: 60 m aft, on the deck 4 m above the roll axis. */
const SPOT = [-60, 4, 0];

/** q = rotation about x by `a` times about z by `b`: roll about the ship's length (x) after pitch about its beam (z). */
function rotation(roll, pitch) {
  const [sx, cx, sz, cz] = [Math.sin(roll / 2), Math.cos(roll / 2), Math.sin(pitch / 2), Math.cos(pitch / 2)];
  // q_roll * q_pitch
  return [sx * cz, -sx * sz, cx * sz, cx * cz];
}
function rotate(q, v) {
  const [x, y, z, w] = q,
    t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + y * t[2] - z * t[1],
    v[1] + w * t[1] + z * t[0] - x * t[2],
    v[2] + w * t[2] + x * t[1] - y * t[0],
  ];
}
const wave = (m, t) => m.amplitude * Math.sin((2 * Math.PI * t) / m.period + (m.phase ?? 0));
/** The deck's pose at `t`: its rotation and where its frame's origin (the roll and pitch axes' crossing) is. */
function deckPose(t, scale = 1) {
  const q = rotation(scale * wave(ROLL, t), scale * wave(PITCH, t));
  return { q, origin: [SPEED * t, scale * wave(HEAVE, t), 0] };
}
/** The deck's spin at `t`, rad/s: the rotation vector of q(t + h) q(t - h)^-1 over 2 h. */
function spinOf(t, scale = 1) {
  const h = 1e-4,
    a = deckPose(t + h, scale).q,
    b = deckPose(t - h, scale).q,
    // a * conj(b)
    [x, y, z, w] = [
      a[3] * -b[0] + a[0] * b[3] + a[1] * -b[2] - a[2] * -b[1],
      a[3] * -b[1] - a[0] * -b[2] + a[1] * b[3] + a[2] * -b[0],
      a[3] * -b[2] + a[0] * -b[1] - a[1] * -b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * -b[0] - a[1] * -b[1] - a[2] * -b[2],
    ],
    angle = 2 * Math.atan2(Math.hypot(x, y, z), w),
    n = Math.hypot(x, y, z) || 1;
  return [(x / n) * (angle / (2 * h)), (y / n) * (angle / (2 * h)), (z / n) * (angle / (2 * h))];
}
/** The velocity of the deck body's origin (its centre, on the deck's mid-plane below the spot), by a centred difference. */
function deckVelocity(t, scale = 1) {
  const h = 1e-4,
    at = (u) => {
      const { q, origin } = deckPose(u, scale);
      return rotate(q, [0, SPOT[1] - 0.5, 0]).map((v, k) => v + origin[k]);
    },
    [a, b] = [at(t + h), at(t - h)];
  return [0, 1, 2].map((k) => (a[k] - b[k]) / (2 * h));
}
/** World position of a point fixed in the deck's frame. */
const worldOf = (t, p, scale) => {
  const { q, origin } = deckPose(t, scale),
    r = rotate(q, p);
  return [origin[0] + r[0], origin[1] + r[1], origin[2] + r[2]];
};
/** The friction demand at the spot over [0, seconds]: max |f across| / f into the deck, f = R^T (a - g), by differences. */
function demand(seconds, scale = 1) {
  const h = 1e-3;
  let most = 0;
  for (let t = 0; t <= seconds; t += 0.01) {
    const [a, b, c] = [worldOf(t - h, SPOT, scale), worldOf(t, SPOT, scale), worldOf(t + h, SPOT, scale)];
    const acc = [0, 1, 2].map((k) => (a[k] - 2 * b[k] + c[k]) / (h * h));
    const { q } = deckPose(t, scale),
      f = rotate([-q[0], -q[1], -q[2], q[3]], [acc[0], acc[1] + 9.81, acc[2]]);
    most = Math.max(most, Math.hypot(f[0], f[2]) / f[1]);
  }
  return most;
}

/**
 * A deck (a box 120 m by 16 m, its top at the spot's height) driven along the storm motion, with `props` made on it at the
 * spot, each started with the deck's motion there. Steps `seconds` and returns, for each prop, the most it moved across
 * the deck from where it began, and the most it turned.
 */
function ride(props, seconds, scale = 1) {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const start = deckPose(0, scale);
  const deck = physics.addBody(null, {
    type: 'kinematicPosition',
    position: rotate(start.q, [0, SPOT[1] - 0.5, 0]).map((v, k) => v + start.origin[k]),
    rotation: start.q,
    linearVelocity: deckVelocity(0, scale),
    angularVelocity: spinOf(0, scale),
    colliders: { shape: 'box', halfExtents: [70, 0.5, 8], friction: 1 },
  });
  const bodies = props.map((make, i) => {
    const local = [SPOT[0] + 3 * i, SPOT[1], SPOT[2]];
    const body = make(physics, worldOf(0, local, scale), start.q);
    // The deck's velocity at the prop and its spin, so the prop starts riding as part of it.
    const v = [0, 1, 2].map((k) => (worldOf(1e-4, local, scale)[k] - worldOf(-1e-4, local, scale)[k]) / 2e-4);
    body.setLinearVelocity(v);
    body.setAngularVelocity(spinOf(0, scale));
    return { body, local };
  });
  const placed = bodies.map(({ body }) => {
    const { q, origin } = deckPose(0, scale),
      p = body.position;
    return rotate([-q[0], -q[1], -q[2], q[3]], [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
  });
  const moved = bodies.map(() => 0),
    turned = bodies.map(() => 0);
  for (let i = 1; i <= seconds / DT; i++) {
    const t = i * DT,
      { q, origin } = deckPose(t, scale);
    deck.setNextPosition(rotate(q, [0, SPOT[1] - 0.5, 0]).map((v, k) => v + origin[k]));
    deck.setNextRotation(q);
    // The deck reaches each pose at the motion's own velocity and spin, so it moves on a smooth path through the step.
    deck.setNextVelocity(deckVelocity(t, scale), spinOf(t, scale));
    physics.step();
    bodies.forEach(({ body }, k) => {
      const p = body.position,
        local = rotate([-q[0], -q[1], -q[2], q[3]], [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
      moved[k] = Math.max(moved[k], Math.hypot(local[0] - placed[k][0], local[2] - placed[k][2]));
      // The prop's up axis against the deck's up axis.
      const up = rotate(body.rotation, [0, 1, 0]),
        deckUp = rotate(q, [0, 1, 0]);
      turned[k] = Math.max(
        turned[k],
        Math.acos(Math.min(1, up[0] * deckUp[0] + up[1] * deckUp[1] + up[2] * deckUp[2])),
      );
    });
  }
  physics.dispose();
  return { moved, turned };
}

/** A box prop of half extents `half` and friction `mu`, set down on the deck at `at`. */
const box =
  (half, mu, density = 600) =>
  (physics, at, q) => {
    const lift = rotate(q, [0, half[1], 0]);
    return physics.addBody(null, {
      position: [at[0] + lift[0], at[1] + lift[1], at[2] + lift[2]],
      rotation: q,
      canSleep: false,
      colliders: { shape: 'box', halfExtents: half, friction: mu, frictionCombine: 'min', density },
    });
  };
/** A chair: a seat on four legs, one body of five boxes. */
const chair = (mu) => (physics, at, q) => {
  const lift = rotate(q, [0, 0.45, 0]),
    leg = (x, z) => ({
      shape: 'box',
      halfExtents: [0.02, 0.225, 0.02],
      offset: [x, -0.225, z],
      friction: mu,
      frictionCombine: 'min',
      density: 600,
    });
  return physics.addBody(null, {
    position: [at[0] + lift[0], at[1] + lift[1], at[2] + lift[2]],
    rotation: q,
    canSleep: false,
    colliders: [
      { shape: 'box', halfExtents: [0.22, 0.02, 0.22], friction: mu, frictionCombine: 'min', density: 600 },
      leg(0.2, 0.2),
      leg(-0.2, 0.2),
      leg(0.2, -0.2),
      leg(-0.2, -0.2),
    ],
  });
};

test('the storm deck asks a quarter to half of g of friction aft, from roll, pitch and heave together', () => {
  const most = demand(36);
  assert.ok(most > 0.25 && most < 0.6, `the demand is ${most}`);
});

test('a plate sticks where its friction exceeds the deck’s demand, and a plate and a chair slide where it does not', (t) => {
  const most = demand(36),
    high = 1.3 * most,
    low = 0.6 * most;
  const { moved } = ride([box([0.12, 0.01, 0.12], high), chair(high), box([0.12, 0.01, 0.12], low), chair(low)], 36);
  t.diagnostic(
    `demand ${most}: sticking plate ${moved[0]} m (chair ${moved[1]} m); sliding plate ${moved[2]} m, chair ${moved[3]} m`,
  );
  // Held: a part of a millimetre to two over three roll periods (the contacts' softness, not slip that adds up).
  assert.ok(moved[0] < 2e-3, `a held plate moved ${moved[0]} m across the deck`);
  // The chair of five colliders is held to the plate's bound: its legs' pairs with the deck solve their friction as one
  // patch, where one pair at a time it crept about 2 cm in the same 36 s (KB-PHYS-MULTIPAIRCREEP1).
  assert.ok(moved[1] < 2e-3, `a held chair moved ${moved[1]} m across the deck`);
  // Sliding, and still on the 16 m deck.
  for (const k of [2, 3]) assert.ok(moved[k] > 0.05 && moved[k] < 8, `a prop past its friction moved ${moved[k]} m`);
});

test('a tall cup tips where its half width over its height is below the demand, and a squat one stands', (t) => {
  // High friction (1.2), so neither slides: a cup tips when w / h < demand at its centre of mass.
  const most = demand(36),
    tall = box([0.04, 0.04 / (0.7 * most), 0.04], 1.2),
    squat = box([0.06, 0.06 / (1.6 * most), 0.06], 1.2);
  const { turned } = ride([tall, squat], 36);
  t.diagnostic(`demand ${most}: the tall cup turned ${turned[0] / deg} degrees, the squat one ${turned[1] / deg}`);
  assert.ok(turned[0] > 45 * deg, `the tall cup turned only ${turned[0] / deg} degrees`);
  assert.ok(turned[1] < 2 * deg, `the squat cup turned ${turned[1] / deg} degrees`);
});

test('on a deck heeled slowly, a plate starts to slide at the heel whose tangent is its friction', () => {
  // A quasi-static heel of 1 degree a second, no other motion: a plate of mu 0.4 holds to atan(0.4) = 21.8 degrees.
  for (const mu of [0.3, 0.4, 0.6]) {
    const physics = new Physics(null, { gravity: [0, -9.81, 0] });
    const deck = physics.addBody(null, {
      type: 'kinematicPosition',
      colliders: { shape: 'box', halfExtents: [3, 0.5, 3], friction: 1 },
    });
    const plate = physics.addBody(null, {
      position: [0, 0.51, 0],
      canSleep: false,
      colliders: { shape: 'box', halfExtents: [0.12, 0.01, 0.12], friction: mu, frictionCombine: 'min', density: 600 },
    });
    let slid = null;
    for (let i = 1; i <= 60 * 50 && slid === null; i++) {
      const heel = i * DT * deg;
      deck.setNextRotation([Math.sin(heel / 2), 0, 0, Math.cos(heel / 2)]);
      physics.step();
      const along = rotate([-Math.sin(heel / 2), 0, 0, Math.cos(heel / 2)], plate.position)[2];
      if (Math.abs(along) > 1e-3) slid = heel;
    }
    const expected = Math.atan(mu);
    assert.ok(
      slid !== null && Math.abs(slid - expected) < 0.5 * deg,
      `mu ${mu}: slid at ${slid / deg} degrees, not ${expected / deg}`,
    );
    physics.dispose();
  }
});

test('a prop sliding on a free hull hands it the momentum it loses: the two together keep theirs', () => {
  // A 2,000 kg hull free on a frictionless floor and a 50 kg chest thrown along its deck at 3 m/s: friction slows the chest
  // and pushes the hull, and with no force from outside along the deck their momentum stays what it was.
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [100, 0.5, 100], friction: 0, frictionCombine: 'min' },
  });
  const hull = physics.addBody(null, {
    position: [0, 0.5, 0],
    canSleep: false,
    colliders: { shape: 'box', halfExtents: [10, 0.5, 3], friction: 0.5, mass: 2000 },
  });
  const chest = physics.addBody(null, {
    position: [-5, 1.25, 0],
    linearVelocity: [3, 0, 0],
    canSleep: false,
    colliders: { shape: 'box', halfExtents: [0.4, 0.25, 0.3], friction: 0.5, mass: 50 },
  });
  // The floor's friction combines by the smaller of the two surfaces' (0), so it takes no momentum along x.
  const p0 = 50 * 3;
  for (let i = 0; i < 180; i++) physics.step();
  const p = hull.mass * hull.linearVelocity[0] + chest.mass * chest.linearVelocity[0];
  assert.ok(Math.abs(p - p0) < 1e-3 * p0, `momentum along the deck ${p} kg m/s, thrown with ${p0}`);
  assert.ok(Math.abs(chest.linearVelocity[0] - hull.linearVelocity[0]) < 1e-3, 'the chest has stopped on the deck');
  physics.dispose();
});
