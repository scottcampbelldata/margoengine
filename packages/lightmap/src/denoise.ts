// @margoengine/lightmap/denoise: an edge-avoiding a-trous wavelet filter for baked lightmaps, so fewer rays per texel
// give clean light. The filter is the a-trous algorithm with edge-stopping weights of Dammertz, Sewtz, Hanika and Lensch,
// "Edge-Avoiding A-Trous Wavelet Transform for fast Global Illumination Filtering", HPG 2010: five 5 x 5 passes of the
// B3 spline kernel (1/16, 1/4, 3/8, 1/4, 1/16) whose taps spread 2^i texels apart, keeping only the coarsest level. The
// luminance weight follows Schied et al., "Spatiotemporal Variance-Guided Filtering", HPG 2017: it scales with the
// local noise, and the noise variance is filtered with the squared weights each pass so it shrinks as the light is
// smoothed. The lightmap specifics are Margo's: texels mix only inside one chart, the normal weight is SVGF's
// max(0, n.n)^128, the plane weight is a texel-space form of SVGF's local linear depth model (a neighbour's distance off
// the receiver's tangent plane against its distance along it), and the starting noise is a median absolute deviation
// of neighbour differences, robust to shadow edges, where no variance is supplied.
import { checkpoint, inRange } from './checks.js';
import type { Lightmap, LightmapQuads } from './index.js';
import type { LightmapMesh, MeshLightmap } from './mesh.js';

/** Texels to denoise, row 0 at the top, with optional guides. Every array holds `width * height` texels. */
export interface DenoiseTexels {
  width: number;
  height: number;
  /** Linear RGB per texel, 0 or more (HDR). */
  color: Float32Array;
  /** Chart of each texel: texels mix only with texels of the same chart; negative marks an empty texel, left as is. Default one chart. */
  chart?: Int32Array;
  /** Unit shading normal per texel (xyz). Neighbours facing away get less weight. */
  normals?: Float32Array;
  /** World position per texel (xyz); with `normals`, neighbours off the receiver's tangent plane get less weight. */
  positions?: Float32Array;
  /** Luminance noise variance per texel, when the bake knows it. Default estimated from neighbouring texels. */
  variance?: Float32Array;
}

/** Options of the denoisers. Every default is the papers' or measured on the package's tests. */
export interface DenoiseOptions {
  /** A-trous passes, 1 to 8; pass i spaces its taps 2^i texels apart, so 5 passes reach 61 texels across. Default 5. */
  iterations?: number;
  /** Luminance tolerance in noise standard deviations, 0.1 to 64 (SVGF's sigma_l). Larger smooths more. Default 4. */
  sigmaLuminance?: number;
  /** Exponent of the normal weight max(0, n.n)^p, 0 to 1,024 (SVGF's sigma_n). Default 128. */
  normalPower?: number;
  /** Tolerance of the plane weight, 0.01 to 100: off-plane distance per unit of in-plane distance. Default 1. */
  sigmaPlane?: number;
  /** Cancels the filter (checked every 64 rows). */
  signal?: AbortSignal;
}

/** The filtered texels and their remaining luminance noise variance. */
export interface DenoisedTexels {
  color: Float32Array;
  variance: Float32Array;
}

const B3 = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16],
  EPSILON = 1e-10,
  luminance = (c: Float32Array, i: number) => 0.2126 * c[i * 3] + 0.7152 * c[i * 3 + 1] + 0.0722 * c[i * 3 + 2];

interface Settings {
  iterations: number;
  sigmaL: number;
  power: number;
  sigmaPlane: number;
  signal?: AbortSignal;
}

function settingsOf(o: DenoiseOptions): Settings {
  return {
    iterations: inRange(o.iterations ?? 5, 1, 8, 'denoise iterations'),
    sigmaL: inRange(o.sigmaLuminance ?? 4, 0.1, 64, 'denoise sigmaLuminance', false),
    power: inRange(o.normalPower ?? 128, 0, 1024, 'denoise normalPower', false),
    sigmaPlane: inRange(o.sigmaPlane ?? 1, 0.01, 100, 'denoise sigmaPlane', false),
    signal: o.signal,
  };
}

