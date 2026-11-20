// The flood solver's measured bounds on the CPU reference (disaster water plan section 3, push 2): every bound the
// GPU solver (`water/flood`, push 3) must meet on WebGPU and the WebGL2 layer, met first by test/flood-reference.js in
// node against the exact solutions in test/flood-analytic.js. Bounds are the plan's; none was loosened to pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DRY, FloodReference, G, velocity } from './flood-reference.js';
import {
  belanger,
  bore,
  boreRunup,
  manning,
  reflectedBore,
  ritter,
  solitary,
  solitaryRunup,
  stoker,
  thacker,
  windStress,
  windTilt,
} from './flood-analytic.js';

const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual / expected - 1) <= tolerance,
    `${what}: ${actual} against ${expected} (${((actual / expected - 1) * 100).toFixed(3)}%, bound ${tolerance * 100}%)`,
  );
// The first cell from the east whose depth passes `level`, as the x of its east face.
const frontFromEast = (f, level) => {
  for (let i = f.nx - 1; i >= 0; i--) if (f.h[i] > level) return f.x(i) + f.dx / 2;
  return -Infinity;
};

test('a sheet above the dry depth keeps its speed: the desingularised velocity is m / h there (eps = DRY^4)', () => {
  // A fixed eps of 1e-12 gave a 0.1 mm sheet moving at 2 m/s a speed of 0.028 m/s, a drag on every moving shoreline.
  for (const h of [2 * DRY, 1e-5, 1e-4, 1e-3, 0.1, 10]) near(velocity(h, 2 * h), 2, 1e-6, `speed at depth ${h} m`);
  assert.equal(velocity(DRY, 1), 0);
  assert.equal(velocity(0, 1), 0);
});

test('a wall is the mirror of the flow beside it at both Runge-Kutta stages: a walled half equals its mirrored whole', () => {
  // The wall ghost feeds the edge cell's limited slopes; stage 2 once mirrored the start of the step, not U1, which put
  // 2.5% on the momentum of the cells next to a wall once a rarefaction reached it (the GPU kernel found it, push 3).
  const N = 24, dx = 0.5, dt = FloodReference.step(dx, 2, 2),
    half = new FloodReference({ nx: N, dx, bed: () => 0, h: (x) => (x < 6 ? 2 : 0.2), u: (x) => (x < 3 ? 0.4 : 0) }),
    whole = new FloodReference({ nx: 2 * N, dx, bed: () => 0, h: (x) => (Math.abs(x - N * dx) > N * dx - 6 ? 2 : 0.2), u: (x) => (x < 3 ? 0.4 : x > 2 * N * dx - 3 ? -0.4 : 0) });
  half.run(dt, 60);
  whole.run(dt, 60);
  for (let i = 0; i < N; i++) {
    assert.ok(Math.abs(half.h[i] - whole.h[i]) <= 1e-6, `depth at cell ${i}: ${half.h[i]} against ${whole.h[i]}`);
    assert.ok(Math.abs(half.hu[i] - whole.hu[i]) <= 1e-6, `momentum at cell ${i}: ${half.hu[i]} against ${whole.hu[i]}`);
  }
});

test('a long wave keeps its crest over a flat frictionless bed (simple wave; Stoker 1957, Whitham 1974): 1% over 500 m', () => {
  // A right-running simple wave, u = 2 (sqrt(g h) - sqrt(g h0)) so the invariant u - 2 sqrt(g h) is the still water's:
  // each depth travels unchanged at 3 sqrt(g h) - 2 sqrt(g h0) until the front breaks (here after about 1,400 m), so the
  // crest keeps its height a exactly (Stoker 1957, Water Waves, ch. 10; Whitham 1974, Linear and Nonlinear Waves,
  // ch. 13). A 0.1 m Gaussian hump of 9 cells (18 m) on 10 m of water, 2 m cells, CFL 0.25. Minmod slopes everywhere
  // clipped the crest to first order: 10.7% lost in 100 m, 27.2% in 500 m (KB-FLOOD-DAMP1); fifth-order WENO-Z in the wet
  // interior keeps it within 0.65%.
  const h0 = 10,
    a = 0.1,
    sigma = 18,
    dx = 2,
    x0 = 100,
    c0 = Math.sqrt(G * h0),
    eta = (x) => a * Math.exp(-(((x - x0) / sigma) ** 2)),
    f = new FloodReference({
      nx: 350,
      dx,
      bed: () => -h0,
      h: (x) => h0 + eta(x),
      u: (x) => 2 * (Math.sqrt(G * (h0 + eta(x))) - c0),
      boundary: { west: 'open', east: 'open' },
    }),
    speed = 3 * Math.sqrt(G * (h0 + a)) - 2 * c0,
    dt = FloodReference.step(dx, h0 + a, 2 * (Math.sqrt(G * (h0 + a)) - c0));
  for (const distance of [100, 250, 500]) {
    f.runTo(distance / speed, dt);
    // The crest: the parabola through the highest cell and its neighbours.
    let k = 0;
    for (let i = 1; i < f.nx; i++) if (f.h[i] > f.h[k]) k = i;
    const [l, m, r] = [f.h[k - 1], f.h[k], f.h[k + 1]].map((v) => v - h0),
      offset = (0.5 * (l - r)) / (l - 2 * m + r),
      crest = m - 0.25 * (l - r) * offset,
      at = f.x(k) + offset * dx;
    near(crest, a, 0.01, `crest after ${distance} m`);
    assert.ok(Math.abs(at - (x0 + distance)) <= dx / 2, `crest at ${at} m against ${x0 + distance} m after ${distance} m`);
  }
});

