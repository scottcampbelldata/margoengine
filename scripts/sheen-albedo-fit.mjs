// Derives the directional albedo of our own sheen BRDF and fits the closed form in materialLobesSheenAlbedo
// (sheenAlbedoWGSL in packages/shared/sheen.js). Nothing here comes from another engine: the BRDF is
// materialLobesSheenBRDF as written in that file, i.e. the KHR_materials_sheen Charlie distribution
// (Estevez & Kulla 2017, "Production Friendly Microfacet Sheen BRDF") with alpha = roughness^2 and the
// Neubelt visibility clamped to 1. E(mu, r) = integral over the hemisphere of f(l, v) (n.l) dl with n.v = mu.
//
//   node scripts/sheen-albedo-fit.mjs          integrate, fit, validate and print the WGSL constants
//
// The fit is clamp(exp(b - x (c1 + x c2)), 0, 1) with x = mu / max(r, 1e-4), where b, c1 and c2 are each
// dot([1, q, r, q r], coefficients) and q = r^2 / (r^2 + k^2). x = mu / r follows the measured boundary layer
// at grazing views (for small r the albedo depends only on mu / r); q is a smooth knee near r = k.
// The target is min(E, 1): the clamped visibility lets E reach 2 at grazing for small r, and the shader uses E
// as an energy fraction (base * (1 - sheenMax * E), sheen * E for ambient), so it stays in [0, 1].
import { pathToFileURL } from 'node:url';

const ROUGHNESS_FLOOR = 1e-4; // materialLobesSheenBRDF uses max(roughness, 0.0001)

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
    visibility = Math.min(1, 1 / Math.max(4 * (nl + mu - nl * mu), 1e-300));
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
 * point where h can reach n) and where the visibility clamp switches, so each piece is smooth inside.
 */
export function sheenAlbedo(mu, roughness, level = 5) {
  const rule = tanhSinh(level),
    cuts = [0, 1, mu];
  if (mu < 0.25) cuts.push((0.25 - mu) / (1 - mu));
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

/** Closed form at normal incidence (v = n, V = 1/4, theta_h = theta_l / 2): E(1, r) = 2^(-n/2) / (n + 4), n = 1 / r^2. */
export function normalIncidenceAlbedo(roughness) {
  const n = 1 / Math.max(roughness, ROUGHNESS_FLOOR) ** 2;
  return 2 ** (-n / 2) / (n + 4);
}

/** The shader's fit: p = [k, b0..b3, c10..c13, c20..c23] for the basis [1, q, r, q r]. */
export function fittedAlbedo(p, mu, roughness) {
  const r2 = roughness * roughness,
    q = r2 / (r2 + p[0] * p[0]),
    basis = [1, q, roughness, q * roughness],
    term = (t) => basis[0] * p[1 + t * 4] + basis[1] * p[2 + t * 4] + basis[2] * p[3 + t * 4] + basis[3] * p[4 + t * 4],
    x = mu / Math.max(roughness, ROUGHNESS_FLOOR);
  return Math.min(1, Math.max(0, Math.exp(term(0) - x * (term(1) + x * term(2)))));
}

function solve(matrix, vector) {
  const n = vector.length,
    m = matrix.map((row, i) => [...row, vector[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    if (Math.abs(m[c][c]) < 1e-300) return null;
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x;
}

/** Weighted Levenberg-Marquardt least squares with a forward-difference Jacobian. */
function leastSquares(residuals, start, { iterations = 300, weights } = {}) {
  const cost = (r) => r.reduce((s, v, i) => s + (weights ? weights[i] : 1) * v * v, 0);
  let p = [...start],
    res = residuals(p),
    current = cost(res),
    lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const n = p.length,
      jacobian = [];
    for (let j = 0; j < n; j++) {
      const q = [...p],
        h = 1e-7 * Math.max(1, Math.abs(p[j]));
      q[j] += h;
      const moved = residuals(q);
      jacobian.push(moved.map((v, i) => (v - res[i]) / h));
    }
    const normal = Array.from({ length: n }, () => new Array(n).fill(0)),
      gradient = new Array(n).fill(0);
    for (let i = 0; i < res.length; i++) {
      const w = weights ? weights[i] : 1;
      for (let a = 0; a < n; a++) {
        gradient[a] += w * jacobian[a][i] * res[i];
        for (let b = a; b < n; b++) normal[a][b] += w * jacobian[a][i] * jacobian[b][i];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) normal[a][b] = normal[b][a];
    let improved = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const step = solve(
        normal.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v))),
        gradient.map((v) => -v),
      );
      if (step) {
        const q = p.map((v, j) => v + step[j]),
          moved = residuals(q),
          next = cost(moved);
        if (Number.isFinite(next) && next < current) {
          const relative = (current - next) / current;
          p = q;
          res = moved;
          current = next;
          lambda = Math.max(lambda / 3, 1e-12);
          improved = true;
          if (relative < 1e-12) return p;
        }
      }
      if (!improved) lambda *= 4;
    }
    if (!improved) break;
  }
  return p;
}