function checkTexels(t: DenoiseTexels): number {
  const w = inRange(t?.width, 1, 8192, 'denoise width'),
    h = inRange(t?.height, 1, 8192, 'denoise height'),
    n = w * h;
  if (n > 16_777_216) throw new RangeError('denoise needs at most 16,777,216 texels; denoise a smaller lightmap');
  const sized = (a: unknown, per: number, name: string, type: 'Float32Array' | 'Int32Array') => {
    if (a === undefined) return;
    const ok = type === 'Float32Array' ? a instanceof Float32Array : a instanceof Int32Array;
    if (!ok || (a as Float32Array).length !== n * per)
      throw new RangeError(`denoise ${name} must be a ${type} of ${per === 1 ? '' : `${per} x `}width x height values`);
    if (type === 'Float32Array')
      for (const v of a as Float32Array)
        if (!Number.isFinite(v)) throw new RangeError(`denoise ${name} must be finite; check the bake for overflow`);
  };
  if (t.color === undefined) throw new RangeError('denoise needs color, a Float32Array of RGB per texel');
  sized(t.color, 3, 'color', 'Float32Array');
  sized(t.chart, 1, 'chart', 'Int32Array');
  sized(t.normals, 3, 'normals', 'Float32Array');
  sized(t.positions, 3, 'positions', 'Float32Array');
  sized(t.variance, 1, 'variance', 'Float32Array');
  for (const v of t.color) if (v < 0) throw new RangeError('denoise color must be 0 or more');
  return n;
}

/** Geometric similarity of texel q seen from texel p: normal and tangent-plane weights, 1 without guides. */
function geometry(t: DenoiseTexels, s: Settings, p: number, q: number): number {
  const n = t.normals;
  if (!n) return 1;
  const facing = n[p * 3] * n[q * 3] + n[p * 3 + 1] * n[q * 3 + 1] + n[p * 3 + 2] * n[q * 3 + 2];
  if (!(facing > 0)) return 0;
  let w = s.power ? facing ** s.power : 1;
  const x = t.positions;
  if (x) {
    const dx = x[q * 3] - x[p * 3],
      dy = x[q * 3 + 1] - x[p * 3 + 1],
      dz = x[q * 3 + 2] - x[p * 3 + 2],
      off = Math.abs(n[p * 3] * dx + n[p * 3 + 1] * dy + n[p * 3 + 2] * dz),
      along = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - off * off));
    w *= Math.exp(-off / (s.sigmaPlane * along + EPSILON));
  }
  return w;
}

/**
 * Starting noise variance per texel: (1.4826 * median |l_q - l_p| / sqrt 2)^2 over the 5 x 5 neighbours q of one chart
 * that face the same way. The median ignores a shadow edge as long as fewer than half the neighbours lie across it.
 */
async function noiseOf(t: DenoiseTexels, chart: Int32Array | null, s: Settings, lum: Float32Array) {
  const { width: w, height: h } = t,
    out = new Float32Array(w * h),
    diffs = new Float64Array(24);
  for (let y = 0; y < h; y++) {
    if (!(y & 63)) await checkpoint(s.signal);
    for (let x = 0; x < w; x++) {
      const p = y * w + x,
        id = chart ? chart[p] : 0;
      if (id < 0) continue;
      let k = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const qx = x + dx,
            qy = y + dy,
            q = qy * w + qx;
          if ((!dx && !dy) || qx < 0 || qy < 0 || qx >= w || qy >= h || (chart && chart[q] !== id)) continue;
          if (geometry(t, s, p, q) < 0.5) continue;
          diffs[k++] = Math.abs(lum[q] - lum[p]);
        }
      if (!k) continue;
      const sorted = diffs.subarray(0, k).sort(),
        median = k & 1 ? sorted[k >> 1] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2,
        sigma = (1.4826 * median) / Math.SQRT2;
      out[p] = sigma * sigma;
    }
  }
  return out;
}

/**
 * Denoises lightmap texels with the edge-avoiding a-trous wavelet filter (Dammertz et al. 2010) guided by the luminance
 * noise (Schied et al. 2017). Texels mix only within their chart; empty texels (negative chart) are copied as they are.
 * Noise-free regions stay as they are: a texel's luminance weight falls to zero for neighbours that differ while its
 * noise is zero. Returns new arrays; the input is not changed. Like every edge-avoiding filter it does not conserve
 * energy exactly: a texel's output is a weighted mean of its chart's texels.
 */
