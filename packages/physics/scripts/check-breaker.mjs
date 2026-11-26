// A plunging breaker from a dispersively focused packet (Erinin et al. 2023: 32 components, N dw / w = 0.77, f0 =
// 1.15 Hz, water 0.91 m deep), inside a FlipSolver box held at its sides to the linear packet (finite-depth linear
// theory), measured as Erinin et al. measure theirs:
// - the crest point is the highest point of the breaking crest, tracked frame to frame and placed to a fraction of a
//   cell by a parabola through the surface's column heights round it;
// - jet formation is the first frame the crest overhangs outside air (water above air open to the sky, above water),
//   for four frames running; impact is the last frame of that overhang, when the cavity under the jet closes;
// - the crest's speed at formation and the jet tip's velocity at impact are derivatives of cubic fits (the crest from
//   0.2 s before formation to impact, the tip from its highest point to impact), the tip being the foremost point of
//   the water over the cavity;
// - H_f and L_f run from the crest point to the lowest point of the trough behind it at formation; y_max is the crest's
//   greatest height above the still level before impact.
// Usage (after npm run build): node scripts/check-breaker.mjs [S] [cell size, m] [start, s] [box length, m] [depth, m]
// Results and what they show: docs/limits.md, "Grid-particle liquids" (KB-FLIP-CREST1 in docs/known-bugs.md).
import { FlipSolver } from '../dist/flip.js';
import { PhysicsWorld } from '../dist/world.js';

const G = 9.81,
  S = Number(process.argv[2] ?? 0.55),
  h = Number(process.argv[3] ?? 0.0125),
  t0 = Number(process.argv[4] ?? 1.6),
  L = Number(process.argv[5] ?? 5.6),
  depth = Number(process.argv[6] ?? 0.91),
  N = 32,
  wbar = 2 * Math.PI * 1.15,
  dw = (0.77 * wbar) / N,
  // The linear packet focuses at x = 0, t = 3 s; the box starts it t0 s in, from linear waves.
  tb = 3.0;
// Finite-depth dispersion, w^2 = g k tanh(k d), by Newton's method.
const kOf = (w) => {
  let k = (w * w) / G;
  for (let i = 0; i < 50; i++) {
    const th = Math.tanh(k * depth);
    k -= (G * k * th - w * w) / (G * th + G * k * depth * (1 - th * th));
  }
  return k;
};
const comps = Array.from({ length: N }, (_, i) => {
  const w = wbar + (i - (N - 1) / 2) * dw,
    k = kOf(w);
  return { w, k, a: S / N / k, sh: Math.sinh(k * depth) };
});
const elevation = (x, t) => {
  let e = 0;
  for (const c of comps) e += c.a * Math.cos(c.k * x - c.w * (t - tb));
  return e;
};
// The packet's velocities, stretched to the surface above the still level (Wheeler).
const sample = (x, y, t, out) => {
  const ys = Math.min(y - elevation(x, t), 0);
  let u = 0,
    v = 0;
  for (const c of comps) {
    const th = c.k * x - c.w * (t - tb),
      z = c.k * (ys + depth);
    u += ((c.a * c.w * Math.cosh(z)) / c.sh) * Math.cos(th);
    v += ((c.a * c.w * Math.sinh(z)) / c.sh) * Math.sin(th);
  }
  out.velocity[0] = u;
  out.velocity[1] = v;
  out.velocity[2] = 0;
  return out;
};
const air = 0.4,
  x0 = -3,
  nx = Math.round(L / h),
  ny = Math.round((depth + air) / h),
  liquid = new FlipSolver(),
  rate = 240,
  world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
    cells: [nx, ny, 1],
    cellSize: h,
    origin: [x0, -depth, 0],
    sea: {
      elevation: (x, _z, t) => elevation(x, t + t0),
      water: {
        sample: (x, y, _z, t, o = { velocity: [0, 0, 0], density: 1000, temperature: 288 }) => sample(x, y, t + t0, o),
      },
    },
    blend: 8,
    rate: 2,
    maxSubsteps: 256,
    capacity: nx * ny * 8,
  });
const lo = x0 + 12 * h,
  hi = x0 + L - 12 * h,
  occ = new Uint8Array(nx * ny),
  outside = new Uint8Array(nx * ny),
  stack = new Int32Array(nx * ny),
  gapOf = new Int32Array(nx),
  frames = [],
  start = performance.now();
