// Wave radiation of `floating` (SEA-12, parity bar P12 point 2). A floating body that moves makes waves, and the waves
// carry its energy away: `floating` bakes each wet part with the SEA-08 panel method at the body's still-water draft and
// steps it as the LoadSolver's coupled radiation memory, so a dropped body's heave dies out as a model test's does.
//
// The measured case is Kramer, Andersen, Thomas et al., "Highly accurate experimental heave decay tests with a floating
// sphere: a public benchmark dataset for model validation of fluid-structure interaction", Energies 14(2), 269, 2021
// (doi:10.3390/en14020269), Tables 1, 2 and A2: a sphere of 300 mm diameter and 7.056 kg, its centre of gravity 34.8 mm
// below its centre, half submerged in fresh water (998.2 kg/m³, g = 9.82 m/s², 0.9 m deep: k d is 6.3 at the heave
// resonance, deep water to 1e-5), let go from H0 = 0.1, 0.3 and 0.5 D above its rest. The measured damped heave period is
// Te0 = 0.76 s; WAMIT gives A33 = 2.97 kg and B33 = 13.95 N s/m at its frequency 8.30 rad/s, and a decay rate
// B33 / (2 (m + A33)) = 0.695 1/s, which with the linear Cummins models tracked the measured H0 = 0.1 D decay within
// about 1 mm (3 % of H0). Nothing here is fitted to the test: the body is its collider, its mass and its centre of mass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { floating, LoadSolver } from '../dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../dist/world.js';

await Physics.load();
const RHO = 998.2,
  G = 9.82,
  R = 0.15,
  M = 7.056,
  RATE = 240;

function water() {
  return {
    cell: [0, 0, 0],
    density: RHO,
    elevation: () => 0,
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
        out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
        out.density = RHO;
        out.temperature = 288;
        return out;
      },
    },
  };
}

/** Kramer's sphere, let go `drop` metres above its rest, in a world with its LoadSolver bodies from `float`. */
async function sphere(drop, options = {}) {
  const physics = new Physics(null, {
      fixedTimestep: 1 / RATE,
      gravity: [0, -G, 0],
    }),
    body = physics.addBody(null, {
      position: [0, drop, 0],
      colliders: { shape: 'sphere', radius: R, mass: M },
      linearDamping: 0,
      angularDamping: 0,
    });
  body.setMassProperties({
    mass: M,
    centerOfMass: [0, -0.0348, 0],
    inertia: [0.098251, 0.073052, 0.098254],
  });
  const sea = water(),
    bodies = await floating(physics, body, { sea, gravity: G, ...options }),
    world = new PhysicsWorld({
      rate: { num: RATE, den: 1 },
      gravity: [0, -G, 0],
    })
      .add(new RigidSolver(), { physics })
      .add(new LoadSolver(), { sea, bodies, level: 2 })
      .couple(['loads', 'rigid'], 'staggered');
  return { physics, body, bodies, world };
}

/** Heave for `seconds`: its damped period from the zero crossings, its swings, and the mean decay rate over them. */
function decay({ body, world }, seconds = 3.8) {
  const ys = [];
  for (let f = 1; f <= RATE * seconds; f++) {
    world.advance(f);
    ys.push(body.position[1]);
  }
  const swings = [],
    crossings = [];
  for (let i = 1; i + 1 < ys.length; i++) {
    if ((ys[i] - ys[i - 1]) * (ys[i + 1] - ys[i]) < 0) swings.push([(i + 1) / RATE, ys[i]]);
    if (ys[i - 1] > 0 !== ys[i] > 0) crossings.push((i + ys[i - 1] / (ys[i - 1] - ys[i])) / RATE);
  }
  const [t0, a0] = swings[0],
    [t1, a1] = swings.at(-1);
  return {
    ys,
    swings,
    period: (2 * (crossings.at(-1) - crossings[0])) / (crossings.length - 1),
    rate: Math.log(Math.abs(a0) / Math.abs(a1)) / (t1 - t0),
  };
}

