// The hull solver's coupling checks (docs/physics-framework.md, section 10): `HullSolver` before `RigidSolver`, a box hull on
// a regular wave, held to the harness (the same state at 24, 30 and 60 frames a second, a seek equal to a continuous run),
// the load reaching the hull it names, and a box let go above its draft heaving at the period its buoyancy gives it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import {
  GRAVITY,
  HULL_BREACH_WORDS,
  HULL_BREACHES_FIELD,
  HullSolver,
  heaveSection,
  lateralSection,
  lewisForm,
  SEA_WATER,
  volumeBelow,
  wettedLoads,
} from '../../dist/seakeeping.js';
import { SpectralSea } from '../../dist/sea.js';
import { freeSection, vHull } from './sections.js';
import {
  BODY_FORCES_FIELD,
  DECK_CLAIMS_FIELD,
  DECK_INFLOW_FIELD,
  DECK_INFLOW_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  RigidSolver,
} from '../../dist/world.js';
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

test("HullSolver: on a SpectralSea's long swell, a box rides up and down as its frequency-domain response says", () => {
  // The framework's sea (SpectralSea, @margoengine/physics/sea) as the hull's: one wave of 0.3 m at about 0.049 Hz (a
  // 20.6 s swell, 650 m long), from a spectrum with all its energy in one bin. In waves this long the box's heave is
  // X = (C - w^2 A(w) + i w B(w)) e^(-k T) E / (C - (m + A(w)) w^2 + i w B(w)), E the surface's own motion over the box
  // (fitted from the sea), C the waterplane's stiffness, e^(-k T) the waves' pressure at the keel (Froude-Krylov, Smith's
  // correction) and A, B the box's heave added mass and damping (Ursell-Tasai), which the relative motion principle also
  // gives the diffraction (a two-dimensional section's added mass grows as the frequency falls, so even this swell's
  // diffraction is 4 percent of its load); a box 4 m long in a 650 m wave takes the wave as one (sinc(k L / 2) =
  // 1 - 6e-5); the surface is taken over the box as it moves. Measured 0.04 percent: a bound of 1 percent.
  const nf = 34,
    nd = 24,
    frequencies = Float64Array.from({ length: nf }, (_, i) => 0.04 * (1 / 0.04) ** (i / (nf - 1))),
    directions = Float64Array.from({ length: nd }, (_, j) => (2 * Math.PI * j) / nd),
    energy = new Float64Array(nf * nd),
    [i, a] = [2, 0.3],
    df = (frequencies[i + 1] - frequencies[i - 1]) / 2;
  energy[i * nd] = (a * a) / (2 * df * ((2 * Math.PI) / nd));
  const sea = new SpectralSea({
      waves: { frequencies, directions, energy, depth: Infinity, density: SEA_WATER },
      seed: 7,
      gravity: GRAVITY,
    }),
    w = 2 * Math.PI * frequencies[i],
    k = (w * w) / GRAVITY,
    { world, box } = single({ sea }),
    rest = D / 2 - T,
    heave = [],
    surface = [];
  // Nothing holds a floating box along the wave: let go at rest in moving water, it would drift with the difference and
  // see the swell further along. It starts with the water's motion at its place, as a body long afloat has.
  box.setLinearVelocity(sea.sample(0, 0, 0).velocity);
  for (let f = 1; f <= 100 * 60; f++) {
    world.advance(f);
    heave.push(box.position[1] - rest);
    surface.push(sea.elevation(box.position[0], box.position[2], f / 60));
  }
  const [X, E] = amplitudes([heave, surface], w, 40 * 60),
    s = heaveSection(lewisForm(B, T, B * T), w, SEA_WATER, GRAVITY),
    m = SEA_WATER * L * B * T,
    C = SEA_WATER * GRAVITY * L * B,
    h = solve2(
      [C - (m + s.addedMass * L) * w * w, w * s.damping * L],
      [0, 0],
      [0, 0],
      [1, 0],
      // Froude-Krylov and the diffraction of the relative motion principle, eq. 8.47 (along = L sinc(k L / 2)).
      [
        (C - w * w * s.addedMass * L) * Math.exp(-k * T) * ((2 / (k * L)) * Math.sin((k * L) / 2)),
        w * s.damping * L * Math.exp(-k * T) * ((2 / (k * L)) * Math.sin((k * L) / 2)),
      ],
      [0, 0],
    )[0],
    want = [h[0] * E[0] - h[1] * E[1], h[0] * E[1] + h[1] * E[0]];
  assert.ok(Math.abs(Math.hypot(...E) - a) <= 0.01 * a, `the sea's swell: ${Math.hypot(...E)} m`);
  assert.ok(Math.hypot(X[0] - want[0], X[1] - want[1]) <= 0.01 * Math.hypot(...want), `heave ${X} against ${want}`);
  // A sea made in another origin cell is refused, naming the fix.
  const far = single({ sea: Object.assign(Object.create(sea), { cell: [1, 0, 0] }) });
  assert.throws(
    () => far.world.advance(1),
    (error) => error.code === 'state' && /make the sea in the hull's cell/.test(error.message),
  );
});

