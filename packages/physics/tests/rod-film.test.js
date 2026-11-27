// A rod's direction and scale (SOFT-02): the wind on rods in air against the closed form of a cable hanging in it, a
// target shape the rod blends toward against the critically damped spring, a seeded sway that replays, and the work a
// long rod and many rods take, counted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { reynoldsDrag, STANDARD_AIR, segmentAirLoads, segmentLoads, swayFlow } from '../dist/loads.js';
import { Rod } from '../dist/rod.js';

await Physics.load();

/** A steady, uniform wind along x. */
function wind(speed) {
  return {
    medium: 'air',
    cell: [0, 0, 0],
    sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
      out.velocity[0] = speed;
      out.velocity[1] = out.velocity[2] = 0;
      out.density = STANDARD_AIR.density;
      out.temperature = 288.15;
      return out;
    },
  };
}

test('a cable hanging in a steady wind stands straight at the angle where its weight across it meets the drag', () => {
  // A cable hanging free in a uniform wind carries a uniform load, so it hangs straight at an angle theta from the
  // vertical where its weight across it, w sin(theta), is the drag on the wind's part across it, 1/2 rho C_D D (U cos
  // theta)^2 (the independence principle), C_D the cylinder's at that Reynolds number. The discrete rod holds the same
  // straight line; what is left is its settling and f32 rounding, measured at 1.2e-5 rad and held to 1e-4 rad.
  const U = 8,
    D = 0.006,
    density = 1500,
    g = 9.81,
    { density: rho, viscosity: nu } = STANDARD_AIR;
  const physics = new Physics(null, { gravity: [0, -g, 0] });
  const n = 32;
  const rod = new Rod(physics, {
    start: [0, 2, 0],
    end: [0, 0, 0],
    segments: n,
    radius: D / 2,
    density,
    bendStiffness: 1e-6,
    twistStiffness: 1e-6,
    attachStart: 'fixed',
    loads: segmentAirLoads(wind(U), { vortex: false }),
    body: { canSleep: false },
  });
  for (let i = 0; i < 900; i++) physics.step(1 / 60);
  const p = rod.points(),
    angle = Math.atan2(p[3 * n] - p[0], p[1] - p[3 * n + 1]);
  // The weight less the air's buoyancy, and theta by bisection with C_D at the normal Reynolds number, to a fixed point.
  const w = ((density - rho) * Math.PI * D * D * g) / 4;
  let theta = 0.5;
  for (let k = 0; k < 40; k++) {
    const q = 0.5 * rho * reynoldsDrag((U * Math.cos(theta) * D) / nu) * D * U * U;
    let lo = 0,
      hi = Math.PI / 2;
    for (let j = 0; j < 60; j++) {
      const mid = (lo + hi) / 2;
      if (w * Math.sin(mid) > q * Math.cos(mid) ** 2) hi = mid;
      else lo = mid;
    }
    theta = (lo + hi) / 2;
  }
  assert.ok(Math.abs(angle - theta) < 1e-4, `the cable hangs at ${angle} rad, the closed form at ${theta}`);
  let bow = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    bow = Math.max(
      bow,
      Math.hypot(p[3 * k] - (p[0] + t * (p[3 * n] - p[0])), p[3 * k + 1] - (p[1] + t * (p[3 * n + 1] - p[1]))),
    );
  }
  assert.ok(bow < 1e-4, `the cable bows ${bow} m off its chord`);
  physics.dispose();
});

test('a rod blends toward its target as a critically damped spring, and lets go', () => {
  // With no gravity, a free rod pulled toward its own shape moved 0.5 m across moves as one mass on the spring: every link
  // has the same spring per its mass. Critically damped at 1 Hz, it is at d (1 - (1 + w t) e^(-w t)) and never past d.
  // The force is held over each step, an error of order w dt / 2 of the step's change: 0.06% of d at 1 s measured,
  // held to 1%.
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const rod = new Rod(physics, { start: [0, 0, 0], end: [1, 0, 0], segments: 16, radius: 0.01 });
  rod.setTarget(
    [
      [0, 0.5, 0],
      [1, 0.5, 0],
    ],
    { frequency: 1, damping: 1 },
  );
  let past = 0,
    atOne = 0;
  for (let i = 1; i <= 300; i++) {
    physics.step(1 / 60);
    const y = rod.points()[3 * 8 + 1];
    past = Math.max(past, y - 0.5);
    if (i === 60) atOne = y;
  }
  const w = 2 * Math.PI,
    exact = 0.5 * (1 - (1 + w) * Math.exp(-w));
  assert.ok(Math.abs(atOne - exact) < 0.005, `at 1 s the rod is at ${atOne} m, the spring at ${exact}`);
  assert.ok(past < 1e-6, `critically damped, it went ${past} m past the target`);
  const settled = rod.points();
  for (let k = 1; k < settled.length; k += 3)
    assert.ok(Math.abs(settled[k] - 0.5) < 1e-4, `point ${(k - 1) / 3} at ${settled[k]}`);
  // Let go: with no pull and no gravity it stays where it is.
  rod.setTarget(null);
  for (let i = 0; i < 60; i++) physics.step(1 / 60);
  assert.ok(Math.abs(rod.points()[3 * 8 + 1] - 0.5) < 1e-4, 'after letting go it stays');
  // Out of range: faster than the step can hold, or damped past it, or no shape.
  const refused = (message) => ({ name: 'MargoError', code: 'unsupported', message: new RegExp(`${message}.+#rods`) });
  assert.throws(
    () =>
      rod.setTarget(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        { frequency: 10 },
      ),
    refused('at most 4.77 Hz'),
  );
  assert.throws(
    () =>
      rod.setTarget(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        { damping: 50 },
      ),
    refused('damping'),
  );
  assert.throws(
    () =>
      rod.setTarget([
        [0, 0, 0],
        [0, 0, 0],
      ]),
    refused('no length'),
  );
  physics.dispose();
});

