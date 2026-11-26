// Bodies going into the water and out of it (SEA-14, EntrySolver): checked against measurements and closed forms. A
// sphere's slam peaks at C = F / (rho v^2 pi R^2 / 2) of about 1 at a tenth of its radius in (Shiffman and Spencer 1945
// as Antolik et al. 2023 measure it); Wagner's wetted radius of a cone is 4 h / (pi tan beta); a steel ball skips below
// Johnson and Reid's critical angle 18 degrees / sqrt(sigma) and goes in above it; a wetting sphere drags a cavity down
// above Duez et al.'s 7 m/s and not below; the cavity behind a dense sphere pinches where Aristoff et al.'s model of a
// decelerating sphere says (their eq. 17 with the deceleration the run itself shows); a light sphere floats at the
// draft Archimedes gives; a buoyant one let go under water comes up and out with an exit splash; the wake's sources move
// no water on balance; and a snapshot restores every bit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import {
  CAVITY_ALPHA,
  cavityThreshold,
  constantSpeedPinch,
  EntrySolver,
  sectionArea,
  slam,
  slamProfile,
  spheroid,
  wagnerRadius,
} from '../dist/entry.js';
import { PhysicsWorld, RigidSolver } from '../dist/world.js';

await Physics.load();
const G = 9.81,
  RHO = 1025;

/** A sphere of radius `R` as a UV mesh wound outward. */
function sphereMesh(R, nu = 48, nv = 24) {
  const vertices = [],
    indices = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const th = (Math.PI * j) / nv,
        ph = (2 * Math.PI * i) / nu;
      vertices.push(R * Math.sin(th) * Math.cos(ph), R * Math.cos(th), R * Math.sin(th) * Math.sin(ph));
    }
  const at = (i, j) => j * (nu + 1) + i;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      if (j > 0) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      if (j < nv - 1) indices.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

/** A rigid sphere of radius R and density `density` at `position` moving at `velocity`, with the entry solver. */
function drop({ R, density, position, velocity, sea = { elevation: () => 0 }, rate = 240, contactAngle, foam }) {
  const physics = new Physics(null, { fixedTimestep: 1 / rate, gravity: [0, -G, 0] }),
    mass = density * (4 / 3) * Math.PI * R ** 3,
    ball = physics.addBody(null, {
      position,
      linearVelocity: velocity,
      colliders: { shape: 'sphere', radius: R, mass },
    }),
    entry = new EntrySolver(),
    level = Math.log2(rate / 60),
    world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(entry, {
        bodies: [{ row: ball.row, mesh: sphereMesh(R), contactAngle }],
        sea,
        level,
        ...(foam ? { foam } : {}),
      })
      .couple(['entry', 'rigid'], 'staggered');
  // world.advance takes the frame to reach (at `rate` frames a second); `run(n)` moves n frames on.
  let frame = 0;
  const run = (n = 1) => world.advance((frame += n));
  return { physics, ball, entry, world, mass, run };
}

test("a sphere's slam peaks at C of about 1 a tenth to a fifth of its radius in (Shiffman and Spencer; Antolik et al.)", () => {
  const { vertices, indices } = sphereMesh(1, 96, 48);
  let peak = 0,
    at = 0;
  for (let h = 0.01; h < 0.5; h += 0.01) {
    const profile = slamProfile(vertices, indices, [0, 1, 0], -1, Math.min(2, 3.5 * h), 40),
      C = slam(profile, h, 1, 1).force / (0.5 * Math.PI);
    if (C > peak) [peak, at] = [C, h];
  }
  assert.ok(peak > 0.9 && peak < 1.1, `peak C ${peak}`);
  assert.ok(at >= 0.08 && at <= 0.2, `at h / R = ${at}`);
});

test("Wagner's wetted radius of a cone is 4 h / (pi tan beta), and a section's area is its shape's", () => {
  for (const deg of [10, 20, 35]) {
    const beta = (deg * Math.PI) / 180,
      H = 1,
      Rb = H / Math.tan(beta),
      n = 256,
      v = [0, 0, 0],
      idx = [];
    for (let i = 0; i < n; i++) v.push(Rb * Math.cos((2 * Math.PI * i) / n), H, Rb * Math.sin((2 * Math.PI * i) / n));
    v.push(0, H, 0);
    for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + ((i + 1) % n), n + 1, 1 + ((i + 1) % n), 1 + i);
    const profile = slamProfile(v, idx, [0, 1, 0], 0, 0.5, 80);
    for (const h of [0.02, 0.06]) {
      const exact = (4 * h) / (Math.PI * Math.tan(beta));
      assert.ok(Math.abs(wagnerRadius(profile, h) - exact) < 2e-3 * exact + 1e-4, `${deg} degrees at ${h}`);
    }
  }
  const { vertices, indices } = sphereMesh(2, 96, 48);
  // The sphere's section through its centre: pi R^2, to the mesh's polygon.
  assert.ok(Math.abs(sectionArea(vertices, indices, [0, 1, 0], 0) / (4 * Math.PI) - 1) < 3e-3);
});