/** A SpectralSea of one wave of amplitude `a` and angular frequency near `w` along x (the spectrum's bin nearest), deep. */
function oneWave(a, w, seed = 3, direction = 0) {
  const nf = 34,
    nd = 24,
    lo = Math.log(0.04),
    // A grid whose bin `i` sits exactly at w / 2 pi, the rest log-spaced around it.
    f = w / (2 * Math.PI),
    i = 17,
    step = (Math.log(f) - lo) / i,
    frequencies = Float64Array.from({ length: nf }, (_, n) => Math.exp(lo + n * step)),
    directions = Float64Array.from({ length: nd }, (_, j) => (2 * Math.PI * j) / nd),
    energy = new Float64Array(nf * nd),
    df = (frequencies[i + 1] - frequencies[i - 1]) / 2;
  energy[i * nd + direction] = (a * a) / (2 * df * ((2 * Math.PI) / nd));
  return new SpectralSea({
    waves: { frequencies, directions, energy, depth: Infinity, density: SEA_WATER },
    seed,
    gravity: GRAVITY,
  });
}

test("HullSolver: in head seas a box heaves as strip theory's relative motion principle says, diffraction with it", () => {
  // Journee and Massie eqs. 8.45-8.47: each section takes the Froude-Krylov load (from the pressure over the wetted surface)
  // and the diffraction load M33'(w) z*'' + N33'(w) z*', z* the wave's motion at the depth of the section's mean wave
  // pressure (for a box section in head seas exactly its draft, z* = e^(-k T) z). Its heave is then
  //   X = int (rho g B - w^2 a33' + i w b33') e^(-k T) E e^(-i k x) dx / (C - (m + A33) w^2 + i w B33),
  // E the wave over the box's centre (fitted from the sea), heave and pitch apart for a box even fore and aft. The
  // equations' box is free in heave and pitch alone, and so is this one (a floating box would drift through the wave's
  // phase). Measured 0.5, 0.6 and 1.0 percent off at 60 steps a second, and 82 to 267 percent without the diffraction: a
  // bound of 3 percent.
  for (const w of [2.5, 3, 3.5]) {
    const sea = oneWave(0.05, w),
      k = (w * w) / GRAVITY,
      run = (options) => {
        const { world, box } = single({ sea, ...options }),
          rest = D / 2 - T,
          heave = [],
          surface = [];
        // Free in heave and pitch alone, as the equations are: nothing holds a floating box along the wave, which would
        // drift it through the wave's phase.
        box.enabledTranslations = [false, true, false];
        box.enabledRotations = [false, false, true];
        for (let f = 1; f <= 40 * 60; f++) {
          world.advance(f);
          heave.push(box.position[1] - rest);
          surface.push(sea.elevation(box.position[0], box.position[2], f / 60));
        }
        return amplitudes([heave, surface], w, 20 * 60);
      },
      [X, E] = run({}),
      [Y] = run({ diffraction: false }),
      s = heaveSection(lewisForm(B, T, B * T), w, SEA_WATER, GRAVITY),
      m = SEA_WATER * L * B * T,
      C = SEA_WATER * GRAVITY * L * B,
      along = (2 / k) * Math.sin((k * L) / 2),
      force = [
        (SEA_WATER * GRAVITY * B - w * w * s.addedMass) * Math.exp(-k * T) * along,
        w * s.damping * Math.exp(-k * T) * along,
      ],
      F = [force[0] * E[0] - force[1] * E[1], force[0] * E[1] + force[1] * E[0]],
      [want] = solve2([C - (m + s.addedMass * L) * w * w, w * s.damping * L], [0, 0], [0, 0], [1, 0], F, [0, 0]),
      off = (got) => Math.hypot(got[0] - want[0], got[1] - want[1]) / Math.hypot(...want);
    assert.ok(Math.abs(Math.hypot(...E) - 0.05) <= 1e-3 * 0.05, `the sea's wave: ${Math.hypot(...E)} m`);
    assert.ok(off(X) <= 0.03, `at ${w} rad/s, heave ${X} against ${want}`);
    assert.ok(off(Y) > 0.5, `without diffraction the heave is far off: ${Y}`);
  }
});