let track = null;
for (let f = 1; f <= Math.round((tb + 1.4 - t0) * rate); f++) {
  world.advance(f);
  const t = t0 + f / rate,
    p = liquid.positions(),
    n = p.length / 3;
  occ.fill(0);
  // The crest point: the highest particle, near the last frame's once the packet gathers.
  let top = -1e9,
    topX = 0;
  const near = t >= tb - 0.6 && track !== null;
  for (let q = 0; q < n; q++) {
    const x = p[3 * q],
      y = p[3 * q + 1],
      i = Math.floor((x - x0) / h),
      j = Math.floor((y + depth) / h);
    if (i >= 0 && i < nx && j >= 0 && j < ny) occ[j * nx + i] = 1;
    if (x < lo || x > hi || (near && Math.abs(x - track) > 0.12)) continue;
    if (y > top) [top, topX] = [y, x];
  }
  track = topX;
  // The air outside: empty cells reached from the top row through empty cells, in a window round the crest.
  const ci = Math.floor((topX - x0) / h),
    i0 = Math.max(0, ci - Math.round(0.4 / h)),
    i1 = Math.min(nx - 1, ci + Math.round(0.5 / h)),
    j0 = Math.max(0, Math.round((depth - 0.3) / h));
  outside.fill(0);
  let sp = 0;
  for (let i = i0; i <= i1; i++)
    if (!occ[(ny - 1) * nx + i]) {
      outside[(ny - 1) * nx + i] = 1;
      stack[sp++] = (ny - 1) * nx + i;
    }
  while (sp > 0) {
    const c = stack[--sp],
      i = c % nx,
      j = (c - i) / nx;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ii = i + di,
        jj = j + dj;
      if (ii < i0 || ii > i1 || jj < j0 || jj >= ny) continue;
      const cc = jj * nx + ii;
      if (occ[cc] || outside[cc]) continue;
      outside[cc] = 1;
      stack[sp++] = cc;
    }
  }
  // Overhanging columns ahead of the crest: water over outside air over water.
  let tipCol = -1;
  gapOf.fill(-1);
  for (let i = ci; i <= Math.min(i1, ci + Math.round(0.35 / h)); i++) {
    let j = ny - 1;
    while (j >= j0 && !occ[j * nx + i]) j--;
    if (j < j0) continue;
    while (j >= j0 && occ[j * nx + i]) j--;
    if (j < j0 || !outside[j * nx + i]) continue;
    const gap = j;
    while (j >= j0 && !occ[j * nx + i]) j--;
    if (j >= j0) [gapOf[i], tipCol] = [gap, i];
  }
  // The jet tip: the foremost particle of the water over the cavity.
  let tip = null;
  if (tipCol >= 0) {
    let bx = -1e9,
      by = 0;
    for (let q = 0; q < n; q++) {
      const x = p[3 * q],
        y = p[3 * q + 1],
        i = Math.floor((x - x0) / h),
        j = Math.floor((y + depth) / h);
      if (i < ci || i > tipCol || gapOf[i] < 0 || j <= gapOf[i]) continue;
      if (x > bx) [bx, by] = [x, y];
    }
    if (bx > -1e9) tip = [bx, by];
  }
  // The surface's height in one-cell columns from 0.9 m behind the crest to it, for the trough.
  const back = Math.round(0.9 / h),
    tops = new Float64Array(back + 1).fill(-1e9);
  for (let q = 0; q < n; q++) {
    const c = Math.floor((p[3 * q] - (topX - 0.9)) / h);
    if (c >= 0 && c <= back && p[3 * q + 1] > tops[c]) tops[c] = p[3 * q + 1];
  }
  // The crest point to a fraction of a cell: a parabola through the surface's column heights within 4 cm of the
  // highest column near the tracked crest.
  const lo2 = topX - 0.3,
    nn = Math.round(0.6 / h),
    tp = new Float64Array(nn).fill(-1e9);
  for (let q = 0; q < n; q++) {
    const c = Math.floor((p[3 * q] - lo2) / h);
    if (c >= 0 && c < nn && p[3 * q + 1] > tp[c]) tp[c] = p[3 * q + 1];
  }
  let m = 0;
  for (let c = 1; c < nn; c++) if (tp[c] > tp[m]) m = c;
  const w = Math.max(2, Math.round(0.04 / h)),
    Sx = [0, 0, 0, 0, 0],
    T = [0, 0, 0];
  for (let c = m - w; c <= m + w; c++) {
    if (c < 0 || c >= nn || tp[c] < -1e8) continue;
    const x = (c - m) * h,
      y = tp[c];
    Sx[0]++;
    Sx[1] += x;
    Sx[2] += x * x;
    Sx[3] += x * x * x;
    Sx[4] += x * x * x * x;
    T[0] += y;
    T[1] += x * y;
    T[2] += x * x * y;
  }
  const A = [
    [Sx[0], Sx[1], Sx[2], T[0]],
    [Sx[1], Sx[2], Sx[3], T[1]],
    [Sx[2], Sx[3], Sx[4], T[2]],
  ];
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++)
      if (r !== c) {
        const f2 = A[r][c] / A[c][c];
        for (let k = c; k < 4; k++) A[r][k] -= f2 * A[c][k];
      }
  const a0 = A[0][3] / A[0][0],
    b0 = A[1][3] / A[1][1],
    c0 = A[2][3] / A[2][2],
    xs = c0 < 0 ? Math.max(-w * h, Math.min(w * h, -b0 / (2 * c0))) : 0;
  frames.push({ t, cx: lo2 + (m + 0.5) * h + xs, cy: a0 + b0 * xs + c0 * xs * xs, tip, tops });
}
// A least-squares cubic in t - tc; its first derivative at tc.
const slope = (ts, xs, tc) => {
  const A = Array.from({ length: 4 }, () => new Array(5).fill(0));
  ts.forEach((t, q) => {
    const d = t - tc,
      pw = [1, d, d * d, d * d * d];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) A[r][c] += pw[r] * pw[c];
      A[r][4] += pw[r] * xs[q];
    }
  });
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 4; r++)
      if (r !== c) {
        const m = A[r][c] / A[c][c];
        for (let k = c; k < 5; k++) A[r][k] -= m * A[c][k];
      }
  }
  return A[1][4] / A[1][1];
};
const fi = frames.findIndex((fr, i) => fr.tip && frames.slice(i, i + 4).every((g) => g.tip));
if (fi < 0) {
  console.log('no plunge: the crest never overhangs outside air; raise S or refine the cells');
  process.exitCode = 1;
} else report(fi);

