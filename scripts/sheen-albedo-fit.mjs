// Derives the directional albedo of our own sheen BRDF and fits the table behind materialLobesSheenAlbedo
// (sheenAlbedoWGSL in packages/shared/sheen.js). Nothing here comes from another engine: the BRDF is
// materialLobesSheenBRDF as written in that file, i.e. the KHR_materials_sheen Charlie distribution
// (Estevez & Kulla 2017, "Production Friendly Microfacet Sheen BRDF") with alpha = roughness^2 and its own
// height-correlated shadowing 1 / (1 + Lambda(v) + Lambda(l)), Lambda from the paper's fitted curve (Table 1).
// E(mu, r) = integral over the hemisphere of f(l, v) (n.l) dl with n.v = mu.
//
//   node scripts/sheen-albedo-fit.mjs              integrate, fit, validate; print the table for shared/sheen.js
//   node scripts/sheen-albedo-fit.mjs --compare    also measure the Enterprise PBR table layout (docs/clean-room.md)
//
// The representation (sheenAlbedoGrid in shared/sheen.js): E = clamp(exp(T(u, v)) / R, 0, 1) with R = max(r, 1e-4),
// T a 16 x 16 table read bilinearly, v = sqrt(r) and u = (mu (R + k) / (R + k mu))^p. Two measured facts set it: for
// small r the albedo is (1 / r) g(mu / r) with g nearly the same for every r (so ln(E R) is smooth where E itself is
// a cliff, and u is a function of mu / r alone there), and for r near 1 it rises over the last 0.01 of mu before
// grazing (so the power p spreads that end out). Node values are weighted least squares on ln(E R), weight
// min(E, 1)^2 (an error of d in ln E moves E by about E d), then Lawson's reweighting toward minimax.
// The target is min(E, 1): the fitted Lambda lets E pass 1 at grazing for small r (the Enterprise PBR furnace test
// reports the same brightening), and the shader uses E as an energy fraction (base * (1 - sheenMax * E), sheen * E
// for ambient), so it stays in [0, 1].
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { sheenAlbedoGrid, sheenAlbedoTable, sheenAlbedoWGSL } from '../packages/shared/sheen.js';
import { wgslModule } from '../tests/support/wgsl-eval.js';

const ROUGHNESS_FLOOR = 1e-4; // materialLobesSheenBRDF uses max(roughness, 0.0001)

/**
 * Estevez and Kulla 2017, eq. 3 and Table 1: Lambda(cos) = exp(L(cos)) below cos 0.5, else exp(2 L(0.5) - L(1 - cos)),
 * L(x) = a / (1 + b x^c) + d x + e, each of a..e interpolated as (1 - alpha)^2 P(0) + (1 - (1 - alpha)^2) P(1). The
 * paper's roughness is the distribution's own parameter, alpha = roughness^2 here (KHR_materials_sheen).
 */
export function sheenLambda(cos, alpha) {
  const w = (1 - alpha) ** 2,
    m = (p0, p1) => w * p0 + (1 - w) * p1,
    curve = (x) =>
      m(25.3245, 21.5473) / (1 + m(3.32435, 3.82987) * Math.max(x, 1e-12) ** m(0.16801, 0.19823)) +
      m(-1.27393, -1.9776) * x +
      m(-4.85967, -4.32054);
  return Math.exp(cos < 0.5 ? curve(cos) : 2 * curve(0.5) - curve(1 - cos));
}

/** materialLobesSheenBRDF in double precision; mu = n.v, nl = n.l, phi = azimuth between l and v. */
export function sheenBRDF(roughness, nl, mu, phi) {
  const alpha = Math.max(roughness, ROUGHNESS_FLOOR) ** 2,
    sv = Math.sqrt(Math.max(0, 1 - mu * mu)),
    sl = Math.sqrt(Math.max(0, 1 - nl * nl)),
    // sin^2(theta_h) = |tangential part of v + l|^2 / |v + l|^2, written without cancellation.
    tangential = sv * sv + sl * sl + 2 * sv * sl * Math.cos(phi),
    sin2 = tangential / (tangential + (mu + nl) ** 2),
    inverse = 1 / alpha,
    distribution = sin2 > 0 ? ((2 + inverse) * Math.exp(0.5 * inverse * Math.log(sin2))) / (2 * Math.PI) : 0,
    visibility = 1 / Math.max((1 + sheenLambda(mu, alpha) + sheenLambda(nl, alpha)) * 4 * nl * mu, 1e-6);
  return distribution * visibility;
}

