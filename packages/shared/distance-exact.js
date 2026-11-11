// Exact squared Euclidean distance transform of a sampled function on a grid of any dimension, the linear-time lower
// envelope of parabolas from P. F. Felzenszwalb and D. P. Huttenlocher, "Distance Transforms of Sampled Functions",
// Theory of Computing 8 (2012) 415-428: section 2.1 for one dimension, section 3 for the separable transform (one
// axis at a time, the slowest axis first). Shared by the text package (glyph signed distance fields) and
// @margoengine/compute/distance (the oracle the jump flooding output is tested against, and its CPU path).

// Reused scratch for one line of the transform, grown to the longest line seen so far.
let lineIn = new Float64Array(0), // f along the line
  lineOut = new Float64Array(0), // transformed line
  lineArg = new Int32Array(0), // index along the line of the minimising sample
  lineNear = new Int32Array(0), // nearest-cell indices along the line, rewritten from lineArg
  hull = new Int32Array(0), // positions of the parabolas on the lower envelope
  bounds = new Float64Array(0); // bounds[k]..bounds[k + 1] is where parabola hull[k] is lowest

function reserve(n) {
  if (lineIn.length >= n) return;
  lineIn = new Float64Array(n);
  lineOut = new Float64Array(n);
  lineArg = new Int32Array(n);
  lineNear = new Int32Array(n);
  hull = new Int32Array(n);
  bounds = new Float64Array(n + 1);
}

// One-dimensional transform of lineIn[0..n): lineOut[q] = min over p of (q - p)^2 + lineIn[p], lineArg[q] = that p.
function envelope(n) {
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

/**
 * In-place exact squared distance transform of `grid` on a row-major grid of `dims` (`[width, height]` or
 * `[width, height, depth]`, x fastest): each cell becomes the minimum over all cells p of (squared distance in cells
 * between the two centres + grid[p]). Seed cells hold 0 and the others a large stand-in for infinity. With `nearest`
 * (an Int32Array of at least the grid's size), each cell also gets the row-major index of its minimising cell.
 * Callers validate `dims` and the array lengths.
 */
export function squaredDistanceTransformNd(grid, dims, nearest) {
  const rank = dims.length;
  let count = 1;
  for (const d of dims) count *= d;
  if (count === 0) return grid;
  reserve(Math.max(...dims));
  if (nearest) for (let i = 0; i < count; i++) nearest[i] = i;
  const strides = [];
  for (let axis = 0, s = 1; axis < rank; axis++, s *= dims[axis - 1]) strides.push(s);
  for (let axis = rank - 1; axis >= 0; axis--) {
    const n = dims[axis],
      step = strides[axis];
    // A line starts where this axis' coordinate is 0: `low` cells below it, `high` blocks of n * step above it.
    for (let high = 0; high < count; high += n * step)
      for (let low = 0; low < step; low++) {
        const base = high + low;
        for (let q = 0, i = base; q < n; q++, i += step) lineIn[q] = grid[i];
        envelope(n);
        if (nearest) for (let q = 0; q < n; q++) lineNear[q] = nearest[base + lineArg[q] * step];
        for (let q = 0, i = base; q < n; q++, i += step) {
          grid[i] = lineOut[q];
          if (nearest) nearest[i] = lineNear[q];
        }
      }
  }
  return grid;
}
