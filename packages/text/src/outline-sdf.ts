// Signed distance fields straight from glyph outlines, on the CPU, in plain TypeScript. Clean room (docs/clean-room.md,
// "Text outline SDF"): the field encoding follows C. Green, "Improved Alpha-Tested Magnification for Vector Textures and
// Special Effects", SIGGRAPH 2007 Course 28; curves are flattened with the uniform second-difference bound (R. Goldman,
// "Pyramid Algorithms", 2003; J. Gravesen, Computational Geometry 8(1), 1997); the sign is the nonzero winding number of
// the outline (K. Hormann and A. Agathos, Computational Geometry 20(3), 2001) by scanline crossings at texel centres; the
// magnitude is the exact distance to the nearest flattened piece (closest point on a segment, C. Ericson, "Real-Time
// Collision Detection", 2005). Only + - * / and sqrt are used on non-integers, all correctly rounded in IEEE 754, so a
// page and a Node process build the same bytes.

/** Field parameters for {@link outlineSdf}, in pixels of the base size. */
export interface OutlineSdfOptions {
  /** Pixels per em. */
  size: number;
  /** Distance in pixels that spans the byte range. */
  radius: number;
  /** Fraction of the byte range inside the shape (the edge sits at 255 * (1 - cutoff)). */
  cutoff: number;
  /** Empty texels added around the outline's pixel box. */
  buffer: number;
}

/** A glyph field from {@link outlineSdf}: `left` and `top` are the bitmap's corner relative to the pen, y up. */
export interface OutlineSdf {
  width: number;
  height: number;
  left: number;
  top: number;
  data: Uint8Array;
  /** Texel to piece distance evaluations spent (a work count). */
  evaluations: number;
  /** True when some outline edges had ink on both sides (overlapping or abutting contours) and were left out. */
  overlapped: boolean;
}

/** Version of the field bytes {@link outlineSdf} writes; part of every glyph cache key. */
export const OUTLINE_SDF_VERSION = 1;

/** Largest number of pieces one curve is flattened into. */
const MAX_PIECES = 1024;

/** Number of uniform pieces that keep a curve with second difference length `second` within `tolerance`. */
function pieces(second: number, factor: number, tolerance: number): number {
  // A uniform split into n keeps every chord within factor * |second| / n^2 of the curve.
  const n = Math.ceil(Math.sqrt((factor * second) / tolerance));
  return n < 1 ? 1 : n > MAX_PIECES ? MAX_PIECES : n;
}

/**
 * Flattens outline contours (em units, y up; lines [x0,y0,x1,y1], quadratics of 6 and cubics of 8 numbers) to closed
 * pieces in pixels: [ax, ay, bx, by] per piece in one array. Each contour is closed with a line when it is open.
 */
export function flattenOutline(
  contours: readonly (readonly (readonly number[])[])[],
  size: number,
  tolerance: number,
): Float64Array {
  const out: number[] = [];
  const push = (ax: number, ay: number, bx: number, by: number) => {
    if (ax !== bx || ay !== by) out.push(ax, ay, bx, by);
  };
  for (const loop of contours) {
    if (!loop.length) continue;
    const first = loop[0],
      sx = first[0] * size,
      sy = first[1] * size;
    let px = sx,
      py = sy;
    for (const s of loop) {
      const x0 = px,
        y0 = py;
      if (s.length === 4) {
        const x1 = s[2] * size,
          y1 = s[3] * size;
        push(x0, y0, x1, y1);
        px = x1;
        py = y1;
      } else if (s.length === 6) {
        const x1 = s[2] * size,
          y1 = s[3] * size,
          x2 = s[4] * size,
          y2 = s[5] * size,
          dx = x0 - 2 * x1 + x2,
          dy = y0 - 2 * y1 + y2,
          n = pieces(Math.sqrt(dx * dx + dy * dy), 0.25, tolerance);
        let ax = x0,
          ay = y0;
        for (let i = 1; i <= n; i++) {
          let bx = x2,
            by = y2;
          if (i < n) {
            const t = i / n,
              u = 1 - t;
            bx = u * u * x0 + 2 * u * t * x1 + t * t * x2;
            by = u * u * y0 + 2 * u * t * y1 + t * t * y2;
          }
          push(ax, ay, bx, by);
          ax = bx;
          ay = by;
        }
        px = x2;
        py = y2;
      } else if (s.length === 8) {
        const x1 = s[2] * size,
          y1 = s[3] * size,
          x2 = s[4] * size,
          y2 = s[5] * size,
          x3 = s[6] * size,
          y3 = s[7] * size,
          ex = x0 - 2 * x1 + x2,
          ey = y0 - 2 * y1 + y2,
          fx = x1 - 2 * x2 + x3,
          fy = y1 - 2 * y2 + y3,
          e = Math.sqrt(ex * ex + ey * ey),
          f = Math.sqrt(fx * fx + fy * fy),
          n = pieces(e > f ? e : f, 0.75, tolerance);
        let ax = x0,
          ay = y0;
        for (let i = 1; i <= n; i++) {
          let bx = x3,
            by = y3;
          if (i < n) {
            const t = i / n,
              u = 1 - t,
              a = u * u * u,
              b = 3 * u * u * t,
              c = 3 * u * t * t,
              d = t * t * t;
            bx = a * x0 + b * x1 + c * x2 + d * x3;
            by = a * y0 + b * y1 + c * y2 + d * y3;
          }
          push(ax, ay, bx, by);
          ax = bx;
          ay = by;
        }
        px = x3;
        py = y3;
      }
    }
    push(px, py, sx, sy);
  }
  return Float64Array.from(out);
}