export async function denoiseTexels(texels: DenoiseTexels, options: DenoiseOptions = {}): Promise<DenoisedTexels> {
  const s = settingsOf(options),
    n = checkTexels(texels),
    { width: w, height: h } = texels,
    chart = texels.chart ? texels.chart.slice() : null,
    guides: DenoiseTexels = {
      ...texels,
      normals: texels.normals?.slice(),
      positions: texels.positions?.slice(),
    };
  let color = texels.color.slice(),
    lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = luminance(color, i);
  let variance = texels.variance ? texels.variance.slice() : await noiseOf(guides, chart, s, lum);
  for (const v of variance) if (!(v >= 0)) throw new RangeError('denoise variance must be 0 or more');
  for (let level = 0; level < s.iterations; level++) {
    const step = 1 << level,
      nextColor = color.slice(),
      nextVariance = variance.slice(),
      // SVGF prefilters the variance with a 3 x 3 Gaussian before using it in the luminance weight.
      smooth = new Float32Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x,
          id = chart ? chart[p] : 0;
        if (id < 0) continue;
        let sum = 0,
          weight = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const qx = x + dx,
              qy = y + dy,
              q = qy * w + qx;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h || (chart && chart[q] !== id)) continue;
            const k = (dx ? 0.5 : 1) * (dy ? 0.5 : 1);
            sum += variance[q] * k;
            weight += k;
          }
        smooth[p] = sum / weight;
      }
    for (let y = 0; y < h; y++) {
      if (!(y & 63)) await checkpoint(s.signal);
      for (let x = 0; x < w; x++) {
        const p = y * w + x,
          id = chart ? chart[p] : 0;
        if (id < 0) continue;
        const tolerance = s.sigmaL * Math.sqrt(smooth[p]) + EPSILON;
        let r = 0,
          g = 0,
          b = 0,
          total = 0,
          spread = 0;
        for (let j = 0; j < 5; j++) {
          const qy = y + (j - 2) * step;
          if (qy < 0 || qy >= h) continue;
          for (let i = 0; i < 5; i++) {
            const qx = x + (i - 2) * step,
              q = qy * w + qx;
            if (qx < 0 || qx >= w || (chart && chart[q] !== id)) continue;
            const weight =
              B3[i] *
              B3[j] *
              Math.exp(-Math.abs(lum[p] - lum[q]) / tolerance) *
              (q === p ? 1 : geometry(guides, s, p, q));
            if (!weight) continue;
            r += color[q * 3] * weight;
            g += color[q * 3 + 1] * weight;
            b += color[q * 3 + 2] * weight;
            total += weight;
            spread += weight * weight * variance[q];
          }
        }
        // The centre tap always counts (weight 9/64), so total is never zero.
        nextColor[p * 3] = r / total;
        nextColor[p * 3 + 1] = g / total;
        nextColor[p * 3 + 2] = b / total;
        nextVariance[p] = spread / (total * total);
      }
    }
    color = nextColor;
    variance = nextVariance;
    lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = luminance(color, i);
  }
  s.signal?.throwIfAborted();
  return { color, variance };
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

/**
 * Denoises the lightmap of a `bakeLightmap` or `bakeGlobalLightmap` atlas. `quads` must be the quads that were baked:
 * they give each chart its normal and each texel its position. Each quad's chart is filtered on its own (charts are
 * not neighbours in the atlas), from the RGBA8 lightmap decoded with `lightmapScale`; gutters are refilled from the
 * chart edges. Returns a new atlas sharing every other texture with the input.
 */
