// CPU twin of the SpatialUpscale shaders (upscale.ts), for the tests: the same edge analysis, kernel and sharpening
// lobe in plain numbers, on RGBA float images in display-encoded (perceptual) values. Not part of the public entry.
// See upscale.ts for the method and its sources.

/** Luma used by the edge analysis: (r + 2g + b) / 4. */
export const luma = (r, g, b) => 0.25 * r + 0.5 * g + 0.25 * b;

/** Feature length along one axis from three lumas: 1 for a step (no reversal), 0 for a full reversal or flat. */
export function axisLength(before, centre, after) {
  const left = Math.abs(centre - before),
    right = Math.abs(after - centre),
    most = Math.max(left, right);
  if (most <= 1e-5) return 0;
  const t = Math.abs(right - left) / most;
  return t * t;
}

/** Central-difference gradient (dx, dy) and feature length of one texel from its plus neighbours' lumas. */
export function analyse(c, n, s, w, e) {
  return [e - w, s - n, Math.max(axisLength(w, c, e), axisLength(n, c, s))];
}

/** Kernel weight at squared distance `s` (in the stretched frame) with squared window radius `r2` (2 to 4). */
export function kernel(s, r2) {
  if (s >= r2) return 0;
  const window = 1 - s / r2;
  return (1 - s) * (1 - 0.25 * s) * window * window;
}

/** The kernel frame of a point: unit gradient direction, stretch across and along the edge, squared window radius. */
export function frame(dx, dy, length) {
  const d2 = dx * dx + dy * dy,
    inv = d2 > 1e-10 ? 1 / Math.sqrt(d2) : 0,
    g = d2 > 1e-10 ? [dx * inv, dy * inv] : [1, 0],
    stretch = 1 / Math.max(Math.abs(g[0]), Math.abs(g[1]));
  return {
    g,
    across: 1 + (stretch - 1) * length,
    along: 1 + length,
    r2: 2 + 2 * length,
  };
}

/** The 12 taps around the 2x2 quad (4x4 minus its corners), offsets from the quad's top-left texel. */
export const taps = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [-1, 1],
  [2, 0],
  [2, 1],
  [0, 2],
  [1, 2],
];

/** Edge-adaptive upscale of an RGBA float image (`w` x `h`) to `ow` x `oh`. */
export function easu(image, w, h, ow, oh) {
  const out = new Float32Array(ow * oh * 4),
    at = (x, y) => 4 * (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))),
    l = (x, y) => {
      const i = at(x, y);
      return luma(image[i], image[i + 1], image[i + 2]);
    };
  for (let oy = 0; oy < oh; oy++)
    for (let ox = 0; ox < ow; ox++) {
      const px = ((ox + 0.5) * w) / ow - 0.5,
        py = ((oy + 0.5) * h) / oh - 0.5,
        bx = Math.floor(px),
        by = Math.floor(py),
        fx = px - bx,
        fy = py - by;
      const quad = [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
      ];
      let dx = 0,
        dy = 0,
        length = 0;
      for (const [qx, qy, weight] of quad) {
        const x = bx + qx,
          y = by + qy,
          a = analyse(l(x, y), l(x, y - 1), l(x, y + 1), l(x - 1, y), l(x + 1, y));
        dx += a[0] * weight;
        dy += a[1] * weight;
        length += a[2] * weight;
      }
      const f = frame(dx, dy, length),
        sum = [0, 0, 0],
        lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      let total = 0,
        alpha = 0;
      for (let k = 0; k < taps.length; k++) {
        const [tx, ty] = taps[k],
          i = at(bx + tx, by + ty),
          ox2 = tx - fx,
          oy2 = ty - fy,
          u = (ox2 * f.g[0] + oy2 * f.g[1]) / f.across,
          v = (-ox2 * f.g[1] + oy2 * f.g[0]) / f.along,
          weight = kernel(u * u + v * v, f.r2);
        for (let c = 0; c < 3; c++) {
          sum[c] += image[i + c] * weight;
          if (k < 4) {
            lo[c] = Math.min(lo[c], image[i + c]);
            hi[c] = Math.max(hi[c], image[i + c]);
          }
        }
        if (k < 4) alpha += image[i + 3] * quad[k][2];
        total += weight;
      }
      const o = 4 * (oy * ow + ox);
      for (let c = 0; c < 3; c++) out[o + c] = Math.min(hi[c], Math.max(lo[c], sum[c] / total));
      out[o + 3] = alpha;
    }
  return out;
}

/** Most negative ring weight before the sharpened value can leave 0..1, from the five taps' per-channel min and max. */
export const LOBE_LIMIT = -0.2;
export function lobe(lo, hi, sharpen) {
  let w = LOBE_LIMIT;
  for (let c = 0; c < 3; c++) {
    w = Math.max(w, -lo[c] / (4 * Math.max(hi[c], 1e-5)), -(1 - hi[c]) / (4 * Math.max(1 - lo[c], 1e-5)));
  }
  // + 0 turns -0 into 0.
  return Math.min(0, w) * sharpen + 0;
}

/** Contrast-adaptive sharpening of an RGBA float image (`w` x `h`) on its four-neighbour cross. */
export function rcas(image, w, h, sharpen) {
  const out = new Float32Array(image.length),
    at = (x, y) => 4 * (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const cross = [at(x, y), at(x, y - 1), at(x - 1, y), at(x + 1, y), at(x, y + 1)],
        lo = [0, 1, 2].map((c) => Math.min(...cross.map((i) => image[i + c]))),
        hi = [0, 1, 2].map((c) => Math.max(...cross.map((i) => image[i + c]))),
        k = lobe(lo, hi, sharpen),
        o = cross[0];
      for (let c = 0; c < 3; c++) {
        const ring = image[cross[1] + c] + image[cross[2] + c] + image[cross[3] + c] + image[cross[4] + c];
        out[o + c] = (image[o + c] + k * ring) / (1 + 4 * k);
      }
      out[o + 3] = image[o + 3];
    }
  return out;
}
