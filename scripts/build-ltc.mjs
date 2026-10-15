// Fits packages/clustered/src/ltc.ts, the LTC lookup table of @margoengine/clustered/area, from first principles: for each
// (roughness, view angle) cell, the linearly transformed cosine closest to the GGX BRDF the shader approximates (GGX D,
// height-correlated Smith G2, cosine-weighted), by the method of Heitz, Dupuy, Hill and Neubelt, "Real-Time Polygonal-Light
// Shading with Linearly Transformed Cosines" (SIGGRAPH 2016): the lobe's average direction fixes the frame, Nelder-Mead fits
// the matrix's three free parameters (m11, m22, m13) minimising the cubed difference of the normalised lobe and the LTC
// distribution (both importance sampled, balance heuristic), each cell starting from its neighbour's solution; magnitude
// (directional albedo, F = 1) and the Fresnel term (Schlick weight (1 - v.h)^5) are integrated numerically.
// Six float16 values per cell: the inverse matrix's four free entries (normalised so its middle entry is 1), magnitude and
// Fresnel. Each value plane is coded with a 2D gradient predictor and zigzag varints, so the bundle's gzip sees small,
// repetitive bytes. Single-threaded and deterministic (fixed stratified samples, no randomness): one to two minutes for 32x32.
// Run: node scripts/build-ltc.mjs [size=32]
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const size = +(process.argv[2] ?? 32);
if (!Number.isInteger(size) || size < 2 || size > 64) throw new RangeError('size must be 2-64');
const MOMENT_SAMPLES = 512, FIT_SAMPLES = 32; // per dimension: magnitude/Fresnel/direction quadrature, and the fit's error estimate

/** GGX lobe of one cell in the local frame (normal +z, view (sin, 0, cos) in the xz plane, as clusterAreaLighting builds it). */
function lobe(alpha, nv) {
  const a2 = alpha * alpha, vx = Math.sqrt(1 - nv * nv), vz = nv;
  const lambda = c => (Math.sqrt(1 + a2 * (1 - c * c) / (c * c)) - 1) / 2, lambdaV = lambda(nv);
  // BRDF x cosine at unit direction l (D G2 / (4 n.v)) and the pdf of sampling l by reflecting a GGX-distributed normal.
  const out = {value: 0, pdf: 0};
  function evaluate(lx, ly, lz) {
    let hx = vx + lx, hy = ly, hz = vz + lz; const hl = Math.hypot(hx, hy, hz);
    out.value = out.pdf = 0; if (hl < 1e-12) return out;
    hx /= hl; hy /= hl; hz /= hl; const vh = vx * hx + vz * hz; if (hz <= 0 || vh <= 0) return out;
    const t = hz * hz * (a2 - 1) + 1, D = a2 / (Math.PI * t * t);
    out.pdf = D * hz / (4 * vh);
    if (lz > 0) out.value = D / (1 + lambdaV + lambda(lz)) / (4 * nv);
    return out;
  }
  // Half vector of stratified sample (u1, u2), distributed as D(h) h.z.
  function sampleHalf(u1, u2) {
    const cos2 = (1 - u1) / (1 + (a2 - 1) * u1), c = Math.sqrt(cos2), s = Math.sqrt(1 - cos2), phi = 2 * Math.PI * u2;
    return [s * Math.cos(phi), s * Math.sin(phi), c];
  }
  return {vx, vz, evaluate, sampleHalf};
}