test("a ball skips 15 percent under Johnson and Reid's critical angle and goes in 15 percent over it", () => {
  // 18 degrees / sqrt(sigma): 12.7 degrees at sigma = 2, 6.4 at 7.86 (steel). Measured on this model by bisection: 12.4
  // and 5.8 degrees.
  for (const sigma of [2, 7.86]) {
    const critical = 18 / Math.sqrt(sigma);
    for (const [deg, skips] of [
      [0.85 * critical, true],
      [1.15 * critical, false],
    ]) {
      const a = (deg * Math.PI) / 180,
        U = 30,
        { entry, run, ball } = drop({
          R: 0.05,
          density: sigma * RHO,
          position: [0, 0.0505, 0],
          velocity: [U * Math.cos(a), -U * Math.sin(a), 0],
          rate: 960,
        });
      run(240);
      const kinds = entry.splashes().map((e) => e.kind);
      assert.equal(kinds[0], 'entry', `sigma ${sigma}, ${deg.toFixed(1)} degrees: ${kinds}`);
      assert.equal(
        kinds.includes('skip'),
        skips,
        `sigma ${sigma}, ${deg.toFixed(1)} degrees: ${kinds}, at ${ball.position}`,
      );
    }
  }
});

test("a wetting sphere drags a cavity down above Duez et al.'s 7 m/s and not below, and it pinches where Aristoff et al. say", () => {
  const threshold = cavityThreshold((30 * Math.PI) / 180, 0.072, 1e-3);
  assert.ok(Math.abs(threshold - 7.2) < 1e-9);
  const slow = drop({ R: 0.0127, density: 7.86 * RHO, position: [0, 0.02, 0], velocity: [0, -5, 0], rate: 960 });
  slow.run(96);
  assert.equal(slow.entry.splashes()[0].cavity, false);
  const R0 = 0.0127,
    U0 = 9,
    fast = drop({ R: R0, density: 7.86 * RHO, position: [0, 0.014, 0], velocity: [0, -U0, 0], rate: 960 });
  let pinch = null,
    depthAt = null;
  const path = [];
  for (let step = 0; step < 960 && !pinch; step++) {
    fast.run(1);
    path.push({ t: (step + 1) / 960, y: fast.ball.position[1], u: -fast.ball.linearVelocity[1] });
    pinch = fast.entry.splashes().find((e) => e.kind === 'seal') ?? null;
    if (pinch) depthAt = { y: fast.ball.position[1], v: fast.ball.linearVelocity[1], t: pinch.time };
  }
  assert.equal(fast.entry.splashes()[0].cavity, true);
  assert.ok(pinch, 'the cavity seals');
  // Aristoff et al.'s eq. 16 (lengths in R0, times in R0 / U0 from when the centre, where the contact line is pinned, is
  // at the surface): t_pinch = min over z of (sqrt(1 - 2 L) - sqrt(1 - 2 L - 2 L z)) / L + 2 F sqrt(alpha)
  // sqrt(1 - 2 L - 2 L z) / z, with the deceleration L the run shows (U^2 = 1 - 2 L (1 + Z)).
  const F = (U0 * U0) / (G * R0),
    Z = -depthAt.y / R0,
    U = -depthAt.v / U0,
    L = (1 - U * U) / (2 * (1 + Z));
  let best = Infinity;
  for (let z = 0.01; z < Z; z += 0.001) {
    const left = 1 - 2 * L - 2 * L * z;
    if (!(left > 0)) break;
    best = Math.min(
      best,
      (Math.sqrt(1 - 2 * L) - Math.sqrt(left)) / L + (2 * F * Math.sqrt(CAVITY_ALPHA) * Math.sqrt(left)) / z,
    );
  }
  const time = best * (R0 / U0),
    since = depthAt.t - 0.014 / U0;
  // Their eq. 15 takes the collapse time where alpha U^2 F / z >> 1 (about 3 here), which shortens it: within 10 percent.
  assert.ok(
    Math.abs(since - time) < 0.1 * time,
    `pinch ${since} s after the centre went under, against ${time} s (L ${L})`,
  );
  // The model itself on the run's own path: each depth z opens at the speed the sphere had there and closes after
  // tau = (s + sqrt(s^2 + g z R0^2)) / (g z), s = sqrt(alpha) U R0; the pinch is the least t(z) + tau over the depths at
  // least two radii above the sphere.
  let model = Infinity;
  for (const p of path) {
    const z = -p.y;
    if (!(z > 0) || z > -depthAt.y - 2 * R0) continue;
    const s = Math.sqrt(CAVITY_ALPHA) * p.u * R0;
    model = Math.min(model, p.t + (s + Math.sqrt(s * s + G * z * R0 * R0)) / (G * z));
  }
  assert.ok(Math.abs(depthAt.t - model) < 0.03 * model, `pinch at ${depthAt.t} s against the model's ${model} s`);
  const still = constantSpeedPinch(U0, R0, G);
  assert.ok(since < still.time, 'a decelerating sphere pinches sooner than one at constant speed');
  assert.ok(pinch.columnSpeed > 50 && pinch.columnHeight > 0, `the jet: ${pinch.columnSpeed} m/s`);
});

