// Elastic rods (src/rod/index.ts) against their closed forms: a cantilever bent by a steady current, a chain hanging between
// two points, a taut cable's natural frequency, and the cable strumming in a cross flow at the frequency it locks onto.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { Rod } from '../dist/rod.js';
import { SpectralSea } from '../dist/sea.js';
import { reynoldsDrag, SEA_WATER_VISCOSITY, segmentLoads } from '../dist/loads.js';

await Physics.load();

/** Still water of density `density` whose surface is y = 0, moving at `velocity` everywhere below it. */
function water(velocity, density = 1000) {
  return {
    density,
    elevation: () => 0,
    water: {
      medium: 'water',
      cell: { x: 0, y: 0, z: 0 },
      sample(x, y, z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
        const v = typeof velocity === 'function' ? velocity(x, y, z, t) : velocity;
        out.velocity[0] = v[0];
        out.velocity[1] = v[1];
        out.velocity[2] = v[2];
        out.density = density;
        out.temperature = 288.15;
        return out;
      },
    },
  };
}

test('a rod clamped in a steady current bends as the cantilever its springs make under Morison drag', (t) => {
  // A 1 m nylon rod of radius 1 cm (EI = 23.6 N m^2) standing on the seabed, as dense as the water so only the flow bends it,
  // in a steady current of 0.5 m/s (Re 8,400, below the drag crisis: C_D = 1.02 by White's fit): q = 1/2 rho C_D D U^2 =
  // 2.6 N/m and the beam's tip moves q L^4 / (8 EI) = 1.4 cm across the flow.
  // The rod is 32 links, each pushed at its centre: the chain of springs balances that load where joint j turns by M_j / k_j
  // (k = EI / l, 2 EI / l at the clamp, which bends half a link). The slope is under 0.03, so the drag's fall with the
  // cosine of the tilt, (1 - 0.03^2), and the arms' shortening are a part in a thousand.
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const n = 32,
    U = 0.5,
    rho = 1000,
    D = 0.02;
  const rod = new Rod(physics, {
    start: [0, -5, 0],
    end: [0, -4, 0],
    segments: n,
    radius: D / 2,
    density: rho,
    attachStart: 'fixed',
    clamp: 'start',
    loads: segmentLoads(water([U, 0, 0], rho), { period: Infinity, vortex: false }),
    body: { canSleep: false },
    damping: 0.05,
  });
  for (let i = 0; i < 1200; i++) physics.step(1 / 60);
  const points = rod.points(),
    tip = points[n * 3];
  const l = 1 / n,
    EI = rod.stiffness.bend,
    cd = reynoldsDrag((U * D) / SEA_WATER_VISCOSITY, 5e-5 / D),
    load = 0.5 * rho * cd * D * l * U * U;
  let springs = 0;
  for (let j = 0; j < n; j++) {
    let moment = 0;
    for (let i = j; i < n; i++) moment += load * ((i + 0.5) * l - j * l);
    springs += (moment / (j === 0 ? (2 * EI) / l : EI / l)) * (1 - j * l);
  }
  const beam = (0.5 * rho * cd * D * U * U) / (8 * EI);
  t.diagnostic(
    `tip ${tip} m, springs ${springs} m (${(tip / springs - 1) * 100} %), beam ${beam} m (${(tip / beam - 1) * 100} %)`,
  );
  assert.ok(Math.abs(tip - springs) / springs < 2e-3, `tip at ${tip} m where the rod's springs give ${springs} m`);
  // The chain of 32 links against the continuous beam: the links' midpoint loads and the half-link clamp converge as 1/n^2.
  assert.ok(Math.abs(tip - beam) / beam < 0.01, `tip at ${tip} m where the beam gives ${beam} m`);
  physics.dispose();
});