/** The heave added mass and damping of a coupled profile at `w`, from its resonances (K(iw) = B + i w (A - A_inf)). */
function heave(profile, w) {
  let damping = 0,
    inertia = 0;
  for (const mode of profile.resonances) {
    const x = mode.frequency ** 2 - w * w,
      y = mode.decayRate * w,
      s = ((mode.strength * w) / (x * x + y * y)) * mode.direction[1] ** 2;
    damping += s * y;
    inertia += s * x;
  }
  return { damping, addedMass: profile.infiniteMass[7] + inertia / w };
}

// The fine tier's decay of the 0.1 D drop, measured by the test below: the full Cummins memory of the converged panels.
const FINE_RATE = 0.755;
const still = { drag: 0, spinDrag: 0 };

test("SEA-12 floating radiation, fine tier: Kramer's sphere has WAMIT's coefficients and decays at the measured period", async () => {
  // 260 wet panels: within 3 % of WAMIT's converged coefficients (the panel method converges as the panel area; 284
  // panels on a hemisphere were measured within 0.4 % and 2.3 %), 4 % on both.
  const run = await sphere(0.1 * 2 * R, { radiation: 'fine', ...still }),
    { damping, addedMass } = heave(run.bodies[0].coupledRadiation, 8.3);
  assert.ok(Math.abs(damping - 13.95) <= 0.04 * 13.95, `B33 ${damping} against WAMIT's 13.95 N s/m`);
  assert.ok(Math.abs(addedMass - 2.97) <= 0.04 * 2.97, `A33 ${addedMass} against WAMIT's 2.97 kg`);
  const { period, rate } = decay(run);
  // Te0 = 0.76 s from the measured spectrum's peak (its 95 % uncertainty is 0.3 % of H0): 1 %, the added mass's 4 % at
  // half the period's sensitivity, halved again by the dry mass.
  assert.ok(Math.abs(period - 0.76) <= 0.01 * 0.76, `damped period ${period} s against the measured 0.76 s`);
  // WAMIT's single-frequency rate B33 / (2 (m + A33)) leaves out the memory's other frequencies; Kramer et al. measured
  // that constant-coefficient model (LPF0) off the test by up to 9 % of H0 at the first trough: 10 %.
  assert.ok(Math.abs(rate - 0.695) <= 0.1 * 0.695, `decay rate ${rate} 1/s against WAMIT's 0.695 1/s`);
  assert.ok(Math.abs(rate - FINE_RATE) <= 0.01 * FINE_RATE, `decay rate ${rate} 1/s against the recorded ${FINE_RATE}`);
  run.physics[Symbol.dispose]();
});

test("SEA-12 floating radiation, fast tier (default): Kramer's sphere within its bound of WAMIT and of the fine tier", async () => {
  // 64 wet panels: 4 % high in damping and 3 % in added mass against 284 on the same hemisphere: 8 % on both.
  const run = await sphere(0.1 * 2 * R, still),
    { damping, addedMass } = heave(run.bodies[0].coupledRadiation, 8.3);
  assert.ok(Math.abs(damping - 13.95) <= 0.08 * 13.95, `B33 ${damping} against WAMIT's 13.95 N s/m`);
  assert.ok(Math.abs(addedMass - 2.97) <= 0.08 * 2.97, `A33 ${addedMass} against WAMIT's 2.97 kg`);
  const { period, rate, swings } = decay(run),
    none = decay(await sphere(0.1 * 2 * R, { radiation: 'none' }));
  // The period moves with the square root of the inertia (3 % off, so 1.5 %) and the decay rate with the damping (8 %),
  // against the measured period and the fine tier's rate: 2 % and 10 %.
  assert.ok(Math.abs(period - 0.76) <= 0.02 * 0.76, `damped period ${period} s against the measured 0.76 s`);
  assert.ok(
    Math.abs(rate - FINE_RATE) <= 0.1 * FINE_RATE,
    `decay rate ${rate} 1/s against the fine tier's ${FINE_RATE}`,
  );
  // Without the waves it makes the sphere keeps bobbing: its viscous drag alone decays it under a tenth as fast.
  assert.ok(none.rate < 0.1 * rate, `without radiation it decays at ${none.rate} 1/s`);
  assert.ok(swings.every(([, y]) => Number.isFinite(y)));
  run.physics[Symbol.dispose]();
});