const rules = new Map();
/** Tanh-sinh (double exponential) nodes and weights on (0, 1); they cluster at both ends. */
function tanhSinh(level) {
  let rule = rules.get(level);
  if (rule) return rule;
  const h = 2 ** -level,
    nodes = [],
    weights = [];
  for (let k = -Math.ceil(4.5 / h); k <= Math.ceil(4.5 / h); k++) {
    const t = k * h,
      s = (Math.PI / 2) * Math.sinh(t),
      x = 1 / (1 + Math.exp(2 * s)),
      c = Math.cosh(s),
      w = (h * (Math.PI / 2) * Math.cosh(t)) / (2 * c * c);
    if (x > 0 && x < 1 && w > 1e-300) {
      nodes.push(x);
      weights.push(w);
    }
  }
  rules.set(level, (rule = { nodes, weights }));
  return rule;
}

/**
 * Numerical E(mu, r): tanh-sinh in n.l and azimuth (the integrand is even in azimuth), with n.l split at mu (the
 * point where h can reach n) and at 0.5, where Lambda changes branch, so each piece is smooth inside.
 */
export function sheenAlbedo(mu, roughness, level = 5) {
  const rule = tanhSinh(level),
    cuts = [0, 1, mu, 0.5];
  const points = [...new Set(cuts)].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i],
      b = points[i + 1];
    if (!(b > a)) continue;
    for (let j = 0; j < rule.nodes.length; j++) {
      const nl = a + (b - a) * rule.nodes[j];
      let inner = 0;
      for (let k = 0; k < rule.nodes.length; k++)
        inner += rule.weights[k] * sheenBRDF(roughness, nl, mu, Math.PI * rule.nodes[k]);
      sum += (b - a) * rule.weights[j] * nl * inner;
    }
  }
  return 2 * Math.PI * sum;
}

const { size, k, p } = sheenAlbedoGrid,
  last = size - 1;
const floor = (r) => Math.max(ROUGHNESS_FLOOR, Math.min(1, r));

/** Table coordinates in [0, 1]^2 of (mu, r), as the shader computes them. */
export function tableCoordinates(mu, roughness) {
  const r = floor(roughness),
    m = Math.min(1, Math.max(1e-4, mu));
  return [((m * (r + k)) / (r + k * m)) ** p, Math.sqrt(Math.min(1, Math.max(0, roughness)))];
}

/** The (mu, r) of table coordinates (u, v): the inverse of tableCoordinates. */
export function tablePoint(u, v) {
  const r = v * v,
    w = u ** (1 / p),
    R = floor(r);
  return [Math.max(1e-4, (w * R) / (R + k - k * w)), r];
}

/** The four (index, weight) pairs of the bilinear read at (mu, r). */
function corners(mu, roughness) {
  const [u, v] = tableCoordinates(mu, roughness),
    x = u * last,
    y = v * last,
    i = Math.min(last - 1, Math.floor(x)),
    j = Math.min(last - 1, Math.floor(y)),
    s = x - i,
    t = y - j,
    n = j * size + i;
  return [
    [n, (1 - s) * (1 - t)],
    [n + 1, s * (1 - t)],
    [n + size, (1 - s) * t],
    [n + size + 1, s * t],
  ];
}

/** The table's albedo in double precision. */
export function tableAlbedo(table, mu, roughness) {
  const log = corners(mu, roughness).reduce((sum, [n, w]) => sum + w * table[n], 0);
  return Math.min(1, Math.max(0, Math.exp(log) / floor(roughness)));
}

/** Training points: four per table cell edge in (u, v), so every node is pinned by data on all sides. */
export function trainingGrid() {
  const points = [],
    n = last * 4;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) points.push(tablePoint(i / n, j / n));
  return points;
}

/** Independent validation points: offset in (u, v), plus uniform and geometric steps in mu at offset roughness. */
export function validationGrid() {
  const points = [],
    n = last * 3;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) points.push(tablePoint((i + 0.37) / n, (j + 0.61) / n));
  const roughness = [0, 1e-4, 3e-4, 0.001, 0.003];
  for (let r = 0.0063; r < 1; r += 0.0131) roughness.push(+r.toFixed(5));
  roughness.push(1);
  const mus = [];
  for (let i = 0; i <= 40; i++) mus.push(1e-4 * 10 ** ((i + 0.5) / 10));
  for (let m = 0.0137; m < 1; m += 0.0213) mus.push(+m.toFixed(5));
  mus.push(1);
  for (const r of roughness) for (const mu of mus) points.push([Math.min(mu, 1), r]);
  return points;
}

function solve(a, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      if (f) {
        for (let q = c; q < n; q++) a[r][q] -= f * a[c][q];
        b[r] -= f * b[c];
      }
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let q = r + 1; q < n; q++) s -= a[r][q] * x[q];
    x[r] = s / a[r][r];
  }
  return x;
}