test('a slack line hangs between two pins as the chain of its links', (t) => {
  // 10 m of inextensible line in 40 links pinned 8 m apart. A chain of equal links, each its weight at its middle, hangs with
  // link i at the slope tan(phi_i) = w (n/2 - i - 1/2) / H: the horizontal pull H is found from the span, and the sag is
  // what the links of one half fall. The continuous catenary is quoted beside it.
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const n = 40,
    L = 10,
    S = 8;
  const rod = new Rod(physics, {
    points: [
      [-4, 0, 0],
      [0, -3, 0],
      [4, 0, 0],
    ],
    segments: n,
    radius: 0.01,
    bendStiffness: 1e-6,
    twistStiffness: 1e-6,
    axialStiffness: Infinity,
    attachStart: 'fixed',
    attachEnd: 'fixed',
    body: { canSleep: false, linearDamping: 0.5 },
  });
  for (let i = 0; i < 1800; i++) physics.step(1 / 60);
  const points = rod.points(),
    sag = -points[(n / 2) * 3 + 1];
  const l = L / n,
    span = (h) => {
      let x = 0;
      for (let i = 0; i < n; i++) x += l * Math.cos(Math.atan((n / 2 - i - 0.5) / h));
      return x;
    };
  // H in units of one link's weight: the span grows with H.
  let low = 1e-3,
    high = 1e4;
  for (let k = 0; k < 200; k++) {
    const mid = (low + high) / 2;
    if (span(mid) < S) low = mid;
    else high = mid;
  }
  const h = (low + high) / 2;
  let links = 0;
  for (let i = 0; i < n / 2; i++) links += l * Math.sin(Math.atan((n / 2 - i - 0.5) / h));
  assert.ok(
    Math.abs(sag - links) / links < 1e-3,
    `the middle hangs ${sag} m below the pins where its links give ${links} m`,
  );
  // The continuous catenary y = a cosh(x / a) through the same pins: L = 2 a sinh(S / 2a).
  let a0 = 0.1,
    a1 = 100;
  for (let k = 0; k < 200; k++) {
    const a = (a0 + a1) / 2;
    if (2 * a * Math.sinh(S / (2 * a)) > L) a0 = a;
    else a1 = a;
  }
  const a = (a0 + a1) / 2,
    catenary = a * (Math.cosh(S / (2 * a)) - 1);
  t.diagnostic(
    `sag ${sag} m, links ${links} m (${(sag / links - 1) * 100} %), catenary ${catenary} m (${(sag / catenary - 1) * 100} %)`,
  );
  assert.ok(Math.abs(sag - catenary) / catenary < 2e-3, `sag ${sag} m, catenary ${catenary} m`);
  physics.dispose();
});

/** A cable of rest length `L0` pinned between two fixed points pulled `strain` apart, so its tension is EA strain. */
function tautCable(physics, { n = 32, L0 = 2, strain = 1e-5, radius = 0.005, youngModulus, loads, y = 0 } = {}) {
  const left = physics.addBody(null, { type: 'fixed', position: [-L0 / 2, y, 0], colliders: [] }),
    right = physics.addBody(null, { type: 'fixed', position: [L0 / 2, y, 0], colliders: [] });
  const rod = new Rod(physics, {
    start: [-L0 / 2, y, 0],
    end: [L0 / 2, y, 0],
    segments: n,
    radius,
    youngModulus,
    attachStart: left,
    attachEnd: right,
    damping: 0,
    loads,
    body: { canSleep: false },
  });
  left.setPosition([(-L0 / 2) * (1 + strain), y, 0]);
  right.setPosition([(L0 / 2) * (1 + strain), y, 0]);
  return rod;
}

/** The frequency of a signal's largest Fourier component after `skip` samples, at `rate` samples a second, by golden search. */
function dominant(signal, rate, skip = 0, lo = 0.02, hi = 2) {
  const tail = signal.slice(skip),
    mean = tail.reduce((a, b) => a + b, 0) / tail.length,
    power = (f) => {
      let c = 0,
        s = 0;
      tail.forEach((v, i) => {
        c += (v - mean) * Math.cos((2 * Math.PI * f * i) / rate);
        s += (v - mean) * Math.sin((2 * Math.PI * f * i) / rate);
      });
      return c * c + s * s;
    };
  // The largest of a fine scan, then refined between its neighbours.
  let best = lo;
  for (let f = lo; f <= hi; f += 0.002) if (power(f) > power(best)) best = f;
  let a = best - 0.002,
    b = best + 0.002;
  for (let k = 0; k < 40; k++) {
    const m1 = a + (b - a) * 0.382,
      m2 = a + (b - a) * 0.618;
    if (power(m1) > power(m2)) b = m2;
    else a = m1;
  }
  return (a + b) / 2;
}