test('HullSolver: held in beam seas a box takes the Froude-Krylov and diffraction loads in sway and roll', () => {
  // The waves along z (beam on). Held still, the hull's load is the Froude-Krylov force and moment (the pressure over the
  // wetted surface) and the diffraction of each section, (i w a(w) + b(w)) U in sway and in the sway-roll coupling, U the
  // water's horizontal velocity at the section's centroid depth: the load the solver hands the rigid solver must be that
  // (the added-mass fold off, the body held by its locks). The motions these loads drive are the driven test's; a box free
  // in sway is not compared, as the waves' mean drift (second order, from the pressure over the moving wetted surface)
  // pushes it away, and one held by locks the solver does not know of is not the equations' body. Measured 0.1 to 1.5
  // percent off, and 50 to 390 percent without the diffraction: a bound of 3 percent.
  const rho = SEA_WATER,
    m = rho * L * B * T,
    form = lewisForm(B, T, B * T),
    pivot = T - D / 2,
    rest = D / 2 - T,
    mesh = boxMesh([L, D, B]);
  for (const w of [2.5, 3.5]) {
    const sea = oneWave(0.05, w, 5, 6),
      run = (seconds) => {
        const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
          box = physics.addBody(null, {
            position: [0, rest, 0],
            colliders: { shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass: m },
          }),
          hull = new HullSolver(),
          world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
            .add(new RigidSolver(), { physics })
            .add(hull, { hulls: [{ row: box.row, mesh }], sea, rollDamping: false, addedMass: false })
            .couple(['hull', 'rigid'], 'staggered');
        box.enabledTranslations = [false, false, false];
        box.enabledRotations = [false, false, false];
        const [fz, mx] = [[], []];
        for (let f = 1; f <= seconds * 60; f++) {
          world.advance(f);
          const { region } = hull.exportPorts(0)[0],
            held = new Float64Array(world.memory.buffer, region.byteOffset + box.row * FORCE_WORDS * 8, FORCE_WORDS);
          fz.push(held[2]);
          mx.push(held[3]);
        }
        return { fz, mx };
      },
      s = lateralSection(form, w, rho, pivot, GRAVITY),
      a24 = (s.rollOfSway.addedMass + s.swayOfRoll.addedMass) / 2,
      b24 = (s.rollOfSway.damping + s.swayOfRoll.damping) / 2,
      times = (c, z) => [c[0] * z[0] - c[1] * z[1], c[0] * z[1] + c[1] * z[0]],
      add = (a, b) => [a[0] + b[0], a[1] + b[1]],
      off = (got, want) => Math.hypot(got[0] - want[0], got[1] - want[1]) / Math.hypot(...want),
      // The Froude-Krylov load on the box at rest and the water's velocity at its centroid depth, at the steps' middles.
      [fk2, fk4, u] = [[], [], []];
    for (let f = 1; f <= 40 * 60; f++) {
      const t = (f - 0.5) / 60,
        loads = wettedLoads(mesh, { position: [0, rest, 0], rotation: [0, 0, 0, 1] }, sea, t, [0, rest, 0]);
      fk2.push(loads.force[2]);
      fk4.push(loads.torque[0]);
      u.push(sea.water.sample(0, -T / 2, 0, t).velocity[2]);
    }
    const fitHalf = (signals, from) =>
        amplitudes(signals, w, from).map(([c, d]) => {
          // amplitudes() takes sample f at f / 60; these are at (f - 1/2) / 60: turn the phase back by w / 120.
          const r = [Math.cos(w / 120), -Math.sin(w / 120)];
          return times([c, d], r);
        }),
      [F2, M4, U] = fitHalf([fk2, fk4, u], 20 * 60),
      want2 = add(F2, times([s.sway.damping * L, w * s.sway.addedMass * L], U)),
      want4 = add(M4, times([b24 * L, w * a24 * L], U)),
      held = run(40),
      // The solver takes the sea at each step's middle: the held load is fitted at those times too.
      [G2, G4] = fitHalf([held.fz, held.mx], 20 * 60);
    assert.ok(off(G2, want2) <= 0.03, `at ${w} rad/s, sway force ${G2} against ${want2}`);
    assert.ok(off(G4, want4) <= 0.03, `at ${w} rad/s, roll moment ${G4} against ${want4}`);
    assert.ok(off(F2, want2) > 0.3 && off(M4, want4) > 0.3, 'without the diffraction the loads are far off');
  }
});