test('a light sphere floats at the draft Archimedes gives', () => {
  // Density 0.5: half under, its centre on the surface; set there at rest, it stays.
  const { run, ball } = drop({ R: 0.2, density: 0.5 * RHO, position: [0, 0, 0], velocity: [0, 0, 0], rate: 240 });
  run(240 * 2);
  assert.ok(Math.abs(ball.position[1]) < 1e-3, `centre at ${ball.position[1]}`);
  assert.ok(Math.abs(ball.linearVelocity[1]) < 1e-2, `moving at ${ball.linearVelocity[1]}`);
});

test('a buoyant sphere let go under water comes up and out, with an exit splash', () => {
  const { run, entry, ball } = drop({
    R: 0.1,
    density: 0.3 * RHO,
    position: [0, -1.5, 0],
    velocity: [0, 0, 0],
    rate: 240,
  });
  let left = false;
  for (let i = 0; i < 240 * 4 && !left; i++) {
    run(1);
    left = entry.splashes().some((e) => e.kind === 'exit');
  }
  assert.ok(left, `exit splash: ${entry.splashes().map((e) => e.kind)}, at ${ball.position}`);
  const exit = entry.splashes().find((e) => e.kind === 'exit');
  assert.ok(exit.columnSpeed > 0.5, `it leaves at ${exit.columnSpeed} m/s`);
});

/** A prolate spheroid `length` long and `breadth` across along x, as a UV mesh wound outward. */
function spheroidMesh(length, breadth, nu = 32, nv = 24) {
  const { vertices, indices } = sphereMesh(1, nu, nv),
    v = new Float64Array(vertices.length);
  // The unit sphere's y axis becomes x (its length), x and z its breadth: a rotation keeps the winding.
  for (let i = 0; i < vertices.length; i += 3) {
    v[i] = (vertices[i + 1] * length) / 2;
    v[i + 1] = (-vertices[i] * breadth) / 2;
    v[i + 2] = (vertices[i + 2] * breadth) / 2;
  }
  return { vertices: v, indices };
}