/** The frequency of a signal from its upward zero crossings after `skip` samples, at `rate` samples a second. */
function frequency(signal, rate, skip = 0) {
  const mean = signal.slice(skip).reduce((a, b) => a + b, 0) / (signal.length - skip);
  const ups = [];
  for (let i = skip + 1; i < signal.length; i++)
    if (signal[i - 1] - mean < 0 && signal[i] - mean >= 0)
      ups.push(i - 1 + (mean - signal[i - 1]) / (signal[i] - signal[i - 1]));
  return ((ups.length - 1) * rate) / (ups[ups.length - 1] - ups[0]);
}

test("a taut cable rings at the string's frequency with its bending added", (t) => {
  // Pinned at both ends under tension T with no gravity: omega_1^2 = (pi / L)^2 T / mu + (pi / L)^4 EI / mu, mu its mass per
  // metre. Plucked in its first mode, the middle swings at that frequency. The pluck is small: a cable held at both ends
  // stretches as it bows, by (pi a / 2 L)^2 at a bow of a, which raises its tension; at 2 mm/s the bow is 0.16 mm and adds
  // 0.2 % to T (0.1 % to the frequency), where 20 mm/s added 16 %. Links with their mass along them are the consistent mass
  // of linear elements, high by (pi / n)^2 / 24 = 0.04 % at 32 links; 0.5 % holds both with room. Before a pin gave way along
  // its link, the half link at each pinned end did not stretch and the cable rang 1.6 % high.
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const rod = tautCable(physics, {});
  const { axial, bend } = rod.stiffness,
    L = 2,
    T = axial * 1e-5,
    mu = 1140 * Math.PI * 0.005 ** 2;
  const expected = Math.sqrt((Math.PI / L) ** 2 * (T / mu) + (Math.PI / L) ** 4 * (bend / mu)) / (2 * Math.PI);
  // Settle the stretch, then pluck: each link moves across as sin(pi x / L).
  for (let i = 0; i < 60; i++) physics.step(1 / 60);
  rod.segments.forEach((body, i) => {
    const x = (i + 0.5) / rod.segments.length;
    body.setLinearVelocity([0, 0.002 * Math.sin(Math.PI * x), 0]);
  });
  const middle = [];
  for (let i = 0; i < 900; i++) {
    physics.step(1 / 60);
    middle.push(rod.points()[(rod.segments.length / 2) * 3 + 1]);
  }
  const measured = frequency(middle, 60);
  t.diagnostic(`rang at ${measured} Hz, expected ${expected} Hz (${(measured / expected - 1) * 100} %)`);
  assert.ok(
    Math.abs(measured - expected) / expected < 5e-3,
    `rang at ${measured} Hz where the cable gives ${expected} Hz`,
  );
  physics.dispose();
});