test('dam break on a dry bed (Ritter 1892, SWASHES 4.1.2): dam depth and speed, tail, front, L1 falling with resolution', () => {
  const h0 = 1,
    x0 = 50,
    T = 6,
    c = Math.sqrt(G * h0),
    errors = [],
    fronts = [];
  for (const nx of [400, 800, 1600]) {
    const dx = 100 / nx,
      f = new FloodReference({ nx, dx, bed: () => 0, h: (x) => (x < x0 ? h0 : 0) });
    f.runTo(T, FloodReference.step(dx, h0, 2 * c));
    const i0 = Math.round(x0 / dx),
      depth = (f.h[i0 - 1] + f.h[i0]) / 2,
      speed = (f.hu[i0 - 1] / f.h[i0 - 1] + f.hu[i0] / f.h[i0]) / 2;
    near(depth, (4 / 9) * h0, 0.03, 'depth at the dam');
    near(speed, (2 / 3) * c, 0.03, 'speed at the dam');
    // Tail: the rarefaction's head runs back at sqrt(g h0) from x0. Its corner is smeared over a few cells, so it is
    // read where the depth crosses 0.9 h0 against where the exact fan crosses it, x0 + 2t (c - 1.5 sqrt(0.9 g h0)),
    // which lies within 0.1 c t of the head; within 2 cells.
    let tail = 0;
    for (let i = 0; i < nx; i++)
      if (f.h[i] < 0.9 * h0) {
        const a = f.h[i - 1],
          b = f.h[i];
        tail = f.x(i - 1) + ((a - 0.9 * h0) / (a - b)) * dx;
        break;
      }
    const exactTail = x0 + 2 * T * (c - 1.5 * Math.sqrt(0.9 * G * h0));
    assert.ok(Math.abs(ritter(h0, x0, exactTail, T).h - 0.9 * h0) < 1e-9, 'the exact fan is 0.9 h0 there');
    assert.ok(Math.abs(tail - exactTail) <= 2 * dx, `tail at ${tail}, exact ${exactTail}`);
    const front = frontFromEast(f, 1e-4),
      exactFront = x0 + 2 * c * T;
    assert.ok(front <= exactFront, `front ${front} ahead of 2 sqrt(g h0) t`);
    // The dry-bed tip is first order (the depth there goes to zero, so every scheme smears it): it lags by 14% at
    // 400 cells, 11% at 800 and 7.5% at 1600 (measured), so the 10% bound is held at 1600 and the lag must shrink.
    fronts.push(front - x0);
    if (nx === 1600) assert.ok(front - x0 >= 0.9 * (exactFront - x0), `front ${front} more than 10% behind ${exactFront}`);
    let l1 = 0;
    for (let i = 0; i < nx; i++) l1 += Math.abs(f.h[i] - ritter(h0, x0, f.x(i), T).h) * dx;
    errors.push(l1 / (h0 * 3 * c * T));
  }
  assert.ok(errors[0] < 0.02, `L1 ${errors[0]} of h0 over the moving zone at 400 cells`);
  assert.ok(errors[1] < errors[0] && errors[2] < errors[1], `L1 does not fall with resolution: ${errors}`);
  assert.ok(fronts[1] > fronts[0] && fronts[2] > fronts[1], `the front lag does not shrink with resolution: ${fronts}`);
});