test('a seeded sway is the same for the same seed, another for another, and sways about no mean', () => {
  const a = swayFlow({ speed: 0.3, seed: 7 }),
    b = swayFlow({ speed: 0.3, seed: 7 }),
    c = swayFlow({ speed: 0.3, seed: 8 });
  let differs = false,
    mean = 0,
    peak = 0;
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const t = i * 0.05,
      va = a.sample(1, 0, 2, t).velocity[0];
    assert.equal(va, b.sample(1, 0, 2, t).velocity[0], `the same seed at ${t} s`);
    differs ||= va !== c.sample(1, 0, 2, t).velocity[0];
    mean += va / N;
    peak = Math.max(peak, Math.abs(va));
  }
  assert.ok(differs, 'another seed sways another way');
  // Over 300 s, 50 of the slowest gust's periods, the mean of three sines is under a part in a hundred of the speed.
  assert.ok(Math.abs(mean) < 0.003, `mean ${mean} m/s`);
  assert.ok(peak <= 0.3, `peak ${peak} m/s over the speed`);
  assert.throws(() => swayFlow({ speed: -1 }), { code: 'unsupported', message: /speed.+#hydrodynamic-loads/ });
  assert.throws(() => swayFlow({ speed: 1, direction: [0, 1, 0] }), { code: 'unsupported', message: /horizontal/ });
  assert.throws(() => segmentAirLoads({ medium: 'water', cell: [0, 0, 0], sample() {} }), {
    code: 'unsupported',
    message: /medium 'air'/,
  });
  // A kelp stalk in still water swayed by it: it moves, and the same seed moves it the same way to the bit.
  const run = (seed) => {
    const physics = new Physics(null, { gravity: [0, -9.81, 0] });
    const still = {
      density: 1025,
      elevation: () => 10,
      water: {
        medium: 'water',
        cell: [0, 0, 0],
        sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
          out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
          out.density = 1025;
          out.temperature = 288;
          return out;
        },
      },
    };
    const rod = new Rod(physics, {
      start: [0, 0, 0],
      end: [0, 2, 0],
      segments: 12,
      radius: 0.01,
      density: 900,
      bendStiffness: 1e-3,
      attachStart: 'fixed',
      loads: segmentLoads(still, { flows: [swayFlow({ speed: 0.3, seed })] }),
    });
    for (let i = 0; i < 180; i++) physics.step(1 / 60);
    const top = rod.points().slice(36, 39);
    physics.dispose();
    return top;
  };
  const first = run(3);
  assert.ok(Math.abs(first[0]) > 1e-3, `the stalk's top moved ${first[0]} m`);
  assert.deepEqual(run(3), first);
});

test("a rod's work grows with its links and its count, as counted", () => {
  // Work counts, the same on every machine: a rod of n links is one island of n bodies, the broad phase looks at 2n - 3
  // pairs (each link's two neighbours and the link beyond, held apart by the joints' filter, so none is solved), and the
  // solver solves n joints. A 4,096-link rod, the most a rod takes, does four times a 1,024-link one's work, and 64 rods
  // of 24 links do 64 times one rod's. Recorded in docs/limits.md.
  const counts = (make) => {
    const physics = new Physics(null, {});
    make(physics);
    physics.step(1 / 60);
    physics.step(1 / 60);
    const out = physics.counts;
    physics.dispose();
    return out;
  };
  for (const n of [1024, 4096]) {
    const c = counts(
      (physics) => new Rod(physics, { start: [0, 0, 0], end: [n * 0.05, 0, 0], segments: n, attachStart: 'fixed' }),
    );
    assert.equal(c.awake, n);
    assert.equal(c.islands, 1);
    assert.equal(c.pairsLookedAt, 2 * n - 3);
    assert.equal(c.pairsSolved, 0);
    assert.equal(c.jointsSolved, n);
  }
  const one = counts(
    (physics) =>
      new Rod(physics, { start: [0, 0, 0], end: [0, 1.5, 0], segments: 24, radius: 0.005, attachStart: 'fixed' }),
  );
  const many = counts((physics) => {
    for (let r = 0; r < 64; r++)
      new Rod(physics, {
        start: [r * 0.3, 0, 0],
        end: [r * 0.3, 1.5, 0],
        segments: 24,
        radius: 0.005,
        attachStart: 'fixed',
      });
  });
  for (const key of ['awake', 'islands', 'pairsLookedAt', 'jointsSolved']) assert.equal(many[key], 64 * one[key], key);
});