test('a taut cable in a cross flow strums at its own frequency through lock-in and follows the shedding outside it', (t) => {
  // Vortex-induced vibration of a cable pinned at both ends (Facchinetti, de Langre and Biolley 2004's wake oscillator on each
  // link). The cable is stiff enough in tension (strain 1e-3) that its swing barely changes its tension, so its frequency in
  // still water is f_w = f_1 sqrt(mu / (mu + C_a rho A)), f_1 the taut cable's in air. The wake sheds at f_s = St U / D. Below
  // lock-in (reduced velocity U / (f_w D) = 2) the cable moves at the shedding frequency, hardly at all; in lock-in (5 and 7)
  // its motion is taken over by its own frequency while f_s runs 40 % past it, and it swings tenths of its diameter (at Re
  // about 400 the wake is weaker than at the Re 5e4 its amplitudes are set at, by Govardhan and Williamson's fit). The mean
  // drag bows it along the flow, more as it swings
  // (the drag on the flow relative to it grows), which stretches it and raises its tension and its own frequency: lock-in is
  // judged against the frequency at the bowed cable's tension.
  const L0 = 2,
    radius = 0.005,
    D = 2 * radius,
    E = 3e7,
    strain = 1e-3,
    rho = 1000,
    mu = 1140 * Math.PI * radius ** 2,
    EI = (E * Math.PI * radius ** 4) / 4,
    T = E * Math.PI * radius ** 2 * strain,
    f1 = Math.sqrt((Math.PI / L0) ** 2 * (T / mu) + (Math.PI / L0) ** 4 * (EI / mu)) / (2 * Math.PI),
    fw = f1 * Math.sqrt(mu / (mu + rho * Math.PI * radius ** 2));
  const run = (reduced) => {
    const U = reduced * fw * D;
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const rod = tautCable(physics, {
      L0,
      radius,
      strain,
      youngModulus: E,
      loads: segmentLoads(water([0, 0, U], rho), { period: Infinity }),
      y: -1,
    });
    const across = [],
      bow = [];
    for (let i = 0; i < 2400; i++) {
      physics.step(1 / 60);
      const p = rod.points(),
        k = (rod.segments.length / 2) * 3;
      across.push(p[k + 1] + 1);
      bow.push(p[k + 2]);
    }
    physics.dispose();
    const tail = across.slice(1200),
      // The mean drag bows the cable along the flow by delta, which stretches it by (8 / 3) (delta / L)^2 for a parabola
      // and raises its tension by EA times that: its own frequency in still water at that tension.
      delta = bow.slice(1200).reduce((a, b) => a + b, 0) / 1200,
      raised = Math.sqrt(1 + ((8 / 3) * (delta / L0) ** 2) / strain);
    return {
      amplitude: (Math.max(...tail) - Math.min(...tail)) / 2 / D,
      f: frequency(tail, 60),
      fs: (0.2 * U) / D,
      own: fw * raised,
    };
  };
  const below = run(2),
    locked = run(5),
    past = run(7);
  t.diagnostic(
    `f_w ${fw} Hz; Ur 2: ${JSON.stringify(below)}; Ur 5: ${JSON.stringify(locked)}; Ur 7: ${JSON.stringify(past)}`,
  );
  assert.ok(
    Math.abs(below.f - below.fs) / below.fs < 0.1,
    `below lock-in it moved at ${below.f} Hz, the wake at ${below.fs} Hz`,
  );
  assert.ok(below.amplitude < 0.1, `below lock-in it swung ${below.amplitude} D`);
  for (const run of [locked, past]) {
    assert.ok(
      Math.abs(run.f - run.own) / run.own < 0.15,
      `in lock-in it moved at ${run.f} Hz, its own frequency is ${run.own} Hz`,
    );
    // Locked in, it swings tenths of a diameter, more than ten times its swing below lock-in; how far, against a measured
    // pipe, is tests/rod-viv.test.js.
    assert.ok(
      run.amplitude > 10 * below.amplitude,
      `in lock-in it swung ${run.amplitude} D, below it ${below.amplitude} D`,
    );
  }
  assert.ok(past.fs > 1.3 * fw, 'the shedding ran well past the cable at Ur 7');
});

/** A sea of one linear wave of amplitude `a` at the wave grid's frequency `i`, travelling along +x, in deep water. */
function oneWave(a, i = 12) {
  const nf = 34,
    nd = 24,
    frequencies = Float64Array.from({ length: nf }, (_, k) => 0.04 * (1 / 0.04) ** (k / (nf - 1))),
    directions = Float64Array.from({ length: nd }, (_, j) => (2 * Math.PI * j) / nd),
    energy = new Float64Array(nf * nd),
    df = (frequencies[i + 1] - frequencies[i - 1]) / 2;
  energy[i * nd] = (a * a) / (2 * df * ((2 * Math.PI) / nd));
  return {
    sea: new SpectralSea({ waves: { frequencies, directions, energy, depth: Infinity, density: 1025 } }),
    f: frequencies[i],
  };
}