test('dam break on a wet bed (Stoker 1957, SWASHES 4.1.1): middle depth and shock speed within 2%', () => {
  for (const ratio of [0.1, 0.5]) {
    const hl = 1,
      hr = ratio,
      x0 = 100,
      T = 10,
      nx = 800,
      dx = 200 / nx,
      s = stoker(hl, hr, x0),
      f = new FloodReference({ nx, dx, bed: () => 0, h: (x) => (x < x0 ? hl : hr) });
    f.runTo(T, FloodReference.step(dx, hl, 2 * Math.sqrt(G * hl)));
    const xb = x0 + T * (2 * Math.sqrt(G * hl) - 3 * Math.sqrt(G * s.hm)),
      xc = x0 + T * s.shock;
    near(f.h[Math.floor((xb + xc) / 2 / dx)], s.hm, 0.02, `middle depth at ${ratio}`);
    near((frontFromEast(f, (s.hm + hr) / 2) - x0) / T, s.shock, 0.02, `shock speed at ${ratio}`);
  }
});

test('bores (Rankine-Hugoniot; Stoker 1957, Whitham 1974): speed within 2%, reflected depth within 3%', () => {
  for (const ratio of [1.5, 2, 4]) {
    const h0 = 1,
      h1 = ratio,
      b = bore(h0, h1),
      x0 = 50,
      T = 20,
      nx = 1200,
      dx = 300 / nx,
      f = new FloodReference({
        nx,
        dx,
        bed: () => 0,
        h: (x) => (x < x0 ? h1 : h0),
        u: (x) => (x < x0 ? b.u1 : 0),
        boundary: { west: () => ({ h: h1, hu: h1 * b.u1 }) },
      });
    f.runTo(T, FloodReference.step(dx, h1, b.u1 + Math.sqrt(G * h1)));
    near((frontFromEast(f, (h0 + h1) / 2) - x0) / T, b.speed, 0.02, `bore speed at h1/h0 ${ratio}`);
  }
  assert.ok(Math.abs(bore(1, 2).speed - 5.42) < 0.01, 'h0 1 m, h1 2 m: 5.42 m/s');
  const b = bore(1, 2),
    reflected = reflectedBore(2, b.u1),
    nx = 800,
    dx = 100 / nx,
    f = new FloodReference({
      nx,
      dx,
      bed: () => 0,
      h: (x) => (x < 20 ? 2 : 1),
      u: (x) => (x < 20 ? b.u1 : 0),
      boundary: { west: () => ({ h: 2, hu: 2 * b.u1 }) },
    });
  f.runTo(25, FloodReference.step(dx, reflected.h2, b.u1 + Math.sqrt(G * reflected.h2)));
  near(f.h[nx - 5], reflected.h2, 0.03, 'reflected bore depth');
});

test('standing hydraulic jump (Belanger; Chanson 2009): h2 / h1 within 3% at Fr 2, 3, 5, and it stays in place', () => {
  for (const [Fr, ratio] of [
    [2, 2.37],
    [3, 3.77],
    [5, 6.59],
  ]) {
    assert.ok(Math.abs(belanger(Fr) - ratio) < 0.005, `Belanger ${Fr}`);
    const h1 = 0.5,
      u1 = Fr * Math.sqrt(G * h1),
      q = h1 * u1,
      h2 = h1 * belanger(Fr),
      nx = 400,
      dx = 100 / nx,
      f = new FloodReference({
        nx,
        dx,
        bed: () => 0,
        h: (x) => (x < 50 ? h1 : h2),
        u: (x) => (x < 50 ? u1 : q / h2),
        boundary: { west: () => ({ h: h1, hu: q }), east: () => ({ h: h2, hu: q }) },
      });
    f.runTo(30, FloodReference.step(dx, h2, u1));
    near(f.h[nx - 20] / f.h[20], belanger(Fr), 0.03, `h2 / h1 at Fr ${Fr}`);
    let jump = 0;
    for (let i = 0; i < nx; i++)
      if (f.h[i] > (h1 + h2) / 2) {
        jump = f.x(i);
        break;
      }
    assert.ok(Math.abs(jump - 50) <= 2 * dx, `the jump moved to ${jump}`);
  }
});