test('HullSolver: moored in beam waves, a box drifts with the waves it sends back, as a wall does in short ones', () => {
  // The mean drift of a section in beam waves is the momentum the waves carry, 1/2 rho g a^2 |R|^2 per metre (Maruo; a wall
  // sending everything back takes 1/2 rho g a^2, Journee and Massie eq. 6.106), R the wave it sends back free. A deep box
  // (4 m wide, 2 m draft, 3 m high: it stands upright), 4 m long, held on a soft damped mooring across the waves, in one
  // wave of 0.05 m: its mean offset times the mooring's stiffness is the drift. R from the free section's two-dimensional
  // scattering (the energy test's): the time domain's mean (the Froude-Krylov pressure over its moving surface and the
  // solver's drift, which is the far field less the part that pressure gives) must be the far field. Measured, as parts
  // of the wall's 1/2 rho g a^2 L: 0.855 against 0.873 at 3 rad/s, 0.998 against 1.000 at 8.7, and 0.043 against 0.002 in
  // the long wave at 1.2 (the residual of the motions the time domain gives against the frequency domain's): bounds of 3
  // percent of the wall's at 3 and 8.7, and the long wave under 6 percent.
  const [L, D, B, T] = [4, 3, 4, 2],
    a = 0.05,
    m = SEA_WATER * L * B * T,
    wall = 0.5 * SEA_WATER * GRAVITY * a * a * L;
  for (const w of [1.2, 3, 8.7]) {
    const sea = oneWave(a, w, 5, 6),
      physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -GRAVITY, 0] }),
      box = physics.addBody(null, {
        position: [0, D / 2 - T, 0],
        colliders: { shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass: m },
      });
    // Across the waves (z), heave and roll; a mooring of natural period 31 s, damped at 0.3 of critical.
    box.enabledTranslations = [false, true, true];
    box.enabledRotations = [true, false, false];
    const k = 1.5 * m * 0.2 * 0.2,
      c = 2 * 0.3 * 0.2 * 1.5 * m;
    physics.on('beforestep', (dt) => box.applyImpulse([0, 0, (-k * box.position[2] - c * box.linearVelocity[2]) * dt]));
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(new HullSolver(), { hulls: [{ row: box.row, mesh: boxMesh([L, D, B]) }], sea, rollDamping: false })
      .couple(['hull', 'rigid'], 'staggered');
    let sum = 0,
      n = 0;
    for (let f = 1; f <= 200 * 60; f++) {
      world.advance(f);
      if (f > 80 * 60) {
        sum += box.position[2];
        n++;
      }
    }
    const mean = (k * sum) / n,
      r = Math.hypot(...freeSection([B, T, D], w).scattered.reflected),
      far = wall * r * r;
    if (w < 2) assert.ok(mean < 0.06 * wall, `at ${w} rad/s the long wave barely drifts it: ${mean} N`);
    else assert.ok(Math.abs(mean - far) <= 0.03 * wall, `at ${w} rad/s: mean drift ${mean} N against ${far} N`);
  }
});