test('a mooring line goes with a hull leaving its berth, and cast off it falls away to hang from the bollard', () => {
  // A 6 m line from a bollard to a hull 4 m off that moves away at 0.5 m/s for 2 s: the line stays slack and its end goes
  // with the hull. Cast off at the hull, it falls to hang from the bollard. (Not taut: a kinematic hull cannot be held, so a
  // line pulled taut by one stretches without end.)
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const hull = physics.addBody(null, { type: 'kinematicVelocity', position: [4, 0, 0], colliders: [] });
  const rod = new Rod(physics, {
    points: [
      [0, 0, 0],
      [2, -Math.sqrt(5), 0],
      [4, 0, 0],
    ],
    segments: 24,
    radius: 0.02,
    // A braided rope bends and twists far more easily than a solid rod of its fibre: its strands slide.
    bendStiffness: 0.5,
    twistStiffness: 0.5,
    attachStart: 'fixed',
    attachEnd: hull,
    damping: 0.02,
    body: { linearDamping: 0.2 },
  });
  hull.setLinearVelocity([0.5, 0, 0]);
  const end = () => {
    const p = rod.points();
    return [p[24 * 3], p[24 * 3 + 1], p[24 * 3 + 2]];
  };
  for (let i = 0; i < 120; i++) {
    physics.step(1 / 60);
    const at = end(),
      hullAt = hull.position;
    assert.ok(
      Math.hypot(at[0] - hullAt[0], at[1] - hullAt[1]) < 1e-4,
      `step ${i}: the line's end at ${at}, the hull at ${hullAt}`,
    );
  }
  hull.setLinearVelocity([0, 0, 0]);
  assert.ok(rod.held('end'));
  rod.release('end');
  assert.equal(rod.held('end'), false);
  // A 6 m line swings with a period of about 5 s; its links' drag in the air (linearDamping 0.2 /s) settles it in 30 s.
  for (let i = 0; i < 1800; i++) physics.step(1 / 60);
  const fallen = end();
  assert.ok(fallen[1] < -5.9, `cast off, the end hangs at ${fallen[1]} m, where the 6 m line reaches`);
  assert.ok(Math.abs(fallen[0]) < 0.1, `cast off, the end hangs below the bollard, at x = ${fallen[0]} m`);
  physics.dispose();
});

test('a rod keeps the curl of its rest shape, and its start clamped to its own root cannot be cast off', () => {
  // A quarter circle of 0.5 m radius, clamped at its start, with no gravity: its springs' zero is that curl.
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const points = Array.from({ length: 17 }, (_, k) => {
    const a = (k / 16) * (Math.PI / 2);
    return [0.5 * Math.sin(a), 0.5 - 0.5 * Math.cos(a), 0];
  });
  const rod = new Rod(physics, {
    points,
    segments: 16,
    radius: 0.005,
    attachStart: 'fixed',
    clamp: 'start',
    youngModulus: 1e6,
  });
  const before = rod.points();
  for (let i = 0; i < 120; i++) physics.step(1 / 60);
  const after = rod.points();
  for (let k = 0; k < after.length; k++)
    assert.ok(Math.abs(after[k] - before[k]) < 1e-5, `point ${k / 3}: ${before[k]} became ${after[k]}`);
  assert.throws(
    () => rod.release('start'),
    (error) => error.code === 'state',
  );
  physics.dispose();
});

test('a hose standing in the waves sways at their period, and a restored world with its state steps to the same bits', () => {
  // One wave of 1 m at the grid's 13th frequency over deep water; a 2 m hose stands from 6 m down. Its tip moves with the
  // orbits at the wave's frequency: the largest part of its motion is at that frequency (the vortices it sheds add motion at
  // their own, so its zero crossings are not the wave's).
  const { sea, f } = oneWave(1),
    physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const rod = new Rod(physics, {
    start: [0, -6, 0],
    end: [0, -4, 0],
    segments: 20,
    radius: 0.02,
    density: 1100,
    youngModulus: 2e7,
    attachStart: 'fixed',
    clamp: 'start',
    loads: segmentLoads(sea),
  });
  const tip = [];
  for (let i = 0; i < 1800; i++) {
    physics.step(1 / 60);
    tip.push(rod.points()[20 * 3]);
  }
  const swing = Math.max(...tip.slice(600)) - Math.min(...tip.slice(600)),
    measured = dominant(tip, 60, 600);
  assert.ok(swing > 0.05, `the tip swung ${swing} m`);
  assert.ok(Math.abs(measured - f) / f < 0.05, `the tip swayed at ${measured} Hz in waves of ${f} Hz`);
  // The world's snapshot and the rod's own state, taken together, step on to the same bits.
  const snapshot = physics.takeSnapshot(),
    state = rod.takeState(),
    first = [];
  for (let i = 0; i < 120; i++) {
    physics.step(1 / 60);
    first.push(physics.kernel.hash);
  }
  physics.restoreSnapshot(snapshot);
  rod.restoreState(state);
  for (let i = 0; i < 120; i++) {
    physics.step(1 / 60);
    assert.equal(physics.kernel.hash, first[i], `step ${i} after the restore`);
  }
  assert.throws(() => rod.restoreState(new Float64Array(3)), {
    name: 'MargoError',
    code: 'unsupported',
    message: /pass that one.+#hydrodynamic-loads/,
  });
  physics.dispose();
});