test('solitary-wave run-up (Synolakis 1987; NOAA canonical case): R / d on 1 : 19.85 at H / d 0.0185 within 5%', () => {
  const d = 1,
    H = 0.0185,
    cot = 19.85,
    dx = 0.05,
    sol = solitary(H, d, 0),
    Xs = cot * d + Math.acosh(Math.sqrt(20)) / sol.gamma,
    nx = Math.round(125 / dx),
    X = (x) => x - 5,
    bed = (x) => (X(x) < cot * d ? -X(x) / cot : -d),
    eta = (x) => H / Math.cosh(sol.gamma * (X(x) - Xs)) ** 2,
    f = new FloodReference({
      nx,
      dx,
      bed,
      h: (x) => Math.max(0, eta(x) - bed(x)),
      // Moving shoreward (towards -x) with the long-wave velocity of its own height.
      u: (x) => (X(x) > (cot * d) / 2 ? -Math.sqrt(G / d) * eta(x) : 0),
      boundary: { east: 'open' },
    });
  assert.ok(Math.abs(solitaryRunup(H / d, cot) - 0.086) < 0.0005, 'the law gives 0.086');
  let runup = -Infinity;
  const dt = FloodReference.step(dx, d + H, 0.1);
  while (f.time < 40) {
    f.run(dt, 10);
    for (let i = 0; i < nx; i++)
      if (f.h[i] > 1e-4) {
        runup = Math.max(runup, f.h[i] + f.b[i]);
        break;
      }
  }
  near(runup / d, solitaryRunup(H / d, cot), 0.05, 'run-up R / d');
});

test('a trough-first N-wave bares the bed before its crest arrives (Tadepalli, Synolakis 1994)', () => {
  const d = 1,
    cot = 19.85,
    dx = 0.1,
    A = 0.02,
    gamma = Math.sqrt((3 * A) / (4 * d)),
    nx = 1250,
    X = (x) => x - 5,
    bed = (x) => (X(x) < cot * d ? -X(x) / cot : -d),
    // A depression nearer the shore and an elevation behind it, both moving shoreward.
    eta = (x) => -A / Math.cosh(gamma * (X(x) - 45)) ** 2 + A / Math.cosh(gamma * (X(x) - 75)) ** 2,
    f = new FloodReference({
      nx,
      dx,
      bed,
      h: (x) => Math.max(0, eta(x) - bed(x)),
      u: (x) => (X(x) > cot * d ? -Math.sqrt(G / d) * eta(x) : 0),
      boundary: { east: 'open' },
    });
  const shoreline = () => {
    for (let i = 0; i < nx; i++) if (f.h[i] > 1e-4) return f.h[i] + f.b[i];
    return NaN;
  };
  let lowest = 0,
    lowestAt = 0,
    highestAt = 0,
    highest = 0;
  const dt = FloodReference.step(dx, d + A, 0.1);
  while (f.time < 60) {
    f.run(dt, 10);
    const s = shoreline();
    if (s < lowest) [lowest, lowestAt] = [s, f.time];
    if (s > highest) [highest, highestAt] = [s, f.time];
  }
  assert.ok(lowest < -0.5 * A, `the shoreline drew back to ${lowest} m`);
  assert.ok(lowestAt < highestAt, `the drawback (${lowestAt} s) did not come before the run-up (${highestAt} s)`);
  assert.ok(highest > 0, 'the crest then runs up');
});

test('bore run-up stays below U0^2 / 2g of the shoreline speed (Shen, Meyer 1963)', () => {
  const dx = 0.1,
    nx = 1200,
    cot = 10,
    X = (x) => x - 10,
    bed = (x) => (X(x) < 10 ? -X(x) / cot : -1),
    b = bore(1, 1.5),
    f = new FloodReference({
      nx,
      dx,
      bed,
      h: (x) => Math.max(0, (X(x) > 80 ? 0.5 : 0) - bed(x)),
      u: (x) => (X(x) > 80 ? -b.u1 : 0),
      boundary: { east: () => ({ h: 1.5, hu: -1.5 * b.u1 }) },
    });
  let speed = 0,
    runup = -Infinity;
  const dt = FloodReference.step(dx, 2, b.u1);
  while (f.time < 40) {
    f.run(dt, 5);
    for (let i = 0; i < nx; i++)
      if (f.h[i] > 1e-3) {
        speed = Math.max(speed, -f.hu[i] / f.h[i]);
        runup = Math.max(runup, f.h[i] + f.b[i]);
        break;
      }
  }
  assert.ok(runup > 0.2, `the bore ran up ${runup} m`);
  assert.ok(runup <= boreRunup(speed) * 1.02, `run-up ${runup} m above U0^2 / 2g = ${boreRunup(speed)} m`);
});

