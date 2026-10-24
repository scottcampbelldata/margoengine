// Glyph signed distance fields. The distance transform is the linear-time lower envelope of parabolas from
// P. F. Felzenszwalb and D. P. Huttenlocher, "Distance Transforms of Sampled Functions", Theory of Computing 8 (2012)
// 415-428: section 2.1 for one dimension, section 3 for the separable 2D transform (columns, then rows).

/** Signed distance field parameters shared by the rasterizer and the shader. */
export interface SdfParams {
  /** Distance in glyph pixels that maps to the full 0..255 range. */
  radius: number;
  /** Fraction of the byte range used for the inside of the shape; the edge sits at byte 255 * (1 - cutoff). */
  cutoff: number;
}

/** Glyph rasterisation defaults: base size 48 px, 8 px of empty buffer around each glyph, radius 10 px, cutoff 0.25. */
export const SDF_DEFAULTS = { size: 48, buffer: 8, radius: 10, cutoff: 0.25 } as const;

// Stand-in for "no feature here" (the paper's infinity): large enough to dominate any squared pixel distance, small
// enough that its square root stays finite.
const FAR = 1e20;

// Reused scratch for one line of the transform, grown to the longest line seen so far.
let lineIn = new Float64Array(0), // f along the line
  lineOut = new Float64Array(0), // transformed line
  lineArg = new Int32Array(0), // index along the line of the minimising sample
  hull = new Int32Array(0), // positions of the parabolas on the lower envelope
  bounds = new Float64Array(0); // bounds[k]..bounds[k + 1] is where parabola hull[k] is lowest

function reserve(n: number): void {
  if (lineIn.length >= n) return;
  lineIn = new Float64Array(n);
  lineOut = new Float64Array(n);
  lineArg = new Int32Array(n);
  hull = new Int32Array(n);
  bounds = new Float64Array(n + 1);
}

// One-dimensional transform of lineIn[0..n): lineOut[q] = min over p of (q - p)^2 + lineIn[p], lineArg[q] = that p.
function envelope(n: number): void {
  let top = 0;
  hull[0] = 0;
  bounds[0] = -Infinity;
  bounds[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = lineIn[q] + q * q;
    // Where the parabola rooted at q crosses the topmost one; pop parabolas it hides completely.
    let p = hull[top],
      cross = (fq - (lineIn[p] + p * p)) / (2 * (q - p));
    while (cross <= bounds[top]) {
      top--;
      p = hull[top];
      cross = (fq - (lineIn[p] + p * p)) / (2 * (q - p));
    }
    top++;
    hull[top] = q;
    bounds[top] = cross;
    bounds[top + 1] = Infinity;
  }
  for (let q = 0, k = 0; q < n; q++) {
    while (bounds[k + 1] < q) k++;
    const p = hull[k];
    lineOut[q] = (q - p) * (q - p) + lineIn[p];
    lineArg[q] = p;
  }
}

// Exact 2D squared transform in place. With `nearest`, also stores per cell the row-major index of the minimising cell.
function transform2d(grid: Float64Array, width: number, height: number, nearest?: Int32Array): void {
  reserve(Math.max(width, height));
  // Columns: afterwards grid holds the per-column minimum and nearest (if given) the minimising row.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) lineIn[y] = grid[y * width + x];
    envelope(height);
    for (let y = 0; y < height; y++) {
      grid[y * width + x] = lineOut[y];
      if (nearest) nearest[y * width + x] = lineArg[y];
    }
  }
  // Rows: the minimising column picks which column's minimising row is the 2D nearest cell.
  for (let y = 0, row = 0; y < height; y++, row += width) {
    for (let x = 0; x < width; x++) lineIn[x] = grid[row + x];
    envelope(width);
    for (let x = 0; x < width; x++) grid[row + x] = lineOut[x];
    if (nearest) {
      for (let x = 0; x < width; x++) lineIn[x] = nearest[row + lineArg[x]] * width + lineArg[x];
      for (let x = 0; x < width; x++) nearest[row + x] = lineIn[x];
    }
  }
}

function checkSize(length: number, width: number, height: number): void {
  if (!(Number.isInteger(width) && width >= 0 && Number.isInteger(height) && height >= 0) || length < width * height)
    throw new RangeError(
      'Invalid distance transform size: width and height must be non-negative integers and the grid must hold width * height cells',
    );
}

/**
 * In-place squared Euclidean distance transform of a sampled function on a `width` x `height` row-major grid: each
 * cell becomes the minimum over all cells p of (squared distance between the two cell centres + `grid[p]`), using the
 * linear-time lower envelope of parabolas of Felzenszwalb and Huttenlocher (2012) along columns, then rows. Seed
 * feature cells with 0 and empty cells with 1e20 (a stand-in for infinity); cells with no feature in reach keep at
 * least 1e20. Exact for integer seeds. Scratch memory is reused between calls.
 *
 * @throws RangeError when width or height is not a non-negative integer, or the grid is shorter than width * height.
 * @returns `grid`.
 */
