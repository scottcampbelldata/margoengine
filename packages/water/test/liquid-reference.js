// Float64 oracle of the narrow-range filter (N. Truong and C. Yuksel, A Narrow-Range Filter for Screen-Space Fluid
// Rendering, I3D 2018, equations 1 to 9), written from the paper independently of the WGSL. Depth d is eye depth
// (positive, growing away from the eye); 0 marks an empty pixel, which reads as infinitely far.

const FAR = Infinity;

/** One pass over `depth` (width x height). `step` [1,0] or [0,1] filters along an axis; 'cleanup' runs the 5 x 5. */
export function narrowRangePass(depth, width, height, step, p) {
  const out = new Float64Array(width * height);
  const at = (x, y) => {
    // Outside the image nothing is known: the pair is left out.
    if (x < 0 || y < 0 || x >= width || y >= height) return -1;
    const d = depth[y * width + x];
    return d > 0 ? d : FAR;
  };
  const pairs =
    step === 'cleanup'
      ? [
          [1, 0],
          [0, 1],
          [1, 1],
          [-1, 1],
          [2, 0],
          [0, 2],
          [2, 1],
          [1, 2],
          [-1, 2],
          [-2, 1],
          [2, 2],
          [-2, 2],
        ]
      : undefined;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const di = depth[y * width + x];
      if (!(di > 0)) continue;
      let lo = p.delta,
        hi = p.delta,
        sum = di,
        weight = 1;
      const pair = (dj, dk, g) => {
        // Equation 6 (bias correction): a pair is dropped when either side is closer than the high threshold.
        if (dj < 0 || dk < 0 || di - dj > hi || di - dk > hi) return;
        for (const d of [dj, dk]) {
          // Equation 2 with the dynamic low threshold of equation 7.
          const inside = d <= di + lo;
          sum += g * (inside ? d : di + p.mu);
          weight += g;
          // Equations 8 and 9, only for neighbours inside the current range.
          if (inside && d >= di - hi) {
            lo = Math.max(lo, d - di + p.delta);
            hi = Math.max(hi, di - d + p.delta);
          }
        }
      };
      if (pairs) {
        for (const [ox, oy] of pairs)
          pair(at(x - ox, y - oy), at(x + ox, y + oy), Math.exp(-0.5 * (ox * ox + oy * oy)));
      } else {
        // Equation 5: sigma_i = H sigma / (2 d_i tan(fov / 2)); kernel radius 3 sigma_i, clamped.
        const sigma = Math.max((height * p.sigma) / (2 * di * p.tanHalfFov), 1e-3);
        const radius = Math.min(Math.max(Math.ceil(3 * sigma), 1), p.maxRadius);
        for (let o = 1; o <= radius; o++)
          pair(
            at(x - step[0] * o, y - step[1] * o),
            at(x + step[0] * o, y + step[1] * o),
            Math.exp(-(o * o) / (2 * sigma * sigma)),
          );
      }
      out[y * width + x] = sum / weight;
    }
  return out;
}

/** The full filter: horizontal, vertical, then the 5 x 5 clean-up. */
export function narrowRangeFilter(depth, width, height, p) {
  const a = narrowRangePass(depth, width, height, [1, 0], p);
  const b = narrowRangePass(a, width, height, [0, 1], p);
  return narrowRangePass(b, width, height, 'cleanup', p);
}