/** Training grid: dense in x = mu / r for the grazing boundary layer and uniform in mu elsewhere. */
export function trainingGrid() {
  const roughness = [1e-4, 0.001, 0.0025, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09];
  for (let i = 0; i <= 36; i++) roughness.push(+(0.1 + i * 0.025).toFixed(4));
  const grid = [];
  for (const r of roughness) {
    const mus = new Set([0]);
    for (let i = 1; i <= 60; i++) if (i * 0.1 * r <= 1) mus.add(+(i * 0.1 * r).toPrecision(8));
    for (let i = 1; i <= 50; i++) mus.add(+(i * 0.02).toFixed(4));
    for (const mu of [...mus].sort((a, b) => a - b)) grid.push([mu, r]);
  }
  return grid;
}

/** Independent validation grid: offset roughness steps and geometric mu from 1e-4. */
export function validationGrid() {
  const roughness = [1e-4, 3e-4, 0.001, 0.003];
  for (let r = 0.0063; r < 1; r += 0.0131) roughness.push(+r.toFixed(5));
  roughness.push(1);
  const mus = [0];
  for (let i = 0; i <= 40; i++) mus.push(1e-4 * 10 ** (i / 10));
  for (let m = 0.0137; m < 1; m += 0.0213) mus.push(+m.toFixed(5));
  return roughness.flatMap((r) => mus.map((mu) => [Math.min(mu, 1), r]));
}

/** Rounds to `digits` significant digits, as the numbers are written into the WGSL. */
export const round = (value, digits = 5) => +value.toPrecision(digits);

function errors(p, rows, evaluate = fittedAlbedo) {
  let max = 0,
    sum = 0,
    at;
  for (const [mu, r, e] of rows) {
    const d = Math.abs(evaluate(p, mu, r) - Math.min(1, e));
    sum += d;
    if (d > max) [max, at] = [d, [mu, r]];
  }
  return { max, mean: sum / rows.length, at };
}

export function fit(training) {
  const target = training.map(([, , e]) => Math.min(1, e)),
    residuals = (p) => training.map(([mu, r], i) => fittedAlbedo(p, mu, r) - target[i]);
  // Start: per-roughness unclamped fits of exp(b - x (c1 + x c2)), then a linear fit of those to the basis.
  const roughness = [...new Set(training.map(([, r]) => r))],
    k0 = 0.25,
    per = roughness.map((r) => {
      const rows = training.filter((row) => row[1] === r);
      return leastSquares(
        (p) => rows.map(([mu, , e]) => Math.exp(p[0] - (mu / r) * (p[1] + (mu / r) * p[2])) - e),
        [0.69, 0.79, 0.07],
        { iterations: 500 },
      );
    }),
    start = [k0];
  for (let t = 0; t < 3; t++) {
    const basis = roughness.map((r) => {
        const q = (r * r) / (r * r + k0 * k0);
        return [1, q, r, q * r];
      }),
      normal = [0, 1, 2, 3].map((a) => [0, 1, 2, 3].map((b) => basis.reduce((s, row) => s + row[a] * row[b], 0))),
      right = [0, 1, 2, 3].map((a) => basis.reduce((s, row, i) => s + row[a] * per[i][t], 0));
    start.push(...solve(normal, right));
  }
  // Least squares on the clamped albedo, then Lawson's iteratively reweighted least squares toward minimax.
  let p = leastSquares(residuals, start, { iterations: 600 }),
    weights = training.map(() => 1),
    best = { p, ...errors(p, training) };
  const leastSquaresResult = best;
  for (let it = 0; it < 60; it++) {
    const res = residuals(p).map(Math.abs);
    weights = weights.map((w, i) => w * (res[i] + 1e-5));
    const total = weights.reduce((a, b) => a + b);
    weights = weights.map((w) => (w / total) * training.length);
    p = leastSquares(residuals, p, { iterations: 60, weights });
    const e = errors(p, training);
    if (e.max < best.max) best = { p, ...e };
  }
  return { leastSquares: leastSquaresResult, minimax: best };
}

function format(value) {
  const text = String(value);
  return text.includes('.') || text.includes('e') ? text : text + '.0';
}