test('a body swimming into a stand of tentacles pushes them aside through contact', () => {
  // Three soft rods standing from a fixed rock, and a ball swimming at them across: the contacts bend them and slow it.
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const rods = [-0.1, 0, 0.1].map(
    (z) =>
      new Rod(physics, {
        start: [0, 0, z],
        end: [0, 0.4, z],
        segments: 12,
        radius: 0.01,
        density: 1050,
        youngModulus: 2e6,
        attachStart: 'fixed',
        clamp: 'start',
      }),
  );
  const fish = physics.addBody(null, {
    position: [-0.5, 0.3, 0],
    linearVelocity: [1, 0, 0],
    colliders: { shape: 'sphere', radius: 0.08, density: 1050 },
  });
  for (let i = 0; i < 60; i++) physics.step(1 / 60);
  const bent = rods.map((rod) => rod.points()[12 * 3]);
  assert.ok(Math.max(...bent) > 0.02, `the tips moved ${bent} m along the swim`);
  // The fish (2.3 kg) outweighs the three tentacles (40 g each) fifty times, so it slows by a little, but it does slow.
  assert.ok(fish.linearVelocity[0] < 0.99, `the fish kept ${fish.linearVelocity[0]} m/s`);
  physics.dispose();
});

test('a rod refuses a centre line it cannot make and options out of range, naming the fix', () => {
  const physics = new Physics(null);
  // Each is a coded MargoError naming the input and its fix, with the help link.
  const refused = (message) => ({ name: 'MargoError', code: 'unsupported', message: new RegExp(`${message}.+#rods`) });
  assert.throws(() => new Rod(physics, { points: [[0, 0, 0]] }), refused('centre line'));
  assert.throws(() => new Rod(physics, { start: [0, 0, 0], end: [1, 0, 0], segments: 1 }), refused('from 2 to 4096'));
  assert.throws(() => new Rod(physics, { start: [0, 0, 0], end: [1, 0, 0], radius: -1 }), refused('radius'));
  assert.throws(() => new Rod(physics, { start: [0, 0, 0], end: [0, 0, 0] }), refused('length'));
  assert.throws(() => new Rod(physics, { start: [0, 0, 0], end: [1, 0, 0], loads: {} }), refused('segmentLoads'));
  assert.throws(() => new Rod(null, { start: [0, 0, 0], end: [1, 0, 0] }), refused('live Physics world'));
  assert.throws(() => new Rod(physics, { start: [0, 0, 0], end: [1, 0, 0], time: Number.NaN }), refused('time'));
  const probe = new Rod(physics, { start: [0, 0, 0], end: [1, 0, 0], segments: 4 });
  assert.throws(() => probe.points(new Float32Array(3)), refused('points buffer'));
  assert.throws(() => probe.frames(new Float32Array(3)), refused('frames buffer'));
  assert.throws(() => probe.release('middle'), refused('rod end'));
  probe.remove();
  assert.throws(() => segmentLoads(water([0, 0, 0]), { drag: -1 }), /drag/);
  assert.throws(() => segmentLoads(water([0, 0, 0]), { period: 0 }), /period/);
  assert.throws(() => segmentLoads({ density: 1000 }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /pass a SeaSurface.+#hydrodynamic-loads/,
  });
  const rod = new Rod(physics, { start: [0, 0, 0], end: [1, 0, 0] });
  rod.remove();
  assert.equal(rod.valid, false);
  assert.throws(
    () => rod.points(),
    (error) => error.code === 'state',
  );
  physics.dispose();
});