test('Thacker planar surface in a paraboloid (SWASHES 4.2.2): 3 periods at 200 x 200, shoreline and amplitude', () => {
  const th = thacker(),
    N = 200,
    dx = 4 / N,
    wet = (x, y) => th.depth(x, y, 0) > 0,
    f = new FloodReference({
      nx: N,
      ny: N,
      dx,
      bed: th.bed,
      h: (x, y) => th.depth(x, y, 0),
      u: (x, y) => (wet(x, y) ? th.u(0) : 0),
      v: (x, y) => (wet(x, y) ? th.v(0) : 0),
    });
  const T = 3 * th.period;
  f.runTo(T, FloodReference.step(dx, 0.1, 0.8));
  let negative = 0;
  for (const h of f.h) if (h < 0) negative++;
  assert.equal(negative, 0, 'no negative depth');
  // Shoreline along the row through the centre, within 2 cells at both ends.
  const j = N / 2;
  const ends = (depth) => {
    let first = -1,
      last = -1;
    for (let i = 0; i < N; i++)
      if (depth(i) > 1e-3) {
        if (first < 0) first = i;
        last = i;
      }
    return [first, last];
  };
  const [a, b] = ends((i) => f.h[j * N + i]),
    [ea, eb] = ends((i) => th.depth(f.x(i), f.z(j), T));
  assert.ok(Math.abs(a - ea) <= 2 && Math.abs(b - eb) <= 2, `shoreline cells ${a}, ${b} against ${ea}, ${eb}`);
  // Amplitude: the tilt of the planar surface (2 eta h0 / a^2 = 0.1) by least squares within 0.4 m of the centre.
  let gx = 0,
    gy = 0,
    g2 = 0;
  for (let jj = 0; jj < N; jj++)
    for (let i = 0; i < N; i++) {
      const x = f.x(i) - 2,
        y = f.z(jj) - 2,
        k = jj * N + i;
      if (Math.hypot(x, y) < 0.4) {
        gx += x * (f.h[k] + f.b[k]);
        gy += y * (f.h[k] + f.b[k]);
        g2 += x * x;
      }
    }
  const tilt = Math.hypot(gx, gy) / g2;
  assert.ok(tilt > 0.95 * 0.1 && tilt < 1.01 * 0.1, `amplitude ${tilt} against 0.1 (loss under 5%)`);
});

test('lake at rest over steps and an island (Audusse 2004; SWASHES 3.1.2): speed under 1e-4 m/s after 10,000 steps', () => {
  const bed = (x, z) =>
      (x > 10 && x < 14 ? 0.5 : 0) + (z > 20 ? 0.3 : 0) + Math.max(0, 2 - Math.hypot(x - 28, z - 12)),
    f = new FloodReference({ nx: 40, ny: 40, dx: 1, bed, h: (x, z) => Math.max(0, 1 - bed(x, z)) });
  f.run(FloodReference.step(1, 1), 10000);
  assert.ok(f.maxSpeed() < 1e-4, `speed ${f.maxSpeed()}`);
});

test('volume: a closed basin with buildings drifts under 1e-5 over 20,000 steps, and no water enters a block', () => {
  const block = (x, z) => Math.floor(x / 6) % 2 === 1 && Math.floor(z / 6) % 2 === 1,
    bed = (x, z) => (block(x, z) ? 5 : 0),
    f = new FloodReference({
      nx: 48,
      ny: 48,
      dx: 1,
      bed,
      h: (x, z) => (block(x, z) ? 0 : x < 12 ? 2 : 0.2),
      roughness: 0.02,
    }),
    before = f.volume();
  f.run(FloodReference.step(1, 2, 4), 20000);
  assert.ok(Math.abs(f.volume() - before) / before < 1e-5, `drift ${Math.abs(f.volume() - before) / before}`);
  for (let k = 0; k < f.h.length; k++) if (f.b[k] > 0) assert.equal(f.h[k], 0, 'water inside a block');
});