/** Magnitude (integral of BRDF x cosine), Fresnel term (the same weighted by (1 - v.h)^5) and the lobe's average direction. */
function moments({vx, vz, evaluate, sampleHalf}) {
  let magnitude = 0, fresnel = 0, dx = 0, dz = 0; const n = MOMENT_SAMPLES;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const [hx, hy, hz] = sampleHalf((i + 0.5) / n, (j + 0.5) / n), vh = vx * hx + vz * hz; if (vh <= 0) continue;
    const lx = 2 * vh * hx - vx, ly = 2 * vh * hy, lz = 2 * vh * hz - vz; if (lz <= 0) continue;
    const {value, pdf} = evaluate(lx, ly, lz), weight = value / pdf;
    magnitude += weight; fresnel += weight * (1 - vh) ** 5; dx += weight * lx; dz += weight * lz;
  }
  const length = Math.hypot(dx, dz);
  return {magnitude: magnitude / (n * n), fresnel: fresnel / (n * n), direction: [dx / length, dz / length]};
}

/** M = [X Y Z] [[m11, 0, m13], [0, m22, 0], [0, 0, 1]] with Z the lobe's average direction and X its perpendicular in the xz plane. */
function transform([m11, m22, m13], [zx, zz]) {
  m11 = Math.abs(m11); m22 = Math.abs(m22);
  const xx = zz, xz = -zx; // X: Z rotated 90 degrees within the plane of incidence
  // The xz block (columns M e_x and M e_z); M e_y = m22 (0, 1, 0).
  const b00 = m11 * xx, b10 = m11 * xz, b01 = m13 * xx + zx, b11 = m13 * xz + zz, det = b00 * b11 - b01 * b10;
  return {b00, b10, b01, b11, m22, det: Math.abs(det * m22)};
}

/** Fit error of a transform: E[|lobe / magnitude - LTC|^3] by multiple importance sampling of both distributions. */
function fitError(params, frame, brdf, magnitude, brdfSamples, cosineSamples) {
  const m = transform(params, frame); if (!(m.det > 1e-30)) return Infinity;
  let error = 0;
  const ltcAt = (lx, ly, lz) => { // D_o(l) = D_cos(M^-1 l / |M^-1 l|) |det M^-1| / |M^-1 l|^3
    const inv = 1 / (m.b00 * m.b11 - m.b01 * m.b10), ox = (m.b11 * lx - m.b01 * lz) * inv, oz = (m.b00 * lz - m.b10 * lx) * inv, oy = ly / m.m22;
    const l2 = ox * ox + oy * oy + oz * oz; return oz <= 0 ? 0 : oz / Math.sqrt(l2) / Math.PI / (m.det * l2 * Math.sqrt(l2));
  };
  for (let k = 0; k < brdfSamples.length; k += 5) { // l, normalised lobe, its sampling pdf (fixed per cell)
    const d = ltcAt(brdfSamples[k], brdfSamples[k + 1], brdfSamples[k + 2]), f = brdfSamples[k + 3], pdf = brdfSamples[k + 4];
    if (pdf + d > 0) error += Math.abs(f - d) ** 3 / (pdf + d);
  }
  for (let k = 0; k < cosineSamples.length; k += 3) { // l = M o / |M o| for cosine-distributed o; pdf = D_o(l)
    const ox = cosineSamples[k], oy = cosineSamples[k + 1], oz = cosineSamples[k + 2];
    let lx = m.b00 * ox + m.b01 * oz, ly = m.m22 * oy, lz = m.b10 * ox + m.b11 * oz; const length = Math.hypot(lx, ly, lz);
    lx /= length; ly /= length; lz /= length;
    const d = oz / Math.PI * length ** 3 / m.det, {value, pdf} = brdf.evaluate(lx, ly, lz), f = value / magnitude;
    if (pdf + d > 0) error += Math.abs(f - d) ** 3 / (pdf + d);
  }
  return error / (brdfSamples.length / 5 + cosineSamples.length / 3);
}