/** The WGSL function body the fit produces (sheenAlbedoWGSL in packages/shared/sheen.js, named materialLobesSheenAlbedo in the lobes). */
export function wgsl(p) {
  const vector = (t) =>
    `vec4f(${p
      .slice(1 + t * 4, 5 + t * 4)
      .map(format)
      .join(',')})`;
  return `fn materialLobesSheenAlbedo(mu:f32,roughness:f32)->f32 {
  let materialR2=roughness*roughness;let materialQ=materialR2/(materialR2+${format(round(p[0] * p[0]))});
  let materialBasis=vec4f(1.0,materialQ,roughness,materialQ*roughness);let materialX=mu/max(roughness,0.0001);
  return clamp(exp(dot(materialBasis,${vector(0)})-materialX*(dot(materialBasis,${vector(1)})+materialX*dot(materialBasis,${vector(2)}))),0.0,1.0);
}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = performance.now(),
    log = (...args) => console.log(...args);
  // 1. Integration accuracy: closed form at normal incidence, and level 5 against level 6 on a subset.
  let closed = 0;
  for (const r of [0.2, 0.3, 0.5, 0.7, 0.85, 1])
    closed = Math.max(closed, Math.abs(sheenAlbedo(1, r) - normalIncidenceAlbedo(r)));
  const training = trainingGrid().map(([mu, r]) => [mu, r, sheenAlbedo(mu, r)]);
  let refinement = 0;
  for (let i = 0; i < training.length; i += 7) {
    const [mu, r, e] = training[i];
    refinement = Math.max(refinement, Math.abs(sheenAlbedo(mu, r, 6) - e));
  }
  const validation = validationGrid().map(([mu, r]) => [mu, r, sheenAlbedo(mu, r)]),
    peak = Math.max(...training.map(([, , e]) => e));
  log(`integration: tanh-sinh level 5, ${training.length} training and ${validation.length} validation points`);
  log(`  |level 5 - level 6| max ${refinement.toExponential(2)} over every 7th training point`);
  log(`  |numerical - closed form| at mu = 1 max ${closed.toExponential(2)}`);
  log(`  raw E peaks at ${peak.toFixed(4)} (grazing, small roughness); the fit targets min(E, 1)`);
  // 2. Fit, then evaluate with the rounded constants that go into the shader.
  const { leastSquares: ls, minimax } = fit(training),
    p = minimax.p.map((v) => round(v));
  p[0] = Math.sqrt(round(minimax.p[0] ** 2));
  const f32 = (q, mu, r) => Math.fround(fittedAlbedo(q.map(Math.fround), Math.fround(mu), Math.fround(r)));
  log(`least squares:          training max ${ls.max.toFixed(5)} mean ${ls.mean.toFixed(5)}`);
  log(`reweighted to minimax:  training max ${minimax.max.toFixed(5)} mean ${minimax.mean.toFixed(5)}`);
  for (const [name, rows] of [
    ['training', training],
    ['validation', validation],
  ]) {
    const e = errors(p, rows),
      single = errors(p, rows, f32);
    log(
      `rounded constants, ${name}: max ${e.max.toFixed(5)} at mu=${e.at[0].toPrecision(3)} r=${e.at[1]}, mean ${e.mean.toFixed(5)} (f32 max ${single.max.toFixed(5)})`,
    );
  }
  // 3. Safety: c1 and c2 stay positive for every roughness, so the exponent falls monotonically in mu and the
  // exponential can only underflow to 0 at mu / 1e-4 (never overflow to a clamped 1).
  let c1 = Infinity,
    c2 = Infinity;
  for (let i = 0; i <= 10000; i++) {
    const r = i / 10000,
      q = (r * r) / (r * r + p[0] * p[0]),
      basis = [1, q, r, q * r];
    c1 = Math.min(
      c1,
      basis.reduce((s, v, j) => s + v * p[5 + j], 0),
    );
    c2 = Math.min(
      c2,
      basis.reduce((s, v, j) => s + v * p[9 + j], 0),
    );
  }
  log(`minimum over r in [0, 1]: c1 ${c1.toFixed(4)}, c2 ${c2.toFixed(4)}`);
  if (!(c1 > 0 && c2 > 0)) throw new Error('Fit is not monotonic in mu; refit before shipping');
  log(`k^2 ${round(p[0] ** 2)}; b, c1, c2 over [1, q, r, q r]:`);
  for (let t = 0; t < 3; t++) log('  ' + ['b ', 'c1', 'c2'][t] + ' ' + p.slice(1 + t * 4, 5 + t * 4).join(', '));
  log('\n' + wgsl(p) + '\n');
  log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
