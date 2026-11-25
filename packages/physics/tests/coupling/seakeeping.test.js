// The hull solver's coupling checks (docs/physics-framework.md, section 10): `HullSolver` before `RigidSolver`, a box hull on
// a regular wave, held to the harness (the same state at 24, 30 and 60 frames a second, a seek equal to a continuous run),
// the load reaching the hull it names, and a box let go above its draft heaving at the period its buoyancy gives it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { GRAVITY, HullSolver, heaveSection, lewisForm, SEA_WATER } from '../../dist/seakeeping.js';
import { BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

/** A box hull of `size` (x, y, z), each face a 4 by 4 grid, wound outward. */
function boxMesh([sx, sy, sz]) {
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
        vertices.push(...p);
      }
    const at = (i, j) => first + i * (n + 1) + j;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (const t of [
          [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
          [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
        ]) {
          const p = t.map((k) => vertices.slice(3 * k, 3 * k + 3)),
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

/** A solver that drives body `row` up and down with f0 sin(w t), t the middle of each step. */
function driver(row, f0, w) {
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
      words[row * FORCE_WORDS + 1] = f0 * Math.sin((w * (context.tick + 0.5)) / 60);
    },
    exportPorts: (tick) => [{ field: 'bodyForces', region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

/** A box hull alone in still water, its own world, driven by `drive` when given. */
function single(options = {}, drive) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    box = physics.addBody(null, {
      position: [0, D / 2 - T, 0],
      colliders: { shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass: SEA_WATER * L * B * T },
    }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(new HullSolver(), {
      hulls: [{ row: box.row, mesh: boxMesh([L, D, B]) }],
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
  // radiation memory, Cummins 1962) must give the frequency-domain answer. Its own errors: the kernel taken from 40
  // frequencies with B(w) linear between them, and the step (the load taken at its middle, O((w dt)^2)); measured 0.6, 1.5
  // and 2.1 percent at 60 steps a second (1 percent at 240), so a bound of 3 percent.
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