test('SEA-12 floating radiation: let go from 0.5 D (held out), its period lengthens as the measured one did', async () => {
  // Kramer et al.: "for increasing drop heights, the initial damped natural period in heave increases" (Figures 13 and
  // 18), the waterplane narrowing as the sphere rises out of the water. The hydrostatics are the exact wetted sphere, so the
  // large drop keeps the measured order, and its swings still shrink every half period.
  const small = decay(await sphere(0.1 * 2 * R)),
    large = decay(await sphere(0.5 * 2 * R));
  assert.ok(large.period > small.period, `0.5 D period ${large.period} s against 0.1 D ${small.period} s`);
  for (let i = 1; i < large.swings.length; i++)
    assert.ok(Math.abs(large.swings[i][1]) < Math.abs(large.swings[i - 1][1]), `swing ${i} of the 0.5 D drop`);
});

test('SEA-12 floating radiation: a body floated turned bakes the same waves in its own frame', async () => {
  // A box turned a quarter about Y floats as the unturned box does: the bake is in the body's attitude (the world's
  // axes) and turned back, so in the body's frame the two profiles agree. The infinite-frequency inertia is the panels'
  // own solve, equal to rounding; the memory is a greedy fit of the panels' samples, which rounding can steer: 2 %.
  const make = async (turn) => {
    const physics = new Physics(null, {
        fixedTimestep: 1 / RATE,
        gravity: [0, -G, 0],
      }),
      body = physics.addBody(null, {
        position: [0, 0.05, 0],
        rotation: [0, Math.sin(turn / 2), 0, Math.cos(turn / 2)],
        colliders: {
          shape: 'box',
          halfExtents: [0.3, 0.1, 0.15],
          density: 500,
        },
      }),
      sea = water(),
      bodies = await floating(physics, body, { sea, gravity: G });
    return { physics, body, bodies, sea };
  };
  const straight = await make(0),
    turned = await make(Math.PI / 2),
    a = straight.bodies[0].coupledRadiation,
    b = turned.bodies[0].coupledRadiation;
  for (const w of [4, 8, 12]) {
    const [ha, hb] = [heave(a, w), heave(b, w)];
    assert.ok(
      Math.abs(ha.damping - hb.damping) <= 0.02 * ha.damping,
      `heave damping at ${w}: ${ha.damping}, ${hb.damping}`,
    );
  }
  const [ia, ib] = [a.infiniteMass, b.infiniteMass];
  for (const i of [0, 7, 14, 21, 28, 35])
    assert.ok(Math.abs(ia[i] - ib[i]) <= 1e-6 * Math.abs(ia[i]), `infinite-frequency inertia ${i}: ${ia[i]}, ${ib[i]}`);
  straight.physics[Symbol.dispose]();
  turned.physics[Symbol.dispose]();
});

