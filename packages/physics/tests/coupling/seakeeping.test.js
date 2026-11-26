// The hull solver's coupling checks (docs/physics-framework.md, section 10): `HullSolver` before `RigidSolver`, a box hull on
// a regular wave, held to the harness (the same state at 24, 30 and 60 frames a second, a seek equal to a continuous run),
// the load reaching the hull it names, and a box let go above its draft heaving at the period its buoyancy gives it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import {
  GRAVITY,
  HullSolver,
  heaveSection,
  lateralSection,
  lewisForm,
  SEA_WATER,
  wettedLoads,
} from '../../dist/seakeeping.js';
import { BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

/** A box hull of `size` (x, y, z), each face a 4 by 4 grid, wound outward. */
function boxMesh([sx, sy, sz], [ox, oy, oz] = [0, 0, 0]) {
  const h = [sx / 2, sy / 2, sz / 2],
    vertices = [],
    indices = [],
    n = 4;
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const [u, v] = [0, 1, 2].filter((a) => a !== axis),
      first = vertices.length / 3;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        const p = [0, 0, 0];
        p[axis] = sign * h[axis];
        p[u] = -h[u] + (2 * h[u] * i) / n;
        p[v] = -h[v] + (2 * h[v] * j) / n;
        vertices.push(p[0] + ox, p[1] + oy, p[2] + oz);
      }
    const at = (i, j) => first + i * (n + 1) + j;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (const t of [
          [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
          [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
        ]) {
          const p = t.map((k) => [vertices[3 * k] - ox, vertices[3 * k + 1] - oy, vertices[3 * k + 2] - oz]),
            e1 = [0, 1, 2].map((c) => p[1][c] - p[0][c]),
            e2 = [0, 1, 2].map((c) => p[2][c] - p[0][c]),
            nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          indices.push(...(nrm[axis] * sign > 0 ? t : [t[0], t[2], t[1]]));
        }
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

const [L, D, B, T] = [4, 1.5, 2, 0.5];
/** A 20 m wave of 0.2 m along x, in deep water. */
const k = (2 * Math.PI) / 20,
  w = Math.sqrt(GRAVITY * k),
  wave = {
    density: SEA_WATER,
    elevation: (x, _z, t) => 0.2 * Math.cos(k * x - w * t),
    pressure: (x, y, _z, t) => {
      const eta = 0.2 * Math.cos(k * x - w * t);
      return -SEA_WATER * GRAVITY * y + SEA_WATER * GRAVITY * 0.2 * Math.cos(k * x - w * t) * Math.exp(k * (y - eta));
    },
  };

/** Two box hulls of the mass that floats them at draft T, on `sea`; the solver loads hull `which` (both for 2, none for -1). */
function make(rate = { num: 24, den: 1 }, which = 2, sea = wave, options = {}) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    mass = SEA_WATER * L * B * T,
    boxes = [0, 8].map((x) =>
      physics.addBody(null, {
        position: [x, D / 2 - T, 0],
        colliders: { shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass },
      }),
    ),
    mesh = boxMesh([L, D, B]),
    hulls = (which === 2 ? boxes : which < 0 ? [] : [boxes[which]]).map((b) => ({ row: b.row, mesh })),
    world = new PhysicsWorld({ rate }).add(new RigidSolver(), { physics });
  if (hulls.length) world.add(new HullSolver(), { hulls, sea, ...options }).couple(['hull', 'rigid'], 'staggered');
  return Object.assign(world, { boxes, physics });
}

test('HullSolver: the same state at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('HullSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test('HullSolver: the load reaches the hull it names', () => {
  effectBothWays(
    (side) => make({ num: 24, den: 1 }, side),
    (world, side) => world.boxes[side].position[1],
  );
});

/**
 * A solver that drives body `row` along `axis` (1 heave, 2 sway) with f0 sin(w t), t the middle of each step; over the first
 * `ramp` seconds the force grows as (1 - cos(pi t / ramp)) / 2, so the start excites little but the frequency w.
 */
function driver(row, f0, w, axis = 1, ramp = 0) {
  let region, host;
  return {
    describe: () => ({
      id: 'drive',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: BODY_FORCES_FIELD, access: 'accumulate' }],
    }),
    init(h) {
      host = h;
      region = h.allocate('drive', (row + 1) * FORCE_WORDS * 8, 'f64', 1);
    },
    step(context) {
      const words = new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / 8);
      words.fill(0);
      const t = (context.tick + 0.5) / 60,
        grow = t < ramp ? (1 - Math.cos((Math.PI * t) / ramp)) / 2 : 1;
      words[row * FORCE_WORDS + axis] = grow * f0 * Math.sin(w * t);
    },
    exportPorts: (tick) => [{ field: 'bodyForces', region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

/** A box hull alone in still water, its own world, driven by `drive` when given; `mesh` and `mass` for another hull. */
function single(options = {}, drive, mesh = boxMesh([L, D, B]), mass = SEA_WATER * L * B * T) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    box = physics.addBody(null, {
      position: [0, D / 2 - T, 0],
      colliders: { shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass },
    }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(new HullSolver(), {
      hulls: [{ row: box.row, mesh }],
      sea: { density: SEA_WATER, elevation: () => 0 },
      ...options,
    });
  if (drive) world.add(driver(box.row, ...drive), {}).couple(['drive', 'hull', 'rigid'], 'staggered');
  else world.couple(['hull', 'rigid'], 'staggered');
  return { world, box };
}

test('HullSolver: driven up and down, a box heaves as Cummins equation in the frequency domain says', () => {
  // Heave of amplitude F / |C - (m + A(w)) w^2 + i w B(w)| at each driving frequency w (Journee and Massie, Offshore
  // Hydromechanics, 2001, eqs. 6.20-6.31), A(w) and B(w) the box section's added mass and damping (Ursell-Tasai, the same
  // section for every station) times its length: the time-domain solver (its added mass at infinite frequency and its
  // radiation memory, Cummins 1962) must give the frequency-domain answer. Its own errors: the kernel taken from its
  // frequencies with B(w) linear between them, and the step (the load taken where a held load is energy-neutral, the
  // radiation carried there, O((w dt)^2)); measured 0.05, 0.57 and 0.35 percent at 60 steps a second, so a bound of 3
  // percent leaves room for the strips alone.
  const rho = SEA_WATER,
    m = rho * L * B * T,
    C = rho * GRAVITY * L * B,
    form = lewisForm(B, T, B * T),
    f0 = 2000;
  for (const w of [2.5, 2.9, 3.5]) {
    const { world, box } = single({}, [f0, w]),
      rest = D / 2 - T;
    let amplitude = 0;
    for (let f = 1; f <= 40 * 60; f++) {
      world.advance(f);
      if (f > 30 * 60) amplitude = Math.max(amplitude, Math.abs(box.position[1] - rest));
    }
    const s = heaveSection(form, w, rho, GRAVITY),
      expected = f0 / Math.hypot(C - (m + s.addedMass * L) * w * w, w * s.damping * L);
    assert.ok(
      Math.abs(amplitude - expected) <= 0.03 * expected,
      `at ${w} rad/s: heave ${amplitude} m against ${expected} m`,
    );
  }
});

test('HullSolver: let go above its draft, a box settles as its damping says; without the water it carries, it heaves at its bare period', () => {
  // Its natural frequency w_n solves w^2 (m + A(w)) = C, and its damping ratio is B(w_n) / (2 sqrt((m + A) C)), 0.17 for this
  // box: after 10 s its heave is e^(-0.17 w_n 10) = 0.7 percent of the 5 cm it was let go from. With neither its added mass
  // nor its radiation it heaves on at 2 pi sqrt(m / C) (Journee and Massie, section 6.3).
  const { world, box } = single(),
    rest = D / 2 - T;
  box.setPosition([0, rest + 0.05, 0]);
  let late = 0;
  for (let f = 1; f <= 660; f++) {
    world.advance(f);
    if (f > 600) late = Math.max(late, Math.abs(box.position[1] - rest));
  }
  assert.ok(late <= 0.02 * 0.05, `it settles: ${late} m left after 10 s`);
  const bare = single({ addedMass: false, radiation: false }),
    crossings = [];
  bare.box.setPosition([0, rest + 0.05, 0]);
  let last = 0.05;
  for (let f = 1; f <= 600; f++) {
    bare.world.advance(f);
    const now = bare.box.position[1] - rest;
    if (last > 0 && now <= 0) crossings.push(f - now / (now - last));
    last = now;
  }
  const period = (crossings.at(-1) - crossings[0]) / (crossings.length - 1) / 60,
    expected = 2 * Math.PI * Math.sqrt((SEA_WATER * L * B * T) / (SEA_WATER * GRAVITY * L * B));
  assert.ok(Math.abs(period - expected) <= 0.02 * expected, `bare: period ${period} s against ${expected} s`);
});

/** The complex amplitudes of `signals` (sampled at 60 Hz from frame `from`) at frequency w: x(t) = Re(X e^(i w t)). */
function amplitudes(signals, w, from) {
  return signals.map((x) => {
    // Least squares on [cos, sin, 1, t]: the motion at w, a constant and a drift.
    const n = x.length - from,
      rows = [];
    for (let f = from; f < x.length; f++) {
      const t = (f + 1) / 60;
      rows.push([Math.cos(w * t), Math.sin(w * t), 1, t, x[f]]);
    }
    const N = Array.from({ length: 4 }, () => new Array(5).fill(0));
    for (const r of rows) for (let a = 0; a < 4; a++) for (let b = 0; b < 5; b++) N[a][b] += r[a] * r[b];
    for (let c = 0; c < 4; c++)
      for (let r = c + 1; r < 4; r++) {
        const f = N[r][c] / N[c][c];
        for (let k = c; k < 5; k++) N[r][k] -= f * N[c][k];
      }
    const sol = new Array(4).fill(0);
    for (let r = 3; r >= 0; r--) {
      let v = N[r][4];
      for (let k = r + 1; k < 4; k++) v -= N[r][k] * sol[k];
      sol[r] = v / N[r][r];
    }
    void n;
    // x = c cos + s sin = Re((c - i s) e^(i w t)).
    return [sol[0], -sol[1]];
  });
}

/** Solves the 2 by 2 complex system [[a, b], [c, d]] X = [f, g] (complex numbers as [re, im]). */
function solve2(a, b, c, d, f, g) {
  const mul = (x, y) => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]],
    sub = (x, y) => [x[0] - y[0], x[1] - y[1]],
    div = (x, y) => {
      const m = y[0] * y[0] + y[1] * y[1];
      return [(x[0] * y[0] + x[1] * y[1]) / m, (x[1] * y[0] - x[0] * y[1]) / m];
    },
    det = sub(mul(a, d), mul(b, c));
  return [div(sub(mul(f, d), mul(b, g)), det), div(sub(mul(a, g), mul(c, f)), det)];
}

test('HullSolver: driven sideways, a box sways and rolls as the coupled frequency-domain equations say', () => {
  // Sway z and roll about x, coupled through the water (a24, b24 of each section about the centre of gravity, 0.25 m above
  // the waterline): [C - w^2 (M + A(w)) + i w B(w)] X = F with C the roll restoring rho g V GM (GM = KB + BM - KG, a box's:
  // T/2 + B^2/(12 T) - D/2) and nothing in sway. The radiation memory and the lateral added mass at infinite frequency must
  // give that. Driven above the roll's resonance (about 1.6 rad/s), the drift sway has no spring to hold is taken out with
  // the fit. The roll's own oscillation near 1.6 rad/s is barely damped (its potential damping is small there), so a drive
  // switched on at once leaves it ringing through the fit, which then moved by 3 to 7 percent with the window; the drive
  // grows over 10 s instead, and the fit holds within 0.1 percent from 20, 40 or 60 s. Measured 0.3 to 1.1 percent off at
  // 60 steps a second and 0.05 to 0.9 at 240 (the step's own error and the strips' floor): a bound of 3 percent.
  const rho = SEA_WATER,
    m = rho * L * B * T,
    ixx = (m * (D * D + B * B)) / 12,
    gm = T / 2 + (B * B) / (12 * T) - D / 2,
    c44 = rho * GRAVITY * L * B * T * gm,
    form = lewisForm(B, T, B * T),
    // The centre of gravity's depth under the waterline (body y: waterline T - D/2, centre 0): 0.25 m above it.
    pivot = T - D / 2 - 0,
    f0 = 2000;
  for (const w of [3, 4]) {
    const { world, box } = single({}, [f0, w, 2, 10]),
      sway = [],
      roll = [];
    for (let f = 1; f <= 40 * 60; f++) {
      world.advance(f);
      sway.push(box.position[2]);
      roll.push(2 * box.rotation[0]);
    }
    const [X2, X4] = amplitudes([sway, roll], w, 20 * 60),
      s = lateralSection(form, w, rho, pivot, GRAVITY),
      a = (x) => x * L,
      [P2, P4] = solve2(
        [-w * w * (m + a(s.sway.addedMass)), w * a(s.sway.damping)],
        [-w * w * a(s.swayOfRoll.addedMass), w * a(s.swayOfRoll.damping)],
        [-w * w * a(s.rollOfSway.addedMass), w * a(s.rollOfSway.damping)],
        [c44 - w * w * (ixx + a(s.roll.addedMass)), w * a(s.roll.damping)],
        [0, -f0],
        [0, 0],
      );
    const close = (got, want, what) =>
      assert.ok(
        Math.hypot(got[0] - want[0], got[1] - want[1]) <= 0.03 * Math.hypot(...want),
        `at ${w} rad/s, ${what}: ${got} against ${want}`,
      );
    close(X2, P2, 'sway');
    close(X4, P4, 'roll');
  }
});

test('HullSolver: on a hull uneven fore and aft, heave drives pitch with the sign the strips give it', () => {
  // A wide short body aft (3 m by 2 m) and a narrow long one forward (1.5 m by 2.83 m), so its centre of buoyancy is at
  // its centre of mass (no trim) but its sections' added mass and damping are not even about it: heave and pitch couple
  // through A15 = sum a33 x and B15 = sum b33 x. Driven in heave, its pitch must follow with the phase that coupling gives
  // (a coupling of the wrong sign leaves the amplitudes and turns the pitch half a cycle): the coupled 2 by 2 equations, C
  // taken from the hull's own load (finite differences of wettedLoads). Measured 1.2 percent off in heave and 1.0 in pitch
  // at 60 steps a second (0.6 in pitch at 240): a bound of 3 percent. With the radiation force held from the step's start
  // while the load is taken 7/16 of the way in, the pitch was 5.2 percent off, an error first order in the step.
  const rho = SEA_WATER,
    lf = Math.sqrt(8),
    [ba, bf] = [3, 1.5],
    aft = boxMesh([2, D, ba], [-1, 0, 0]),
    fore = boxMesh([lf, D, bf], [lf / 2, 0, 0]),
    count = aft.vertices.length / 3,
    mesh = {
      vertices: Float64Array.from([...aft.vertices, ...fore.vertices]),
      indices: Uint32Array.from([...aft.indices, ...fore.indices.map((i) => i + count)]),
    },
    volume = (2 * ba + lf * bf) * T,
    m = rho * volume,
    izz = (m * (L * L + D * D)) / 12,
    rest = D / 2 - T,
    // Restoring, from the load itself: heave and pitch moved a little each way from rest.
    load = (dy, angle) =>
      wettedLoads(
        mesh,
        { position: [0, rest + dy, 0], rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] },
        { density: rho, elevation: () => 0 },
        0,
        [0, rest + dy, 0],
      ),
    h = 1e-4,
    c11 = -(load(h, 0).force[1] - load(-h, 0).force[1]) / (2 * h),
    c15 = -(load(0, h).force[1] - load(0, -h).force[1]) / (2 * h),
    c51 = -(load(h, 0).torque[2] - load(-h, 0).torque[2]) / (2 * h),
    c55 = -(load(0, h).torque[2] - load(0, -h).torque[2]) / (2 * h),
    // The strips' coefficients at w, in the body's axes: heave-pitch sum a x, pitch sum a x^2.
    strips = (w) => {
      let [a11, a15, a55, b11, b15, b55] = [0, 0, 0, 0, 0, 0];
      for (const [b, x0, x1] of [
        [ba, -2, 0],
        [bf, 0, lf],
      ]) {
        const s = heaveSection(lewisForm(b, T, b * T), w, rho, GRAVITY),
          [i0, i1, i2] = [x1 - x0, (x1 * x1 - x0 * x0) / 2, (x1 ** 3 - x0 ** 3) / 3];
        a11 += s.addedMass * i0;
        a15 += s.addedMass * i1;
        a55 += s.addedMass * i2;
        b11 += s.damping * i0;
        b15 += s.damping * i1;
        b55 += s.damping * i2;
      }
      return { a11, a15, a55, b11, b15, b55 };
    },
    w = 3,
    f0 = 3000,
    { world, box } = single({}, [f0, w, 1], mesh, m),
    heave = [],
    pitch = [];
  for (let f = 1; f <= 40 * 60; f++) {
    world.advance(f);
    heave.push(box.position[1] - rest);
    pitch.push(2 * box.rotation[2]);
  }
  const [X1, X5] = amplitudes([heave, pitch], w, 25 * 60),
    k = strips(w),
    [P1, P5] = solve2(
      [c11 - w * w * (m + k.a11), w * k.b11],
      [c15 - w * w * k.a15, w * k.b15],
      [c51 - w * w * k.a15, w * k.b15],
      [c55 - w * w * (izz + k.a55), w * k.b55],
      [0, -f0],
      [0, 0],
    );
  // The test tells the coupling's sign: with it turned round, the pitch would be far off.
  const [, F5] = solve2(
    [c11 - w * w * (m + k.a11), w * k.b11],
    [c15 + w * w * k.a15, -w * k.b15],
    [c51 + w * w * k.a15, -w * k.b15],
    [c55 - w * w * (izz + k.a55), w * k.b55],
    [0, -f0],
    [0, 0],
  );
  assert.ok(
    Math.hypot(F5[0] - P5[0], F5[1] - P5[1]) > 0.5 * Math.hypot(...P5),
    'a turned coupling would pitch otherwise',
  );
  assert.ok(Math.hypot(P5[0], P5[1]) > (0.1 * Math.hypot(P1[0], P1[1])) / L, 'the hull pitches noticeably');
  for (const [got, want, what] of [
    [X1, P1, 'heave'],
    [X5, P5, 'pitch'],
  ])
    assert.ok(
      Math.hypot(got[0] - want[0], got[1] - want[1]) <= 0.03 * Math.hypot(...want),
      `${what}: ${got} against ${want}`,
    );
});

/** A box hull of `size` alone in still water of `density`, its body of `massProperties`, let go at `position` and `rotation`. */
function released(size, massProperties, position, rotation, options = {}, density = SEA_WATER) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -GRAVITY, 0] }),
    box = physics.addBody(null, {
      position,
      rotation,
      colliders: { shape: 'box', halfExtents: size.map((s) => s / 2), massProperties },
    }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(new HullSolver(), {
        hulls: [{ row: box.row, mesh: boxMesh(size) }],
        sea: { density, elevation: () => 0 },
        ...options,
      })
      .couple(['hull', 'rigid'], 'staggered');
  return { world, box };
}