/** Errors of `evaluate(mu, r)` against min(E, 1) on rows [mu, r, E]; optional filter on the rows. */
export function errors(evaluate, rows, keep = () => true) {
  let max = 0,
    sum = 0,
    count = 0,
    at = [0, 0];
  for (const [mu, r, e] of rows) {
    if (!keep(mu, r)) continue;
    const d = Math.abs(evaluate(mu, r) - Math.min(1, e));
    sum += d;
    count++;
    if (d > max) [max, at] = [d, [mu, r]];
  }
  return { max, mean: sum / count, at };
}

/**
 * Node values: the sampled ln(E R) at each node, then weighted least squares on ln(E R) over `training` (weight
 * min(E, 1)^2 + 1e-4; a pull of 1e-3 toward the sampled node keeps every node defined), then Lawson's reweighting
 * (each weight times its absolute error) for `rounds` rounds, keeping the table with the smallest maximum error.
 */
export function fit(training, nodes, rounds = 8) {
  const n = size * size,
    sampled = nodes.map(([, r, e]) => Math.max(-24, Math.log(e * floor(r)))),
    rows = training.filter(([, , e]) => e > 1e-7),
    weights = rows.map(([mu, r]) => corners(mu, r));
  let extra = rows.map(() => 1),
    best = { table: sampled, ...errors((mu, r) => tableAlbedo(sampled, mu, r), training) };
  const first = best;
  for (let round = 0; round < rounds; round++) {
    const a = Array.from({ length: n }, () => new Float64Array(n)),
      b = new Float64Array(n);
    rows.forEach(([, r, e], q) => {
      const w = extra[q] * (Math.min(1, e) ** 2 + 1e-4),
        y = Math.log(e * floor(r));
      for (const [i, x] of weights[q]) {
        b[i] += w * x * y;
        for (const [j, z] of weights[q]) a[i][j] += w * x * z;
      }
    });
    for (let i = 0; i < n; i++) {
      a[i][i] += 1e-3;
      b[i] += 1e-3 * sampled[i];
    }
    const table = solve(
        a.map((row) => Array.from(row)),
        Array.from(b),
      ),
      result = errors((mu, r) => tableAlbedo(table, mu, r), training);
    if (result.max < best.max) best = { table, ...result };
    const residual = rows.map(([mu, r, e]) => Math.abs(tableAlbedo(table, mu, r) - Math.min(1, e)));
    extra = extra.map((v, q) => v * (residual[q] + 2e-3));
    const total = extra.reduce((s, v) => s + v);
    extra = extra.map((v) => (v / total) * rows.length);
  }
  return { sampled: first, best };
}

/** The shipped WGSL (sheenAlbedoWGSL) run by tests/support/wgsl-eval.js in double precision, optionally on `table`. */
export function shippedAlbedo(table = sheenAlbedoTable) {
  const module = wgslModule(sheenAlbedoWGSL('sheenFit', table));
  return (mu, r) => module.call('sheenFit', mu, r);
}

/**
 * The closed-form albedo the table replaced: sheenAlbedoWGSL as packages/shared/sheen.js shipped it in the parent of
 * commit 5cef0a120 ("sheen uses the Estevez and Kulla visibility and its own albedo table"), byte for byte.
 * scripts/sheen-albedo-gpu-check.js draws the CURRENT shader with only this one function swapped in, so the reference
 * is the same whatever later sheen change lands, and finding it needs no git history.
 */
export const closedFormAlbedoCommit = '5cef0a120b9fbbf336c56a476f56ccac2f107960';
export const closedFormAlbedoWGSL = (name) => /* wgsl */ `fn ${name}(mu:f32,roughness:f32)->f32 {
  let sheenR2=roughness*roughness;let sheenKnee=sheenR2/(sheenR2+0.046698);
  let sheenBasis=vec4f(1.0,sheenKnee,roughness,sheenKnee*roughness);let sheenX=mu/max(roughness,0.0001);
  return clamp(exp(dot(sheenBasis,vec4f(0.67486,-1.0569,1.2955,-1.6596))-sheenX*(dot(sheenBasis,vec4f(0.78851,0.09914,-0.27042,0.61309))+sheenX*dot(sheenBasis,vec4f(0.072685,0.29184,-0.084342,-0.10518)))),0.0,1.0);
}
`;