test("SEA-12 floating radiation re-panels a detailed hull: Kramer's sphere as a hull of 1,200 points", async () => {
  // A convex hull with more faces than the panel budget is cast as the star it makes from its centre and scaled to its
  // own volume: the sphere's hull of 1,200 points has WAMIT's coefficients within the fast tier's 8 %, as the sphere has.
  const points = [];
  for (let i = 0; i < 1200; i++) {
    const y = 1 - (2 * (i + 0.5)) / 1200,
      r = Math.sqrt(1 - y * y),
      phi = i * Math.PI * (3 - Math.sqrt(5));
    points.push(R * r * Math.cos(phi), R * y, R * r * Math.sin(phi));
  }
  const physics = new Physics(null, {
      fixedTimestep: 1 / RATE,
      gravity: [0, -G, 0],
    }),
    body = physics.addBody(null, {
      colliders: { shape: 'convexHull', points, mass: M },
    }),
    [entry] = await floating(physics, body, { sea: water(), gravity: G }),
    { damping, addedMass } = heave(entry.coupledRadiation, 8.3);
  assert.ok(Math.abs(damping - 13.95) <= 0.08 * 13.95, `B33 ${damping} against WAMIT's 13.95 N s/m`);
  assert.ok(Math.abs(addedMass - 2.97) <= 0.08 * 2.97, `A33 ${addedMass} against WAMIT's 2.97 kg`);
  physics[Symbol.dispose]();
});

test('SEA-12 floating radiation bakes the same profile twice and replays after a snapshot', async () => {
  const one = await sphere(0.03),
    two = await sphere(0.03);
  assert.deepEqual(one.bodies, two.bodies);
  one.world.advance(120);
  two.world.advance(120);
  assert.equal(one.world.hash(), two.world.hash());
  const saved = one.world.takeSnapshot();
  one.world.advance(240);
  const later = one.world.hash();
  one.world.restoreSnapshot(saved.bytes).advance(240);
  assert.equal(one.world.hash(), later);
  one.physics[Symbol.dispose]();
  two.physics[Symbol.dispose]();
});

test('SEA-12 floating radiation refuses what it cannot bake, naming the fix', async () => {
  const physics = new Physics(null, { fixedTimestep: 1 / RATE }),
    body = physics.addBody(null, {
      colliders: { shape: 'sphere', radius: R, mass: M },
    }),
    lead = physics.addBody(null, {
      colliders: { shape: 'sphere', radius: R, density: 11000 },
    });
  await assert.rejects(floating(physics, body, { radiation: 'panel' }), {
    code: 'unsupported',
    message: /'fast', 'fine' or 'none'/,
  });
  await assert.rejects(floating(physics, body, { addedInertia: 'ellipsoid' }), {
    code: 'unsupported',
    message: /drop addedInertia/,
  });
  await assert.rejects(floating(physics, lead), {
    code: 'unsupported',
    message: /too heavy to float/,
  });
  await assert.rejects(floating(physics, body, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  physics[Symbol.dispose]();
});

test("SEA-12 floating radiation, fast tier: Kramer's sphere let go from 0.1 D follows the measured heave time series", async () => {
  // The measured mean of Kramer et al.'s four 0.1 D drops (Supplementary Materials, CC BY 4.0; tests/data, every 10th
  // sample to t = 8 Te0), the sphere's heave over its drop. Their linear potential-flow models came within about 1 mm
  // (0.033 H0) of it at the troughs and crests; this one is held to that over the whole record, root mean square, and to
  // 0.1 H0 at worst (its first descent leads the measured one by about 0.02 Te0, the fast tier's 3 % in added mass).
  const data = JSON.parse(readFileSync(new URL('./data/kramer-2021-sphere-decay.json', import.meta.url), 'utf8')),
    h0 = 0.1 * 2 * R,
    run = await sphere(h0),
    ys = [1];
  for (let f = 1; f <= RATE * 6.2; f++) {
    run.world.advance(f);
    ys.push(run.body.position[1] / h0);
  }
  let squared = 0,
    worst = 0;
  for (const [t, mean] of data.drops['01D']) {
    const s = t * data.Te0 * RATE,
      i = Math.floor(s),
      y = ys[i] + (ys[i + 1] - ys[i]) * (s - i),
      e = Math.abs(y - mean);
    squared += e * e;
    worst = Math.max(worst, e);
  }
  const rms = Math.sqrt(squared / data.drops['01D'].length);
  assert.ok(rms <= 0.033, `root mean square ${rms} H0 from the measured mean`);
  assert.ok(worst <= 0.1, `worst ${worst} H0 from the measured mean`);
  run.physics[Symbol.dispose]();
});