export async function denoiseLightmap(
  lightmap: Lightmap,
  quads: LightmapQuads,
  options: DenoiseOptions = {},
): Promise<Lightmap> {
  const { width, height, charts, textures, lightmapScale } = lightmap ?? ({} as Lightmap),
    positions = quads?.positions;
  if (!Array.isArray(charts) || !(textures?.lightmap instanceof Uint8Array))
    throw new RangeError('denoiseLightmap needs the atlas bakeLightmap or bakeGlobalLightmap returned');
  if (!(positions instanceof Float32Array) || positions.length !== charts.length * 12)
    throw new RangeError('denoiseLightmap quads must be the quads that were baked, 12 floats per chart');
  if (!(textures.lightmap.length === width * height * 4))
    throw new RangeError('denoiseLightmap lightmap texture must hold width x height RGBA8 texels');
  const n = width * height,
    color = new Float32Array(n * 3),
    chart = new Int32Array(n).fill(-1),
    normals = new Float32Array(n * 3),
    points = new Float32Array(n * 3);
  charts.forEach((c, q) => {
    const o = q * 12,
      u = [0, 1, 2].map((a) => positions[o + 3 + a] - positions[o + a]),
      v = [0, 1, 2].map((a) => positions[o + 9 + a] - positions[o + a]),
      cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      length = Math.hypot(cross[0], cross[1], cross[2]) || 1;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const at = (c.y + y) * width + c.x + x;
        chart[at] = q;
        for (let a = 0; a < 3; a++) {
          color[at * 3 + a] = (textures.lightmap[at * 4 + a] / 255) * lightmapScale;
          normals[at * 3 + a] = cross[a] / length;
          points[at * 3 + a] = positions[o + a] + (u[a] * (x + 0.5)) / c.width + (v[a] * (y + 0.5)) / c.height;
        }
      }
  });
  const out = await denoiseTexels({ width, height, color, chart, normals, positions: points }, options),
    data = textures.lightmap.slice();
  for (const c of charts)
    for (let y = -c.padding; y < c.height + c.padding; y++)
      for (let x = -c.padding; x < c.width + c.padding; x++) {
        // Gutter texels copy the nearest chart texel, as the bake fills them.
        const from =
            (c.y + Math.max(0, Math.min(c.height - 1, y))) * width + c.x + Math.max(0, Math.min(c.width - 1, x)),
          to = (c.y + y) * width + c.x + x;
        for (let a = 0; a < 3; a++) data[to * 4 + a] = byte(out.color[from * 3 + a] / lightmapScale);
      }
  return { ...lightmap, textures: { ...textures, lightmap: data } };
}

/** Charts of a mesh: triangles joined where they share a corner at the same UV1 and position. */
function meshCharts(positions: Float32Array, uv1: Float32Array, index: (i: number) => number, triangles: number) {
  const parent = Int32Array.from({ length: triangles }, (_, i) => i),
    root = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    },
    seen = new Map<string, number>();
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const v = index(t * 3 + k),
        key = `${uv1[v * 2]},${uv1[v * 2 + 1]},${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`,
        other = seen.get(key);
      if (other === undefined) seen.set(key, t);
      else parent[root(t)] = root(other);
    }
  return Int32Array.from({ length: triangles }, (_, t) => root(t));
}

/**
 * Denoises a `bakeMeshLightmap` result. `mesh` must be the mesh that was baked: it gives each texel its chart (UV
 * islands joined at shared corners), position and normal. Baked texels are filtered; the dilated border texels are
 * then dilated again from the filtered light, as the bake does. Returns a new result with `irradiance`, `lightmap` and
 * `lightmapScale` replaced.
 */