test('a whale breaches: it leaves the water at its speed with an exit splash, falls back and slams in again', () => {
  // A humpback-sized spheroid, 12 m by 3 m, as dense as the sea, leaving at 6.1 m/s pitched 56 degrees up (the adult
  // humpbacks' mean exit speed and pitch, Segre et al., eLife 9:e51760, 2020), its nose 0.5 m under at the start.
  const L = 12,
    B = 3,
    pitch = (56 * Math.PI) / 180,
    U = 6.1,
    physics = new Physics(null, { fixedTimestep: 1 / 240, gravity: [0, -G, 0] }),
    volume = (Math.PI / 6) * L * B * B,
    centre = [-(L / 2) * Math.cos(pitch), -0.5 - (L / 2) * Math.sin(pitch), 0],
    q = [0, 0, Math.sin(pitch / 2), Math.cos(pitch / 2)],
    whale = physics.addBody(null, {
      position: centre,
      rotation: q,
      linearVelocity: [U * Math.cos(pitch), U * Math.sin(pitch), 0],
      colliders: { shape: 'capsule', radius: B / 2, halfHeight: (L - B) / 2, axis: 'x', mass: RHO * volume },
    }),
    entry = new EntrySolver(),
    world = new PhysicsWorld({ rate: { num: 240, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(entry, { bodies: [{ row: whale.row, mesh: spheroidMesh(L, B) }], sea: { elevation: () => 0 }, level: 2 })
      .couple(['entry', 'rigid'], 'staggered');
  world.advance(240 * 6);
  const kinds = entry.splashes().map((e) => e.kind),
    exit = entry.splashes().find((e) => e.kind === 'exit'),
    back = entry
      .splashes()
      .filter((e) => e.kind === 'entry')
      .at(-1);
  assert.ok(kinds.includes('exit') && kinds.lastIndexOf('entry') > kinds.indexOf('exit'), `splashes: ${kinds}`);
  assert.ok(
    exit.columnSpeed > 2 && exit.radius > 1.2 && exit.radius < 1.6,
    `exit at ${exit.columnSpeed} m/s, radius ${exit.radius}`,
  );
  assert.ok(back.speed > 3 && back.crownSpeed > 0, `back in at ${back.speed} m/s, crown ${back.crownSpeed} m/s`);
});

test("the wake's sources move no water on balance, and foam goes where it splashes", () => {
  const boxes = [],
    foam = { addFoam: (min, max) => boxes.push([min, max]) },
    { run, entry } = drop({ R: 0.1, density: 2 * RHO, position: [0, 0.12, 0], velocity: [0, -9, 0], rate: 240, foam });
  let moved = 0;
  for (let i = 0; i < 120; i++) {
    run(1);
    const sources = entry.seaSources();
    moved += Math.abs(sources.reduce((s, x) => s + x.volume, 0));
    for (const s of sources) assert.ok(s.radius > 0);
  }
  assert.ok(moved < 1e-12, `${moved} m^3 off balance`);
  assert.ok(boxes.length >= 1, 'foam at the entry');
});

test('a snapshot restores the bodies and their cavities bit for bit', () => {
  const make = () => drop({ R: 0.05, density: 3 * RHO, position: [0, 0.3, 0], velocity: [1, -10, 0], rate: 240 });
  const a = make();
  a.world.advance(60);
  const saved = a.world.takeSnapshot();
  a.world.advance(120);
  const hash = a.world.hash(),
    events = JSON.stringify(a.entry.splashes());
  a.world.restoreSnapshot(saved.bytes);
  a.world.advance(120);
  assert.equal(a.world.hash(), hash);
  assert.equal(JSON.stringify(a.entry.splashes()), events);
  const b = make();
  b.world.advance(120);
  assert.equal(b.world.hash(), hash, 'a second run');
});

test("Lamb's spheroid: a sphere carries half its volume, a long body little along its axis", () => {
  assert.deepEqual(spheroid(1), { k1: 0.5, k2: 0.5 });
  const { k1, k2 } = spheroid(10);
  assert.ok(Math.abs(k1 - 0.0207) < 2e-4 && Math.abs(k2 - 0.96) < 2e-3, `${k1} ${k2}`);
});

test('bad bodies and settings are refused, each naming its fix', () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }),
    mesh = sphereMesh(1, 8, 4),
    sea = { elevation: () => 0 };
  assert.throws(() => world.add(new EntrySolver('a'), { bodies: [], sea }), /pass them/);
  assert.throws(() => world.add(new EntrySolver('b'), { bodies: [{ row: 0, mesh }] }), /pass \{sea\}/);
  assert.throws(() => world.add(new EntrySolver('c'), { bodies: [{ row: -1, mesh }], sea }), RangeError);
  assert.throws(
    () => world.add(new EntrySolver('d'), { bodies: [{ row: 0, mesh, contactAngle: 200 }], sea }),
    RangeError,
  );
  const inward = { vertices: mesh.vertices, indices: Uint32Array.from(mesh.indices).reverse() };
  assert.throws(
    () => world.add(new EntrySolver('e'), { bodies: [{ row: 0, mesh: inward }], sea }),
    /wind its triangles outward/,
  );
  assert.throws(() => world.add(new EntrySolver('f'), { bodies: [{ row: 0, mesh }], sea, foam: {} }), TypeError);
});