/** Erinin et al.'s measures of the plunge that starts at frame `fi`. */
function report(fi) {
  let ii = fi;
  while (ii + 1 < frames.length && frames[ii + 1].tip) ii++;
  const tf = frames[fi].t,
    ti = frames[ii].t,
    crest = frames.filter((fr) => fr.t >= tf - 0.2 && fr.t <= ti),
    uc = slope(
      crest.map((fr) => fr.t),
      crest.map((fr) => fr.cx),
      tf,
    ),
    jet = frames.slice(fi, ii + 1),
    highest = jet.reduce((b, fr, i) => (fr.tip[1] > jet[b].tip[1] ? i : b), 0),
    fall = jet.slice(highest),
    ux = slope(
      fall.map((fr) => fr.t),
      fall.map((fr) => fr.tip[0]),
      ti,
    ),
    uy = slope(
      fall.map((fr) => fr.t),
      fall.map((fr) => fr.tip[1]),
      ti,
    ),
    Vji = Math.hypot(ux, uy);
  let trough = 1e9,
    troughX = 0;
  frames[fi].tops.forEach((y, c) => {
    if (y > -1e8 && y < trough) [trough, troughX] = [y, frames[fi].cx - 0.9 + (c + 0.5) * h];
  });
  const mm = (v) => (v * 1000).toFixed(1);
  console.log(
    `S ${S}, cells ${h * 100} cm, start ${(tb - t0).toFixed(2)} s before the focus, box ${L} m, ${depth} m deep`,
  );
  console.log(
    `y_max ${mm(Math.max(...frames.slice(0, ii + 1).map((fr) => fr.cy)))} mm, H_f ${mm(frames[fi].cy - trough)} mm, ` +
      `L_f ${mm(frames[fi].cx - troughX)} mm (Erinin et al.: 107.8 to 111.5, 98.6 to 105.8, 551.6 to 594.3)`,
  );
  console.log(
    `formation to impact ${((ti - tf) * 1000).toFixed(0)} ms, the tip ${mm(frames[ii].tip[0] - jet[0].tip[0])} mm on ` +
      `and ${mm(jet[0].tip[1] - frames[ii].tip[1])} mm down (148.9 to 169.7, 240.1 to 284.1, 41.6 to 53.4)`,
  );
  console.log(
    `crest ${uc.toFixed(3)} m/s at formation, jet tip ${Vji.toFixed(3)} m/s at ` +
      `${((Math.atan2(-uy, ux) * 180) / Math.PI).toFixed(1)} degrees at impact (1.511 to 1.536, 1.904 to 2.010, 21.9 to 27.6)`,
  );
  console.log(
    `jet tip over crest ${(Vji / uc).toFixed(3)} (1.24 to 1.33); ${((performance.now() - start) / 1000).toFixed(0)} s`,
  );
}