export async function denoiseMeshLightmap(
  baked: MeshLightmap,
  mesh: LightmapMesh,
  options: DenoiseOptions = {},
): Promise<MeshLightmap> {
  const { width: w, height: h, triangle, irradiance, lightmap } = baked ?? ({} as MeshLightmap),
    { positions, uv1, normals, indices } = mesh ?? ({} as LightmapMesh);
  if (!(triangle instanceof Int32Array) || !(irradiance instanceof Float32Array) || triangle.length !== w * h)
    throw new RangeError('denoiseMeshLightmap needs the result bakeMeshLightmap returned');
  if (!(positions instanceof Float32Array) || !(uv1 instanceof Float32Array) || uv1.length * 3 !== positions.length * 2)
    throw new RangeError('denoiseMeshLightmap mesh must be the mesh that was baked');
  const vertices = positions.length / 3,
    index = indices ? (i: number) => indices[i] : (i: number) => i,
    triangles = indices ? indices.length / 3 : vertices / 3;
  for (const t of triangle)
    if (t >= triangles) throw new RangeError('denoiseMeshLightmap mesh must be the mesh that was baked');
  if (indices)
    for (const v of indices)
      if (v >= vertices)
        throw new RangeError(
          'denoiseMeshLightmap mesh indices must be below the vertex count; pass the mesh that was baked',
        );
  const roots = meshCharts(positions, uv1, index, triangles),
    n = w * h,
    chart = new Int32Array(n).fill(-1),
    texelNormals = new Float32Array(n * 3),
    points = new Float32Array(n * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x,
        t = triangle[p];
      if (t < 0) continue;
      chart[p] = roots[t];
      // The texel centre's barycentric coordinates in the triangle's UV1, clamped onto the triangle.
      const [a, b, c] = [0, 1, 2].map((k) => index(t * 3 + k)),
        u = (x + 0.5) / w,
        v = (y + 0.5) / h,
        e1 = [uv1[b * 2] - uv1[a * 2], uv1[b * 2 + 1] - uv1[a * 2 + 1]],
        e2 = [uv1[c * 2] - uv1[a * 2], uv1[c * 2 + 1] - uv1[a * 2 + 1]],
        d = [u - uv1[a * 2], v - uv1[a * 2 + 1]],
        det = e1[0] * e2[1] - e1[1] * e2[0];
      let l1 = det ? (d[0] * e2[1] - d[1] * e2[0]) / det : 1 / 3,
        l2 = det ? (e1[0] * d[1] - e1[1] * d[0]) / det : 1 / 3;
      l1 = Math.max(0, l1);
      l2 = Math.max(0, l2);
      if (l1 + l2 > 1) {
        const sum = l1 + l2;
        l1 /= sum;
        l2 /= sum;
      }
      const l0 = 1 - l1 - l2,
        face = [0, 1, 2].map(
          (k) =>
            (positions[b * 3 + ((k + 1) % 3)] - positions[a * 3 + ((k + 1) % 3)]) *
              (positions[c * 3 + ((k + 2) % 3)] - positions[a * 3 + ((k + 2) % 3)]) -
            (positions[b * 3 + ((k + 2) % 3)] - positions[a * 3 + ((k + 2) % 3)]) *
              (positions[c * 3 + ((k + 1) % 3)] - positions[a * 3 + ((k + 1) % 3)]),
        ),
        normal = normals
          ? [0, 1, 2].map((k) => normals[a * 3 + k] * l0 + normals[b * 3 + k] * l1 + normals[c * 3 + k] * l2)
          : face,
        length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
      for (let k = 0; k < 3; k++) {
        points[p * 3 + k] = positions[a * 3 + k] * l0 + positions[b * 3 + k] * l1 + positions[c * 3 + k] * l2;
        texelNormals[p * 3 + k] = normal[k] / length;
      }
    }
  const out = await denoiseTexels(
      { width: w, height: h, color: irradiance, chart, normals: texelNormals, positions: points },
      options,
    ),
    light = out.color;
  // Dilated texels (alpha set, no triangle) are refilled ring by ring with the mean of their filled 8-neighbours.
  const filled = Uint8Array.from(chart, (c) => (c >= 0 ? 1 : 0));
  let open = 0;
  for (let p = 0; p < n; p++) if (!filled[p] && lightmap[p * 4 + 3]) open++;
  while (open) {
    const ring: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (filled[p] || !lightmap[p * 4 + 3]) continue;
        let count = 0;
        const sum = [0, 0, 0];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const qx = x + dx,
              qy = y + dy,
              q = qy * w + qx;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h || !filled[q]) continue;
            count++;
            for (let a = 0; a < 3; a++) sum[a] += light[q * 3 + a];
          }
        if (!count) continue;
        for (let a = 0; a < 3; a++) light[p * 3 + a] = sum[a] / count;
        ring.push(p);
      }
    if (!ring.length) break;
    for (const p of ring) filled[p] = 1;
    open -= ring.length;
  }
  let lightmapScale = 1;
  for (const v of light) lightmapScale = Math.max(lightmapScale, v);
  const encoded = lightmap.slice();
  for (let p = 0; p < n; p++) {
    if (!encoded[p * 4 + 3]) continue;
    for (let a = 0; a < 3; a++) encoded[p * 4 + a] = byte(light[p * 3 + a] / lightmapScale);
  }
  return { ...baked, irradiance: light, lightmap: encoded, lightmapScale };
}