/** Nonzero winding number of the closed pieces at a point (a ray towards +x, half-open in y). */
export function windingAt(segments: Float64Array, x: number, y: number): number {
  let w = 0;
  for (let k = 0; k < segments.length; k += 4) {
    const ay = segments[k + 1],
      by = segments[k + 3];
    if (ay <= y ? by > y : by <= y) {
      const ax = segments[k],
        bx = segments[k + 2],
        cx = ax + ((y - ay) * (bx - ax)) / (by - ay);
      if (cx > x) w += by > ay ? 1 : -1;
    }
  }
  return w;
}

/**
 * The 8-bit signed distance field of a glyph outline: byte = round(255 - 255 * (d / radius + cutoff)) clamped, with d
 * the distance from the texel centre to the outline in pixels, negative inside (the encoding of `alphaToSdf`). Inside
 * is the nonzero winding rule. Where contours overlap or abut (variable fonts, CJK, letters built from parts), edges
 * with ink on both sides are left out, so the interior shows no seam. Returns null when the outline is empty.
 */
export function outlineSdf(
  contours: readonly (readonly (readonly number[])[])[],
  options: OutlineSdfOptions,
): OutlineSdf | null {
  const { size, radius, cutoff, buffer } = options;
  // A quarter of a byte step, at most 1/64 px.
  const tolerance = Math.min(1 / 64, radius / 1020);
  const flat = flattenOutline(contours, size, tolerance);
  if (!flat.length) return null;
  let xmin = Infinity,
    xmax = -Infinity,
    ymin = Infinity,
    ymax = -Infinity;
  for (let k = 0; k < flat.length; k += 2) {
    const x = flat[k],
      y = flat[k + 1];
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  if (!(xmax > xmin) || !(ymax > ymin)) return null;
  const x0 = Math.floor(xmin),
    x1 = Math.ceil(xmax),
    y0 = Math.floor(ymin),
    y1 = Math.ceil(ymax);
  const width = x1 - x0 + 2 * buffer,
    height = y1 - y0 + 2 * buffer,
    left = x0 - buffer,
    top = y1 + buffer;
  // Texel space: texel (i, j) has its centre at (i, j), rows downward. A piece whose ends round together there is
  // dropped (its neighbours still meet), so no piece has zero length.
  const moved: number[] = [];
  for (let k = 0; k < flat.length; k += 4) {
    const ax = flat[k] - left - 0.5,
      ay = top - 0.5 - flat[k + 1],
      bx = flat[k + 2] - left - 0.5,
      by = top - 0.5 - flat[k + 3];
    if (ax !== bx || ay !== by) moved.push(ax, ay, bx, by);
  }
  const segments = Float64Array.from(moved);
  const count = width * height,
    winding = new Int32Array(count);
  // Crossings per row: each piece crosses the rows j with min <= j < max (half-open, so shared ends count once).
  const rows: number[][] = Array.from({ length: height }, () => []);
  for (let k = 0; k < segments.length; k += 4) {
    const ax = segments[k],
      ay = segments[k + 1],
      bx = segments[k + 2],
      by = segments[k + 3];
    if (ay === by) continue;
    const lo = ay < by ? ay : by,
      hi = ay < by ? by : ay,
      dir = by > ay ? 1 : -1;
    for (let j = Math.max(0, Math.ceil(lo)); j < height && j < hi; j++)
      rows[j].push(ax + ((j - ay) * (bx - ax)) / (by - ay), dir);
  }
  const order: number[] = [];
  for (let j = 0; j < height; j++) {
    const row = rows[j];
    if (!row.length) continue;
    order.length = 0;
    for (let c = 0; c < row.length; c += 2) order.push(c);
    order.sort((a, b) => row[a] - row[b] || a - b);
    let w = 0,
      c = 0;
    for (let i = 0; i < width; i++) {
      while (c < order.length && row[order[c]] < i) w += row[order[c++] + 1];
      winding[j * width + i] = w;
    }
  }
  // Edges with ink on both sides (overlapping contours, abutting parts) must not count: every piece is split into parts
  // of at most 1/4 px, and a part is kept only when the winding a 1/32 px step to one side of its middle is 0. The
  // winding there is counted over the pieces that span that pixel row only.
  const bands: number[][] = Array.from({ length: height + 2 }, () => []);
  for (let k = 0; k < segments.length; k += 4) {
    const ay = segments[k + 1],
      by = segments[k + 3];
    for (let j = Math.max(-1, Math.floor(ay < by ? ay : by)); j <= Math.min(height, Math.floor(ay < by ? by : ay)); j++)
      bands[j + 1].push(k);
  }
  const windingNear = (x: number, y: number): number => {
    const j = Math.floor(y);
    if (j < -1 || j > height) return 0;
    let w = 0;
    for (const k of bands[j + 1]) {
      const ay = segments[k + 1],
        by = segments[k + 3];
      if (ay <= y ? by > y : by <= y) {
        const ax = segments[k],
          cx = ax + ((y - ay) * (segments[k + 2] - ax)) / (by - ay);
        if (cx > x) w += by > ay ? 1 : -1;
      }
    }
    return w;
  };
  const kept: number[] = [];
  let overlapped = false;
  for (let k = 0; k < segments.length; k += 4) {
    const ax = segments[k],
      ay = segments[k + 1],
      bx = segments[k + 2],
      by = segments[k + 3],
      dx = bx - ax,
      dy = by - ay,
      length = Math.sqrt(dx * dx + dy * dy),
      n = Math.max(1, Math.ceil(length * 4)),
      nx = -dy / length / 32,
      ny = dx / length / 32,
      start = kept.length;
    let whole = true;
    for (let p = 0; p < n; p++) {
      const sx = ax + (dx * p) / n,
        sy = ay + (dy * p) / n,
        ex = p + 1 === n ? bx : ax + (dx * (p + 1)) / n,
        ey = p + 1 === n ? by : ay + (dy * (p + 1)) / n,
        mx = (sx + ex) / 2,
        my = (sy + ey) / 2;
      if (windingNear(mx + nx, my + ny) === 0 || windingNear(mx - nx, my - ny) === 0) kept.push(sx, sy, ex, ey);
      else whole = false;
    }
    // A piece kept whole stays one piece, so outlines without inner edges give the same field either way.
    if (whole) {
      kept.length = start;
      kept.push(ax, ay, bx, by);
    } else overlapped = true;
  }
  const distanceSegments = overlapped ? Float64Array.from(kept) : segments;
  // Exact distance to the nearest piece, each piece only over its box grown by the reach of the byte range.
  const reach = Math.ceil(radius * (1 - cutoff > cutoff ? 1 - cutoff : cutoff)) + 1,
    best = new Float64Array(count).fill(Infinity);
  let evaluations = 0;
  for (let k = 0; k < distanceSegments.length; k += 4) {
    const ax = distanceSegments[k],
      ay = distanceSegments[k + 1],
      dx = distanceSegments[k + 2] - ax,
      dy = distanceSegments[k + 3] - ay,
      inverse = 1 / (dx * dx + dy * dy);
    const i0 = Math.max(0, Math.floor((dx < 0 ? ax + dx : ax) - reach)),
      i1 = Math.min(width - 1, Math.ceil((dx < 0 ? ax : ax + dx) + reach)),
      j0 = Math.max(0, Math.floor((dy < 0 ? ay + dy : ay) - reach)),
      j1 = Math.min(height - 1, Math.ceil((dy < 0 ? ay : ay + dy) + reach));
    for (let j = j0; j <= j1; j++) {
      const qy = j - ay,
        base = j * width;
      for (let i = i0; i <= i1; i++) {
        const qx = i - ax;
        let t = (qx * dx + qy * dy) * inverse;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = qx - t * dx,
          ey = qy - t * dy,
          d = ex * ex + ey * ey;
        if (d < best[base + i]) best[base + i] = d;
      }
      evaluations += i1 - i0 + 1;
    }
  }
  const data = new Uint8Array(count);
  for (let k = 0; k < count; k++) {
    const inside = winding[k] !== 0,
      squared = best[k];
    let byte: number;
    if (squared === Infinity) byte = inside ? 255 : 0;
    else {
      const d = inside ? -Math.sqrt(squared) : Math.sqrt(squared);
      byte = Math.round(255 - 255 * (d / radius + cutoff));
    }
    data[k] = byte < 0 ? 0 : byte > 255 ? 255 : byte;
  }
  return { width, height, left, top, data, evaluations, overlapped };
}