test('streets (Soares-Frazao, Zech 2008): a dam break into a town is deeper in front of the first row than on open ground', () => {
  // A 5 x 5 grid of 3 m blocks with 2 m streets from x = 30; the reservoir of 2 m behind x = 10 on a dry bed.
  const block = (x, z) => x >= 30 && x < 55 && (x - 30) % 5 < 3 && z >= 10 && z < 35 && (z - 10) % 5 < 3,
    run = (town) => {
      const f = new FloodReference({
        nx: 80,
        ny: 45,
        dx: 1,
        bed: (x, z) => (town && block(x, z) ? 5 : 0),
        h: (x, z) => (x < 10 ? 2 : 0),
        roughness: 0.01,
      });
      f.runTo(12, FloodReference.step(1, 2, 5));
      return f;
    },
    town = run(true),
    open = run(false),
    k = (x, z) => Math.floor(z) * 80 + Math.floor(x);
  for (let i = 0; i < town.h.length; i++) if (town.b[i] > 0) assert.equal(town.h[i], 0, 'water inside a block');
  assert.ok(town.h[k(29.5, 11.5)] > open.h[k(29.5, 11.5)] * 1.05, 'deeper in front of the first row');
});

test('volume with sources: inflow x time within 1e-4, 100 mm/h of rain for 60 s is 1.667 mm within 1%', () => {
  const flow = new FloodReference({
      nx: 30,
      ny: 30,
      dx: 2,
      bed: () => 0,
      h: () => 0.5,
      sources: () => ({ inflow: [{ x: 30, z: 30, discharge: 5 }] }),
    }),
    before = flow.volume();
  flow.runTo(100, 0.05);
  near(flow.volume() - before, 500, 1e-4, 'inflow volume');
  const rain = new FloodReference({ nx: 20, ny: 20, dx: 1, bed: () => 0, sources: () => ({ rain: 0.1 / 3600 }) });
  rain.runTo(60, 0.05);
  near((rain.volume() / 400) * 1000, 100 / 60, 0.01, 'rain depth in mm');
});

test('a wall one cell wide holds water below its top exactly, straight or diagonal', () => {
  for (const diagonal of [false, true]) {
    const wall = (x, z) => (diagonal ? Math.floor(x) === Math.floor(z) : Math.floor(x) === 20),
      behind = (x, z) => (diagonal ? x < z : x < 20),
      f = new FloodReference({
        nx: 40,
        ny: 40,
        dx: 1,
        bed: (x, z) => (wall(x, z) ? 3 : 0),
        h: (x, z) => (!wall(x, z) && behind(x, z) ? 2.5 : 0),
      });
    f.run(FloodReference.step(1, 2.5, 3), 3000);
    for (let j = 0; j < 40; j++)
      for (let i = 0; i < 40; i++)
        if (!wall(f.x(i), f.z(j)) && !behind(f.x(i), f.z(j))) assert.equal(f.h[j * 40 + i], 0, `leak at ${i}, ${j}`);
  }
});

test('Manning uniform flow on a slope within 2% of h^(2/3) sqrt(S) / n (Chow 1959)', () => {
  const S = 0.001,
    n = 0.03,
    q = 2,
    hn = manning.normalDepth(q, S, n),
    nx = 400,
    dx = 2000 / nx,
    f = new FloodReference({
      nx,
      dx,
      bed: (x) => -S * x,
      h: () => hn,
      u: () => q / hn,
      roughness: n,
      boundary: {
        west: () => ({ h: hn, hu: q, b: (S * dx) / 2 }),
        east: () => ({ h: hn, hu: q, b: -S * (2000 + dx / 2) }),
      },
    });
  f.runTo(2000, FloodReference.step(dx, hn, q / hn));
  const k = nx / 2;
  near(f.hu[k] / f.h[k], manning.speed(f.h[k], S, n), 0.02, 'Manning speed');
  near(f.h[k], hn, 0.02, 'normal depth');
});

test('steady wind over a closed flat basin tilts it by rho_a Cd U^2 / (rho g h) within 5% (30 m/s, 2 m, 1 km: 0.14 m)', () => {
  const U = 30,
    d = 2,
    nx = 200,
    dx = 1000 / nx,
    f = new FloodReference({
      nx,
      dx,
      bed: () => -d,
      h: () => d,
      roughness: 0.03,
      sources: () => ({ wind: [windStress(U), 0] }),
    }),
    dt = FloodReference.step(dx, d, 1);
  assert.ok(Math.abs(windTilt(U, d, 1000) - 0.14) < 0.005);
  f.runTo(3000, dt);
  // Averaged over two seiche periods, which the light friction has not yet damped out.
  let sum = 0,
    count = 0;
  const end = f.time + (4 * 1000) / Math.sqrt(G * d);
  while (f.time < end) {
    f.run(dt);
    sum += ((f.h[nx - 1] - f.h[0]) * 1000) / (dx * (nx - 1));
    count++;
  }
  near(sum / count, windTilt(U, d, 1000), 0.05, 'wind tilt');
});