test("HullSolver: held with its deck under still water, a box's deck fills to the sea, and a liquid that claims the deck takes its load", () => {
  // Green water's quasi-static case: a box held 0.2 m deeper than its deck. The sea comes over its edges (Ritter's dam break
  // at each), fills the deck to the still-water level, and stands there: the hull then takes the whole submerged box's
  // buoyancy, rho g D L B, the deck water's weight standing in for the pressure its deck would have from the sea (the deck's
  // faces take none of their own while there is deck water to count). The water coming aboard is published in
  // `deckInflow`. A liquid solver that owns the deck (`deckClaims` 1 at the box's row) takes the on-deck load itself, and
  // the hull solver leaves its own out: the hull then holds only the sea's pressure on its sides and bottom.
  const [l, d, b] = [4, 1, 2],
    sink = 0.2,
    run = (claimed) => {
      const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -GRAVITY, 0] }),
        body = physics.addBody(null, {
          position: [0, -d / 2 - sink, 0],
          colliders: { shape: 'box', halfExtents: [l / 2, d / 2, b / 2], mass: 1000 },
        });
      body.enabledTranslations = [false, false, false];
      body.enabledRotations = [false, false, false];
      const hull = new HullSolver(),
        world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(hull, {
          hulls: [{ row: body.row, mesh: boxMesh([l, d, b]) }],
          sea: { density: SEA_WATER, elevation: () => 0 },
          addedMass: false,
          radiation: false,
          rollDamping: false,
        });
      if (claimed) world.add(claimer(body.row), {}).couple(['claims', 'hull', 'rigid'], 'staggered');
      else world.couple(['hull', 'rigid'], 'staggered');
      let came = 0,
        row = -1;
      for (let f = 1; f <= 600; f++) {
        world.advance(f);
        const port = hull.exportPorts(0)[1],
          records = new Float64Array(world.memory.buffer, port.region.byteOffset, port.region.byteLength / 8);
        for (let r = 0; r < records[0]; r++) {
          const o = 1 + r * DECK_INFLOW_WORDS;
          came += records[o + 14] / 60;
          row = records[o];
        }
      }
      const held = new Float64Array(
        world.memory.buffer,
        hull.exportPorts(0)[0].region.byteOffset + body.row * 48,
        6,
      )[1];
      return { held, came, row, row0: body.row };
    },
    open = run(false),
    owned = run(true),
    whole = SEA_WATER * GRAVITY * d * l * b,
    sides = SEA_WATER * GRAVITY * (d + sink) * l * b;
  assert.ok(Math.abs(open.held - whole) <= 1e-4 * whole, `the hull holds ${open.held} N against ${whole} N`);
  assert.ok(open.row === open.row0, 'the inflow names the hull');
  // The port counts what came over the edges, and some ran back out before the deck settled: at least what it holds.
  assert.ok(open.came >= 0.999 * sink * l * b, `${open.came} m^3 came aboard, the deck holds ${sink * l * b}`);
  assert.ok(Math.abs(owned.held - sides) <= 1e-4 * sides, `claimed: the hull holds ${owned.held} N against ${sides} N`);
});