export function squaredDistanceTransform(grid: Float64Array, width: number, height: number): Float64Array {
  checkSize(grid.length, width, height);
  if (width * height > 0) transform2d(grid, width, height);
  return grid;
}

/**
 * 8-bit signed distance field of an alpha coverage bitmap (row-major, `width` x `height`, 0 outside, 255 inside).
 * Reads alpha at `i * stride + channel` (stride 4, channel 3 for RGBA ImageData). The distance d of a pixel centre to
 * the edge (positive outside) is stored as `round(255 - 255 * (d / radius + cutoff))` clamped to 0..255.
 *
 * Fully covered and empty pixels measure centre to centre (a binary image gives exactly the Euclidean distance to the
 * nearest pixel of the other kind). A partly covered pixel with coverage c puts the edge 0.5 - c pixels from its own
 * centre (outward positive), so coverage 0.5 puts it through the centre, and pixels whose nearest pixel of the other
 * side is partly covered add that offset to the centre distance.
 *
 * @param params Distance range and edge position; defaults to {@link SDF_DEFAULTS}.
 * @param stride Entries per pixel in `alpha` (default 1).
 * @param channel Offset of the alpha entry within a pixel (default 0).
 * @param out Destination, at least `width * height` bytes (default a new array).
 * @throws RangeError when `radius` is not above 0, `cutoff` is outside [0, 1], or `alpha` is too short.
 * @returns `out`.
 */
export function alphaToSdf(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  params: SdfParams = SDF_DEFAULTS,
  stride = 1,
  channel = 0,
  out: Uint8Array = new Uint8Array(width * height),
): Uint8Array {
  const { radius, cutoff } = params;
  if (!(radius > 0) || !(cutoff >= 0 && cutoff <= 1))
    throw new RangeError('Invalid SDF parameters: radius must be above 0 and cutoff within [0, 1]');
  checkSize(Infinity, width, height);
  const count = width * height;
  if (count === 0) return out;
  if (alpha.length < (count - 1) * stride + channel + 1)
    throw new RangeError(
      'Alpha data is too short: it needs (width * height - 1) * stride + channel + 1 entries; check stride and channel',
    );
  // Edge offset of each pixel from its centre in pixels, outward positive: NaN for fully covered or empty pixels.
  const offset = new Float64Array(count),
    toInside = new Float64Array(count), // features: any coverage
    toOutside = new Float64Array(count), // features: anything not fully covered
    nearInside = new Int32Array(count),
    nearOutside = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const a = alpha[i * stride + channel];
    toInside[i] = a > 0 ? 0 : FAR;
    toOutside[i] = a < 255 ? 0 : FAR;
    offset[i] = a > 0 && a < 255 ? 0.5 - a / 255 : Number.NaN;
  }
  // Distance from pixel i (empty when `outside`, else fully covered) to the edge beyond pixel `nearest` (the nearest centre of the other kind,
  // squared distance `squared`). A partly covered pixel's edge is `offset` away from its centre; the nearest centre
  // need not hold the nearest edge, so its 3 x 3 neighbourhood of partly covered pixels is searched as well.
  const nearestEdge = (i: number, outside: boolean, nearest: number, squared: number): number => {
    const outward = outside ? 1 : -1,
      qx = i % width,
      qy = (i - qx) / width,
      px = nearest % width,
      py = (nearest - px) / width;
    let best = Number.isNaN(offset[nearest]) ? Math.sqrt(squared) : Number.POSITIVE_INFINITY;
    for (let y = Math.max(py - 1, 0); y <= Math.min(py + 1, height - 1); y++)
      for (let x = Math.max(px - 1, 0); x <= Math.min(px + 1, width - 1); x++) {
        const shift = offset[y * width + x];
        if (Number.isNaN(shift)) continue; // a whole pixel no nearer than `nearest`
        const estimate = Math.hypot(x - qx, y - qy) + outward * shift;
        if (estimate < best) best = estimate;
      }
    return best;
  };
  transform2d(toInside, width, height, nearInside);
  transform2d(toOutside, width, height, nearOutside);
  for (let i = 0; i < count; i++) {
    let d = offset[i];
    if (Number.isNaN(d)) {
      // Empty pixels measure to the shape, fully covered ones to the background (negated). An all-inside or
      // all-outside image leaves the far value, which saturates.
      const outside = toInside[i] > 0,
        squared = outside ? toInside[i] : toOutside[i];
      d =
        squared >= FAR
          ? Number.POSITIVE_INFINITY
          : nearestEdge(i, outside, outside ? nearInside[i] : nearOutside[i], squared);
      if (!outside) d = -d;
    }
    const byte = Math.round(255 - 255 * (d / radius + cutoff));
    out[i] = byte < 0 ? 0 : byte > 255 ? 255 : byte;
  }
  return out;
}

/**
 * Signed distance in field pixels (positive outside) that a byte of {@link alphaToSdf} encodes: the exact inverse of
 * its byte mapping without rounding or clamping, `((255 - value) / 255 - cutoff) * radius`.
 */
export const sdfDistance = (value: number, params: SdfParams = SDF_DEFAULTS): number =>
  ((255 - value) / 255 - params.cutoff) * params.radius;
