/**
 * Exact Euclidean distance transform (Felzenszwalb and Huttenlocher), the algorithm TinySDF uses.
 * Pure CPU code with no DOM access, so it runs in Node, workers and the main thread alike.
 */

const INF = 1e20;

/** Signed distance field parameters shared by the rasterizer and the shader. */
export interface SdfParams {
  /** Distance in glyph pixels that maps to the full 0..255 range. */
  radius: number;
  /** Fraction of the range used inside the shape; the edge sits at 1 - cutoff. */
  cutoff: number;
}

/** Defaults: 48 px glyphs, a 10 px range with a quarter of it inside the shape. */
export const SDF_DEFAULTS = {size: 48, buffer: 8, radius: 10, cutoff: 0.25} as const;

interface Scratch {f: Float64Array; v: Uint32Array; z: Float64Array}
let scratch: Scratch | undefined;
const workspace = (length: number): Scratch => {
  if (!scratch || scratch.f.length < length) scratch = {f: new Float64Array(length), v: new Uint32Array(length), z: new Float64Array(length + 1)};
  return scratch;
};

/** 1D squared distance transform of a sampled function along one row or column, in place. */
function transform1d(grid: Float64Array, offset: number, stride: number, length: number, {f, v, z}: Scratch): void {
  v[0] = 0; z[0] = -INF; z[1] = INF; f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k], d = q - r;
    grid[offset + q * stride] = f[r] + d * d;
  }
}

/**
 * In-place 2D squared Euclidean distance transform of a sampled function: every cell becomes
 * min over all cells p of (|q - p|^2 + grid[p]). Seed cells with 0 (feature) or a large value (1e20).
 */
export function squaredDistanceTransform(grid: Float64Array, width: number, height: number): Float64Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 || grid.length < width * height) throw new RangeError('Invalid distance transform size');
  const s = workspace(Math.max(width, height));
  for (let x = 0; x < width; x++) transform1d(grid, x, width, height, s);
  for (let y = 0; y < height; y++) transform1d(grid, y * width, 1, width, s);
  return grid;
}

/**
 * Converts an alpha coverage bitmap into an 8-bit signed distance field like TinySDF: partially covered
 * pixels seed sub-pixel distances, the edge lands at 255 * (1 - cutoff), and each unit is radius / 255 pixels.
 * `stride` and `channel` read alpha from interleaved data such as RGBA ImageData (stride 4, channel 3).
 */
export function alphaToSdf(alpha: ArrayLike<number>, width: number, height: number, params: SdfParams = SDF_DEFAULTS, stride = 1, channel = 0, out = new Uint8Array(width * height)): Uint8Array {
  const size = width * height, {radius, cutoff} = params;
  if (!(radius > 0) || !(cutoff >= 0 && cutoff <= 1)) throw new RangeError('Invalid SDF parameters');
  if (alpha.length < (size - 1) * stride + channel + 1 && size) throw new RangeError('Alpha data is too short');
  const outer = new Float64Array(size), inner = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = alpha[i * stride + channel] / 255;
    if (a >= 1) {outer[i] = 0; inner[i] = INF;}
    else if (a <= 0) {outer[i] = INF; inner[i] = 0;}
    else {const d = 0.5 - a; outer[i] = d > 0 ? d * d : 0; inner[i] = d < 0 ? d * d : 0;}
  }
  squaredDistanceTransform(outer, width, height);
  squaredDistanceTransform(inner, width, height);
  for (let i = 0; i < size; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    out[i] = Math.max(0, Math.min(255, Math.round(255 - 255 * (d / radius + cutoff))));
  }
  return out;
}

/** Distance in field pixels (positive outside) encoded by an SDF byte; the inverse of alphaToSdf's mapping. */
export const sdfDistance = (value: number, params: SdfParams = SDF_DEFAULTS): number => ((255 - value) / 255 - params.cutoff) * params.radius;