/** A stand-in for a liquid solver that owns hull `row`'s on-deck load: it writes 1 into `deckClaims` there. */
function claimer(row) {
  let region, host;
  return {
    describe: () => ({
      id: 'claims',
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: DECK_CLAIMS_FIELD, access: 'write' },
        { field: DECK_INFLOW_FIELD, access: 'read' },
      ],
    }),
    init(h) {
      host = h;
      region = h.allocate('claims', (row + 1) * 8, 'f64', 1);
    },
    step() {
      new Float64Array(host.memory.buffer, region.byteOffset, row + 1)[row] = 1;
    },
    exportPorts: (tick) => [{ field: 'deckClaims', region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('HullSolver: a wedge coming down into still water at a steady speed slams as Wagner says, until its chine is wet', () => {
  // A 30 degree V hull 4 m long, 1 m half-breadth at its chine, so heavy (and with the rigid world's gravity off) that it
  // enters at a steady 2 m/s: the slamming force (the hull's load with slamming less without) is Wagner's, rho pi^3 V^2 h L /
  // (4 tan(beta)^2) at its depth h when the load is taken, 7/16 of each step on; once the chine is wet the flow leaves the
  // hull and the impact ends (past one level of the section's table beyond it). Measured within 0.02 percent at 60 steps a
  // second: a bound of 0.1 percent.
  const beta = Math.PI / 6,
    b = 1,
    length = 4,
    speed = 2,
    rho = 1025,
    mesh = vHull(beta, b, length),
    run = (slamming) => {
      const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
        body = physics.addBody(null, {
          position: [0, 0.001, 0],
          linearVelocity: [0, -speed, 0],
          colliders: { shape: 'box', halfExtents: [length / 2, 0.3, b], mass: 1e7 },
        });
      body.enabledRotations = [false, false, false];
      const hull = new HullSolver(),
        world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(hull, {
          hulls: [{ row: body.row, mesh }],
          sea: { density: rho, elevation: () => 0 },
          gravity: [0, 0, 0],
          addedMass: false,
          radiation: false,
          rollDamping: false,
          greenWater: false,
          slamming,
        });
      const out = [];
      for (let f = 1; f <= 15; f++) {
        const before = -body.position[1],
          v = -body.linearVelocity[1];
        world.advance(f);
        out.push({
          depth: before + (7 / 16) * v * (1 / 60),
          v,
          held: new Float64Array(world.memory.buffer, hull.exportPorts(0)[0].region.byteOffset + body.row * 48, 6)[1],
        });
      }
      return out;
    },
    on = run(true),
    off = run(false),
    chine = (2 * b * Math.tan(beta)) / Math.PI;
  for (let k = 1; k < on.length; k++) {
    const { depth, v } = on[k],
      slam = on[k].held - off[k].held;
    if (depth < chine - 0.01) {
      const wagner = (rho * Math.PI ** 3 * v * v * depth * length) / (4 * Math.tan(beta) ** 2);
      assert.ok(Math.abs(slam - wagner) <= 0.001 * wagner, `at ${depth} m: ${slam} N against Wagner's ${wagner} N`);
    } else if (depth > chine + 0.025) {
      // What is left is the runs' own difference (the slam slowed the body a little, so its buoyancy differs).
      const atChine = (rho * Math.PI ** 3 * v * v * chine * length) / (4 * Math.tan(beta) ** 2);
      assert.ok(Math.abs(slam) < 1e-3 * atChine, `past the chine, ${slam} N`);
    }
  }
});

/**
 * A 20 by 4 by 8 m box barge floating at 2 m (its centre of mass in its middle) with a wing tank on its starboard side,
 * x -5 to 5, the full depth, z 2.5 to 4, holed in its side at the bottom and vented in its top; `rate` frames a second.
 */
function floodedBarge(rate = { num: 60, den: 1 }) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    mass = SEA_WATER * 20 * 8 * 2,
    body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [10, 2, 4], mass } }),
    hull = new HullSolver(),
    world = new PhysicsWorld({ rate })
      .add(hull, {
        hulls: [
          {
            row: body.row,
            mesh: boxMesh([20, 4, 8]),
            compartments: [{ mesh: boxMesh([10, 4, 1.5], [0, 0, 3.25]) }],
            openings: [
              { from: 0, to: 'outside', centre: [0, -1.5, 4], normal: [0, 0, 1], width: 2, height: 0.5 },
              { from: 0, to: 'outside', centre: [0, 2, 3.25], normal: [0, 1, 0], width: 0.3, height: 0.3 },
            ],
          },
        ],
        sea: { density: SEA_WATER, elevation: () => 0 },
        greenWater: false,
      })
      .add(new RigidSolver(), { physics })
      .couple(['hull', 'rigid'], 'staggered');
  return Object.assign(world, { body, hull, mass });
}