/** The peaks of |x| in `signal`, one a half cycle (where the sign turns), from the value let go at. */
function swings(signal, start) {
  const peaks = [];
  let best = Math.abs(start),
    sign = Math.sign(start);
  for (const x of signal) {
    if (Math.sign(x) === -sign && x !== 0) {
      peaks.push(best);
      best = 0;
      sign = -sign;
    }
    if (Math.sign(x) === sign) best = Math.max(best, Math.abs(x));
  }
  return peaks;
}

test('HullSolver: held up by its buoyancy alone, a hull heaves and rolls on at the amplitude it was let go at', () => {
  // With neither added mass, radiation nor roll damping, nothing takes energy away: the load must be taken where a load held
  // through the rigid step neither feeds the motion nor drains it. The rigid step moves a body by (v + F dt (s + 1) /
  // (2 s m)) dt over its s substeps, so that is (s - 1) / (2 s) of the step, not its middle; taken at the middle, this box
  // lost 31 percent of its heave in 8 cycles at 60 steps a second (a numerical damping of pi w dt / (2 s) a cycle). Its centre
  // of mass is off its origin, which the pose taken on must turn about (rolling, the origin moves by w x r too).
  const [l, d, b, t] = [1, 0.1, 0.3, 0.05],
    m = 1000 * l * b * t,
    mass = {
      mass: m,
      centerOfMass: [0, 0.0125, 0],
      principalInertia: [0.236, (m * (l * l + b * b)) / 12, (m * (l * l + d * d)) / 12],
    },
    off = { addedMass: false, radiation: false, rollDamping: false },
    heave = released([l, d, b], mass, [0, d / 2 - t + 0.01, 0], [0, 0, 0, 1], off, 1000),
    angle = (10 * Math.PI) / 180,
    roll = released([l, d, b], mass, [0, d / 2 - t, 0], [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)], off, 1000),
    rest = d / 2 - t,
    [ys, rs] = [[], []];
  for (let f = 1; f <= 6 * 60; f++) {
    heave.world.advance(f);
    roll.world.advance(f);
    ys.push(heave.box.position[1] - rest);
    rs.push(2 * Math.asin(roll.box.rotation[0]));
  }
  const up = swings(ys, 0.01).slice(0, 17),
    over = swings(rs, angle).slice(0, 13);
  assert.ok(up.length === 17 && over.length === 13, `whole swings: ${up.length}, ${over.length}`);
  for (const [peaks, from, what] of [
    [up, 0.01, 'heave'],
    [over, angle, 'roll'],
  ])
    for (const p of peaks) assert.ok(Math.abs(p - from) <= 0.01 * from, `${what} swings at ${p} against ${from}`);
});