/** Nelder-Mead simplex minimisation of f from x0 (initial steps of `scale` x each coordinate, at least `floor`). */
function nelderMead(f, x0, {scale = 0.1, floor = 1e-3, iterations = 600, tolerance = 1e-9} = {}) {
  const n = x0.length, simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {const x = x0.slice(); x[i] += Math.max(Math.abs(x[i]) * scale, floor); simplex.push(x);}
  let values = simplex.map(f);
  const along = (from, to, t) => from.map((v, i) => v + (to[i] - v) * t);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const sorted = order.map(i => simplex[i]); values = order.map(i => values[i]); simplex.splice(0, n + 1, ...sorted);
    if (Math.abs(values[n] - values[0]) <= tolerance * (Math.abs(values[0]) + 1e-30)) break;
    const centroid = Array.from({length: n}, (_, i) => simplex.slice(0, n).reduce((s, x) => s + x[i], 0) / n);
    const reflected = along(simplex[n], centroid, 2), fr = f(reflected);
    if (fr < values[0]) {
      const expanded = along(simplex[n], centroid, 3), fe = f(expanded);
      [simplex[n], values[n]] = fe < fr ? [expanded, fe] : [reflected, fr];
    } else if (fr < values[n - 1]) [simplex[n], values[n]] = [reflected, fr];
    else {
      const contracted = fr < values[n] ? along(simplex[n], centroid, 1.5) : along(simplex[n], centroid, 0.5), fc = f(contracted);
      if (fc < Math.min(fr, values[n])) [simplex[n], values[n]] = [contracted, fc];
      else for (let i = 1; i <= n; i++) {simplex[i] = along(simplex[0], simplex[i], 0.5); values[i] = f(simplex[i]);}
    }
  }
  const best = values.indexOf(Math.min(...values));
  return {x: simplex[best], value: values[best]};
}

/** Fits one cell from `start` ([m11, m22, m13]); `isotropic` (normal incidence) fits m11 = m22, m13 = 0 only. */
function fitCell(alpha, nv, start, isotropic) {
  const brdf = lobe(alpha, nv), {magnitude, fresnel, direction} = moments(brdf), n = FIT_SAMPLES;
  const brdfSamples = new Float64Array(n * n * 5), cosineSamples = new Float64Array(n * n * 3);
  for (let i = 0, k = 0, c = 0; i < n; i++) for (let j = 0; j < n; j++, k += 5, c += 3) {
    const u1 = (i + 0.5) / n, u2 = (j + 0.5) / n, [hx, hy, hz] = brdf.sampleHalf(u1, u2), vh = brdf.vx * hx + brdf.vz * hz;
    const lx = 2 * vh * hx - brdf.vx, ly = 2 * vh * hy, lz = 2 * vh * hz - brdf.vz, {value, pdf} = brdf.evaluate(lx, ly, lz);
    brdfSamples.set([lx, ly, lz, value / magnitude, pdf], k);
    const r = Math.sqrt(u1), phi = 2 * Math.PI * u2; cosineSamples.set([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u1)], c);
  }
  const error = params => fitError(params, direction, brdf, magnitude, brdfSamples, cosineSamples);
  let params;
  if (isotropic) {const [m] = nelderMead(([m]) => error([m, m, 0]), [start[0]]).x; params = [m, m, 0];}
  else params = nelderMead(error, start).x;
  const m = transform(params, direction), inv = Math.abs(params[1]) / (m.b00 * m.b11 - m.b01 * m.b10);
  // M^-1 scaled so its middle entry is 1 (the LTC is scale invariant): xz block = m22 inverse(B).
  return {params: [Math.abs(params[0]), Math.abs(params[1]), params[2]], cell: [m.b11 * inv, -m.b10 * inv, -m.b01 * inv, m.b00 * inv, magnitude, fresnel]};
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
// Round-to-nearest-even float16 bits of a float (the table holds no infinities or NaN).
function float16(value) {
  f32[0] = value; const bits = u32[0], sign = (bits >>> 16) & 0x8000, exponent = ((bits >>> 23) & 0xff) - 112, mantissa = bits & 0x7fffff;
  if (exponent <= 0) {if (exponent < -10) return sign; const m = mantissa | 0x800000, shift = 14 - exponent, rest = m & ((1 << shift) - 1), halfway = 1 << (shift - 1);
    let r = m >>> shift; if (rest > halfway || rest === halfway && r & 1) r++; return sign | r;}
  if (exponent >= 31) throw new RangeError(`${value} overflows float16`);
  let r = (exponent << 10) | (mantissa >>> 13); const rest = mantissa & 0x1fff; if (rest > 0x1000 || rest === 0x1000 && r & 1) r++; return sign | r;
}