test('HullSolver: a barge holed in a wing tank heels and sinks to the lost-buoyancy equilibrium', () => {
  // The floodwater as added weight (the tank's water, its level square to gravity, at its centre) comes to rest where
  // the hydrostatics of lost buoyancy put it: the hull's displacement less the tank's under the sea equal to the barge's
  // mass, its centre under the centre of mass. Measured at 120 s: heel 13.70066 against 13.70085 degrees, sinkage within
  // 0.04 mm.
  const world = floodedBarge(),
    { body, mass } = world;
  for (let f = 1; f <= 120 * 60; f++) world.advance(f);
  const hull = boxMesh([20, 4, 8]),
    tank = boxMesh([10, 4, 1.5], [0, 0, 3.25]),
    // Heeled phi about x at height h: the body's frame's up is (0, cos, -sin); the sea's surface is the plane u . p = -h.
    lost = (h, phi) => {
      const u = [0, Math.cos(phi), -Math.sin(phi)],
        mh = [0, 0, 0],
        mt = [0, 0, 0],
        v = volumeBelow(hull, u, -h, mh) - 0.95 * volumeBelow(tank, u, -h, mt),
        m = [0, 1, 2].map((k) => mh[k] - 0.95 * mt[k]);
      return [v - mass / SEA_WATER, m[1] * Math.sin(phi) + m[2] * Math.cos(phi)];
    };
  let h = 0,
    phi = 0;
  for (let it = 0; it < 40; it++) {
    const f0 = lost(h, phi),
      e = 1e-7,
      fh = lost(h + e, phi),
      fp = lost(h, phi + e),
      J = [(fh[0] - f0[0]) / e, (fp[0] - f0[0]) / e, (fh[1] - f0[1]) / e, (fp[1] - f0[1]) / e],
      det = J[0] * J[3] - J[1] * J[2];
    h -= (J[3] * f0[0] - J[1] * f0[1]) / det;
    phi -= (-J[2] * f0[0] + J[0] * f0[1]) / det;
  }
  const heel = (2 * Math.asin(body.rotation[0]) * 180) / Math.PI,
    want = (phi * 180) / Math.PI;
  assert.ok(want > 13 && want < 14.5, `the statics heel it ${want} degrees`);
  assert.ok(Math.abs(heel - want) < 1e-3, `heeled ${heel} degrees against ${want}`);
  assert.ok(Math.abs(body.position[1] - h) < 1e-4, `sunk to ${body.position[1]} m against ${h}`);
});

test('HullSolver: a flooding hull writes its breaches: the sea coming in, the air going out, where they are', () => {
  const world = floodedBarge(),
    { body, hull } = world;
  for (let f = 1; f <= 30; f++) world.advance(f);
  const port = hull.exportPorts(world.tick).find((p) => p.field === HULL_BREACHES_FIELD.name),
    words = new Float64Array(world.memory.buffer, port.region.byteOffset, port.region.byteLength / 8);
  assert.equal(words[0], 2, 'one record an opening to the outside');
  const record = (k) => words.subarray(1 + k * HULL_BREACH_WORDS, 1 + (k + 1) * HULL_BREACH_WORDS),
    [breach, vent] = [record(0), record(1)],
    q = body.rotation,
    turn = (v) => {
      const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
      return [
        v[0] + q[3] * t[0] + (q[1] * t[2] - q[2] * t[1]),
        v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]),
        v[2] + q[3] * t[2] + (q[0] * t[1] - q[1] * t[0]),
      ];
    };
  assert.equal(breach[0], body.row);
  assert.deepEqual([breach[1], vent[1]], [0, 1]);
  // The breach's centre and normal in the world (the pose its last step took, a little behind the body's now).
  const centre = turn([0, -1.5, 4]).map((c, k) => c + body.position[k]);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(breach[2 + k] - centre[k]) < 0.01, `centre ${k}: ${breach[2 + k]}`);
  assert.ok(Math.abs(Math.hypot(breach[5], breach[6], breach[7]) - 1) < 1e-12 && breach[7] > 0.9);
  assert.equal(breach[8], 1, 'its open area, 2 by 0.5 m');
  assert.ok(breach[9] < -1, `the sea comes in: ${breach[9]} m^3/s`);
  assert.ok(vent[10] > 0 && Math.abs(vent[11] - vent[10] / 1.225) < 1e-15, `air out: ${vent[10]} kg/s`);
  assert.deepEqual([breach[12], breach[13]], [0, 0], 'no cargo');
  assert.ok(breach[14] > 1 && vent[14] < 0, 'the breach under the sea, the vent above it');
  assert.equal(breach[15], 29, 'the solver step it is for, its 30th');
});

test('HullSolver: a flooding hull, the same state at 24, 30 and 60 frames a second', () =>
  frameRateIndependent(floodedBarge));
test('HullSolver: a flooding hull, a seek equals a continuous run', () =>
  seekEqualsContinuous(() => floodedBarge({ num: 24, den: 1 })));