test("HullSolver: a box let go heeled rolls down as Jung, Chang and Jo's measured box did", () => {
  // Jung, Chang and Jo, "Viscous effect on the roll motion of a rectangular structure", J. Eng. Mech. 132(2), 2006, as Gu et
  // al. report it (STAB 2015): a box 0.3 m wide, 0.1 m high, at 0.05 m draft in fresh water, let go at 15 degrees, measured
  // a natural period of 0.93 s, an added roll inertia of 0.124 kg m^2/m and an equivalent linear damping b = 0.519 N m s/m
  // from the trendline of its decay, d(phi) a swing = K phi_m (Bhattacharyya 1978; b = K T Delta GM / pi^2). Gu et al. give
  // its roll inertia, 0.236 kg m^2/m; its centre of gravity is not published, so it is the one the measured period gives
  // (GM = w^2 I' / (m g) = 0.1125 m, KG = 0.0625 m). Nothing here is fitted to the decay: the damping is the radiation
  // memory and Ikeda's eddy and Kato's friction components (ITTC 7.5-02-07-04.5), from the box's shape alone.
  // Measured here: K 0.307 against the box's 0.333 (7.7 percent less; Ikeda's eddy formula is an empirical fit to 2-D
  // models, and Standing 1991 found it low on barges) and a period of 0.900 s (potential flow gives the box 0.097 kg m^2/m
  // of added roll inertia, the experiment 0.124, Gu et al.'s viscous flow 0.128), so bounds of 12 and 5 percent. Without
  // the viscous part the box rolls on with K 0.095, under a third of what was measured.
  const [l, d, b, t] = [1, 0.1, 0.3, 0.05],
    m = 1000 * l * b * t,
    gm = 0.1125,
    mass = {
      mass: m,
      centerOfMass: [0, 0.0625 - d / 2, 0],
      principalInertia: [0.236 * l, (m * (l * l + b * b)) / 12, (m * (l * l + d * d)) / 12],
    },
    angle = (15 * Math.PI) / 180,
    decay = (options) => {
      const { world, box } = released(
          [l, d, b],
          mass,
          [0, d / 2 - t, 0],
          [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)],
          { viscosity: 1.0e-6, ...options },
          1000,
        ),
        roll = [],
        times = [];
      let last = 0;
      for (let f = 1; f <= 8 * 60; f++) {
        world.advance(f);
        const now = 2 * Math.asin(box.rotation[0]);
        if (last > 0 && now <= 0) times.push(f - now / (now - last));
        last = now;
        roll.push(now);
      }
      // The trendline through the origin of each swing's loss against its mean, down to 0.5 degrees.
      const peaks = swings(roll, angle).map((p) => (p * 180) / Math.PI);
      let xy = 0,
        xx = 0;
      for (let i = 0; i + 1 < peaks.length && peaks[i + 1] > 0.5; i++) {
        const mean = (peaks[i] + peaks[i + 1]) / 2;
        xy += mean * (peaks[i] - peaks[i + 1]);
        xx += mean * mean;
      }
      return { K: xy / xx, period: (times.at(-1) - times[0]) / (times.length - 1) / 60 };
    },
    measured = (0.519 * Math.PI * Math.PI) / (0.93 * m * GRAVITY * gm),
    full = decay({}),
    potential = decay({ rollDamping: false });
  assert.ok(Math.abs(full.K - measured) <= 0.12 * measured, `K ${full.K} against the measured ${measured}`);
  assert.ok(Math.abs(full.period - 0.93) <= 0.05 * 0.93, `period ${full.period} s against the measured 0.93 s`);
  assert.ok(potential.K < measured / 3, `without its eddies and friction: K ${potential.K}`);
});