test('a clamped rod twisted by an end torque turns by T d / GJ at a distance d from the clamp', () => {
  // Saint-Venant torsion of a uniform shaft: the twist between two sections d apart under a torque T is T d / (G J). The
  // clamp is half a link of springs, so the last link's centre, L - l / 2 from it, turns by T (L - l / 2) / GJ in the
  // discrete rod exactly. What is left is the kernel's f32 rounding, about n links times sqrt(600 steps) units of 6e-8
  // (3.5e-5 at 24 links), held to 1e-4.
  for (const n of [8, 24]) {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const rod = new Rod(physics, {
      start: [0, 0, 0],
      end: [0, 1, 0],
      segments: n,
      attachStart: 'fixed',
      clamp: 'start',
    });
    const torque = 1,
      expected = (torque * (1 - rod.segmentLength / 2)) / rod.stiffness.twist;
    rod.segments[n - 1].addTorque([0, torque, 0]);
    for (let i = 0; i < 600; i++) physics.step(1 / 60);
    const f = rod.frames(),
      at = 4 * (n - 1),
      angle = 2 * Math.atan2(f[at + 1], f[at + 3]);
    assert.ok(
      Math.abs(angle / expected - 1) < 1e-4,
      `${n} links: the end turned ${angle} rad, T d / GJ is ${expected}`,
    );
    physics.dispose();
  }
});

test('a quarter ring clamped at one end and loaded across its plane bends and twists as Castigliano gives', () => {
  // A ring of radius R through a quarter turn, clamped at one end, a force P at the other across the ring's plane: at an
  // angle phi from the free end it carries a bending moment P R sin(phi) and a torque P R (1 - cos(phi)), so the tip moves
  // P R^3 (pi / (4 EI) + (3 pi / 4 - 2) / GJ) (Castigliano's theorem on the two energies). Bending and twisting both
  // carry it, about 2:1 here. Chords of the arc make the discrete ring first order in the links: 1.4%, 0.8% and 0.4%
  // short at 16, 32 and 64, so 64 links are held within 0.5% and each doubling must cut the error to under 0.6 of it.
  const errors = [];
  for (const n of [32, 64]) {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const radius = 1,
      points = [];
    for (let k = 0; k <= 256; k++) {
      const a = ((k / 256) * Math.PI) / 2;
      points.push([radius * Math.sin(a), radius * (1 - Math.cos(a)), 0]);
    }
    const rod = new Rod(physics, { points, segments: n, attachStart: 'fixed', clamp: 'start' });
    const force = 0.05,
      expected =
        force * radius ** 3 * (Math.PI / 4 / rod.stiffness.bend + ((3 * Math.PI) / 4 - 2) / rod.stiffness.twist);
    const before = rod.points();
    rod.segments[n - 1].addForceAtPoint([0, 0, force], [before[3 * n], before[3 * n + 1], before[3 * n + 2]]);
    for (let i = 0; i < 900; i++) physics.step(1 / 60);
    const tip = rod.points()[3 * n + 2] - before[3 * n + 2];
    errors.push(Math.abs(tip / expected - 1));
    physics.dispose();
  }
  assert.ok(errors[1] < 5e-3, `64 links: ${errors[1]} off Castigliano`);
  assert.ok(errors[1] < 0.6 * errors[0], `first order in the links: ${errors}`);
});

test("a weight on a rope's end hangs still at the rope's length, light or heavy", () => {
  // A rope pinned at the top with a free body on its end: the pin to the body is a spring between two bodies, and the body
  // must answer it in the same step. Treated as moving at its speed, a 2 kg weight was thrown 19 m up in 3 s and a 50 g one
  // blew the world up. At rest the rope stretches W L / EA, about 2e-5 m here, so the weight hangs within 1e-3 m of it.
  for (const mass of [0.05, 2]) {
    const physics = new Physics(null, { gravity: [0, -9.81, 0] });
    const weight = physics.addBody(null, { position: [0, -1, 0], colliders: [] });
    weight.setAdditionalMass(mass, [1e-3, 1e-3, 1e-3]);
    new Rod(physics, {
      start: [0, 0, 0],
      end: [0, -1, 0],
      segments: 30,
      radius: 0.01,
      density: 7800,
      bendStiffness: 1e-3,
      twistStiffness: 1e-3,
      attachStart: 'fixed',
      attachEnd: weight,
    });
    for (let i = 0; i < 240; i++) physics.step(1 / 60);
    assert.ok(Math.abs(weight.position[1] + 1) < 1e-3, `a ${mass} kg weight hangs at ${weight.position[1]} m`);
    assert.ok(
      Math.hypot(...weight.linearVelocity) < 1e-3,
      `a ${mass} kg weight still moves at ${weight.linearVelocity}`,
    );
    physics.dispose();
  }
});