/** Integrates E at every point on all cores; resolves rows [mu, r, E] in the order of `points`. */
export function integrate(points, level = 5) {
  const workers = Math.max(1, Math.min(32, availableParallelism() - 1)),
    chunks = Array.from({ length: workers }, (_, w) => points.filter((_, i) => i % workers === w));
  return Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { chunk, level } });
          worker.once('message', resolve);
          worker.once('error', reject);
        }),
    ),
  ).then((parts) => points.map((_, i) => parts[i % workers][Math.floor(i / workers)]));
}

if (!isMainThread && workerData?.chunk) {
  const { chunk, level } = workerData;
  parentPort.postMessage(chunk.map(([mu, r]) => [mu, r, sheenAlbedo(mu, r, level)]));
} else if (isMainThread && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const started = performance.now(),
    log = (...args) => console.log(...args),
    nodes = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) nodes.push(tablePoint(i / last, j / last));
  const [training, validation, nodeRows] = await Promise.all([
    integrate(trainingGrid()),
    integrate(validationGrid()),
    integrate(nodes),
  ]);
  // Integration accuracy: level 5 against level 6 on a subset (Lambda has no closed-form albedo).
  const subset = training.filter((_, i) => i % 23 === 0),
    finer = await integrate(
      subset.map(([mu, r]) => [mu, r]),
      6,
    ),
    refinement = Math.max(...finer.map(([, , e], i) => Math.abs(Math.min(1, e) - Math.min(1, subset[i][2]))));
  log(`integration: tanh-sinh level 5, ${training.length} training and ${validation.length} validation points`);
  log(`  |level 5 - level 6| of min(E, 1): max ${refinement.toExponential(2)} over every 23rd training point`);
  const { sampled, best } = fit(training, nodeRows),
    rounded = best.table.map((v) => +v.toFixed(2)),
    f32 = (mu, r) => Math.fround(tableAlbedo(rounded.map(Math.fround), Math.fround(mu), Math.fround(r))),
    line = (name, f) => {
      const all = errors(f, validation),
        visible = errors(f, validation, (mu) => mu >= 0.01),
        gltf = errors(f, validation, (_, r) => r >= 0.03);
      log(
        `${name.padEnd(34)} max ${all.max.toFixed(5)} at mu=${all.at[0].toPrecision(3)} r=${all.at[1]}, mean ${all.mean.toFixed(5)}; mu >= 0.01: ${visible.max.toFixed(5)}; r >= 0.03: ${gltf.max.toFixed(5)}`,
      );
    };
  log(`table ${size} x ${size}, k ${k}, p ${p}; validation errors against min(E, 1):`);
  line('sampled nodes', (mu, r) => tableAlbedo(sampled.table, mu, r));
  line('fitted nodes', (mu, r) => tableAlbedo(best.table, mu, r));
  line('fitted, 2 decimals, WGSL text', shippedAlbedo(rounded));
  line('fitted, 2 decimals, f32', f32);
  if (process.argv.includes('--compare')) {
    // Bytes against error: the same nodes at 3 decimals, and each variant's WGSL gzipped alone.
    const fine = best.table.map((v) => +v.toFixed(3)),
      bytes = (table) => gzipSync(sheenAlbedoWGSL('materialLobesSheenAlbedo', table)).length;
    line('fitted, 3 decimals, WGSL text', shippedAlbedo(fine));
    log(`  WGSL gzip bytes: 2 decimals ${bytes(rounded)}, 3 decimals ${bytes(fine)}`);
    // The Enterprise PBR 2022x layout: 16 x 16 samples of min(E, 1) at (mu, alpha) = (i / 15, j / 15), bilinear.
    const grid = [];
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) grid.push([Math.max(1e-4, i / 15), Math.sqrt(j / 15)]);
    const values = (await integrate(grid)).map(([, , e]) => Math.min(1, e)),
      at = (i, j) => values[j * 16 + i];
    line('16 x 16 min(E, 1) in (mu, alpha)', (mu, r) => {
      const x = Math.min(1, mu) * 15,
        y = Math.min(1, r * r) * 15,
        i = Math.min(14, Math.floor(x)),
        j = Math.min(14, Math.floor(y)),
        s = x - i,
        t = y - j;
      return (at(i, j) * (1 - s) + at(i + 1, j) * s) * (1 - t) + (at(i, j + 1) * (1 - s) + at(i + 1, j + 1) * s) * t;
    });
  }
  log('\nsheenAlbedoTable for packages/shared/sheen.js:');
  for (let j = 0; j < size; j++) log('  ' + rounded.slice(j * size, j * size + size).join(', ') + ',');
  const current = errors(shippedAlbedo(), validation);
  log(`\nthe table in shared/sheen.js now: max ${current.max.toFixed(5)}, mean ${current.mean.toFixed(5)}`);
  log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