const started = performance.now(), cells = new Float64Array(size * size * 6);
// Columns: perceptual roughness i / (size - 1), alpha = roughness^2. The shader clamps roughness to 0.045, so column 0 is never
// sampled; it repeats column 1's alpha instead of fitting a delta. Rows: sqrt(1 - n.v) = j / (size - 1), n.v at least 1e-4.
// Order: rough to glossy along normal incidence, then each column from normal to grazing, each fit starting at its neighbour.
let top = [1, 1, 0];
for (let x = size - 1; x >= 0; x--) {
  const alpha = Math.max(x, 1) ** 2 / (size - 1) ** 2;
  let start = top;
  for (let y = 0; y < size; y++) {
    const u = y / (size - 1), nv = Math.max(1 - u * u, 1e-4), {params, cell} = fitCell(alpha, nv, start, y === 0);
    cells.set(cell, (y * size + x) * 6); start = params; if (y === 0) top = params;
  }
  process.stdout.write(`\rcolumn ${size - x}/${size}`);
}
const bytes = [];
for (let k = 0; k < 6; k++) {
  const q = Array.from({length: size * size}, (_, i) => float16(cells[i * 6 + k]));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const left = x ? q[y * size + x - 1] : 0, up = y ? q[(y - 1) * size + x] : 0, corner = x && y ? q[(y - 1) * size + x - 1] : 0;
    const d = q[y * size + x] - (x && y ? left + up - corner : x ? left : up);
    let z = d < 0 ? -2 * d - 1 : 2 * d;
    do {const b = z & 0x7f; z = Math.floor(z / 128); bytes.push(z ? b | 0x80 : b);} while (z);
  }
}
const out = resolve(import.meta.dirname, '../packages/clustered/src/ltc.ts');
writeFileSync(out, `// Generated by scripts/build-ltc.mjs (do not edit): linearly transformed cosines (Heitz, Dupuy, Hill and Neubelt 2016)
// fitted to GGX with height-correlated Smith masking, ${size}x${size} cells.
/** Cells per side of the LTC table: columns are perceptual roughness 0..1, rows sqrt(1 - n.v) 0..1. */
export const ltcSize = ${size};
const data = '${Buffer.from(bytes).toString('base64')}';
/** Float16 bits, six per cell (row-major): the inverse matrix's columns (x, 0, y), (0, 1, 0), (z, 0, w) as x, y, z, w, then magnitude and Fresnel. */
export function ltcTable(): Uint16Array {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)), cells = ltcSize * ltcSize, out = new Uint16Array(cells * 6);
  let at = 0;
  for (let k = 0; k < 6; k++) for (let i = 0; i < cells; i++) {
    let z = 0, scale = 1, b: number;
    do {b = bytes[at++]; z += (b & 127) * scale; scale *= 128;} while (b & 128);
    const x = i % ltcSize, left = x ? out[(i - 1) * 6 + k] : 0, up = i >= ltcSize ? out[(i - ltcSize) * 6 + k] : 0;
    const corner = x && i >= ltcSize ? out[(i - ltcSize - 1) * 6 + k] : 0;
    out[i * 6 + k] = (z & 1 ? -(z + 1) / 2 : z / 2) + (x && i >= ltcSize ? left + up - corner : x ? left : up);
  }
  return out;
}
`);
console.log(`\nwrote ${out}: ${size}x${size}, ${bytes.length} bytes coded, ${((performance.now() - started) / 1000).toFixed(1)} s`);
