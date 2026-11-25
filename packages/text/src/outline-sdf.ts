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

/**
 * Version of the field bytes {@link outlineSdf} and `outlineMsdf` write; part of every glyph cache key. 2: glyph caches
 * carry the multi-channel field and its kind.
 */
export const OUTLINE_SDF_VERSION = 2;

/** Largest number of pieces one curve is flattened into. */
const MAX_PIECES = 1024;

/** Number of uniform pieces that keep a curve with second difference length `second` within `tolerance`. */
function pieces(second: number, factor: number, tolerance: number): number {
  // A uniform split into n keeps every chord within factor * |second| / n^2 of the curve.
  const n = Math.ceil(Math.sqrt((factor * second) / tolerance));
  return n < 1 ? 1 : n > MAX_PIECES ? MAX_PIECES : n;
}

/** Flattened outline pieces with the outline edge (line or curve) each came from. @internal */
export interface FlatEdges {
  /** [ax, ay, bx, by] per piece, in pixels, y up. */
  pieces: Float64Array;
  /** Edge index of each piece. */
  edgeOf: Int32Array;
  /** Per edge: start tangent (x, y) and end tangent (x, y), in pixels, y up, not normalised. */
  tangents: Float64Array;
  /** First edge index of each contour, then the edge count. */
  contourStarts: Int32Array;
}

/** The first of `candidates` (pairs of numbers) that is not the zero vector, or [0, 0]. */
function direction(...candidates: number[]): [number, number] {
  for (let k = 0; k < candidates.length; k += 2)
    if (candidates[k] !== 0 || candidates[k + 1] !== 0) return [candidates[k], candidates[k + 1]];
  return [0, 0];
}

/**
 * Flattens outline contours (em units, y up; lines [x0,y0,x1,y1], quadratics of 6 and cubics of 8 numbers) to closed
 * pieces in pixels, recording each piece's edge and each edge's end tangents. Edges that flatten to nothing (a zero
 * length line, such as the closing line of a contour that is already closed) get no index. @internal
 */
export function flattenEdges(
  contours: readonly (readonly (readonly number[])[])[],
  size: number,
  tolerance: number,
): FlatEdges {
  const out: number[] = [],
    edgeOf: number[] = [],
    tangents: number[] = [],
    starts: number[] = [];
  let edge = 0;
  const push = (ax: number, ay: number, bx: number, by: number) => {
    if (ax !== bx || ay !== by) {
      out.push(ax, ay, bx, by);
      edgeOf.push(edge);
    }
  };
  /** Closes the edge being flattened: it gets an index only when some piece came from it. */
  const close = (before: number, start: [number, number], end: [number, number]) => {
    if (edgeOf.length === before) return;
    tangents.push(start[0], start[1], end[0], end[1]);
    edge++;
  };
  for (const loop of contours) {
    if (!loop.length) continue;
    starts.push(edge);
    const first = loop[0],
      sx = first[0] * size,
      sy = first[1] * size;
    let px = sx,
      py = sy;
    for (const s of loop) {
      const x0 = px,
        y0 = py,
        before = edgeOf.length;
      if (s.length === 4) {
        const x1 = s[2] * size,
          y1 = s[3] * size;
        push(x0, y0, x1, y1);
        close(before, [x1 - x0, y1 - y0], [x1 - x0, y1 - y0]);
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
        close(before, direction(x1 - x0, y1 - y0, x2 - x0, y2 - y0), direction(x2 - x1, y2 - y1, x2 - x0, y2 - y0));
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
        close(
          before,
          direction(x1 - x0, y1 - y0, x2 - x0, y2 - y0, x3 - x0, y3 - y0),
          direction(x3 - x2, y3 - y2, x3 - x1, y3 - y1, x3 - x0, y3 - y0),
        );
        px = x3;
        py = y3;
      }
    }
    const before = edgeOf.length;
    push(px, py, sx, sy);
    close(before, [sx - px, sy - py], [sx - px, sy - py]);
  }
  starts.push(edge);
  return {
    pieces: Float64Array.from(out),
    edgeOf: Int32Array.from(edgeOf),
    tangents: Float64Array.from(tangents),
    contourStarts: Int32Array.from(starts),
  };
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
  return flattenEdges(contours, size, tolerance).pieces;
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
 * The shared part of every outline field: the bitmap box, the pieces in texel space, the winding number at each texel
 * centre and the pieces with ink on one side only. @internal
 */
export interface FieldSetup {
  width: number;
  height: number;
  left: number;
  top: number;
  /** Every piece in texel space (texel (i, j) has its centre at (i, j), rows downward). */
  segments: Float64Array;
  /** Index of each piece of `segments` in the flattened pieces. */
  segmentPiece: Int32Array;
  /** Winding number at each texel centre. */
  winding: Int32Array;
  /** The pieces (or parts of pieces) with ink on one side only, in texel space. */
  kept: Float64Array;
  /** Index into `segments` of each kept part. */
  keptSegment: Int32Array;
  /** Per kept part: 0 for the whole piece or its first part, 1 for a middle part, 2 for the last, 3 for a lone part. */
  keptPlace: Uint8Array;
  /** Per kept part: +1 when the ink is to its left (positive cross product of its direction and the point), else -1. */
  keptInk: Int8Array;
  overlapped: boolean;
  flat: FlatEdges;
}

/** Box, texel-space pieces, winding and one-sided pieces of an outline. Null when the outline is empty. @internal */
export function fieldSetup(
  contours: readonly (readonly (readonly number[])[])[],
  options: OutlineSdfOptions,
): FieldSetup | null {
  const { size, radius, buffer } = options;
  // A quarter of a byte step, at most 1/64 px.
  const tolerance = Math.min(1 / 64, radius / 1020);
  const flatEdges = flattenEdges(contours, size, tolerance),
    flat = flatEdges.pieces;
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
  const moved: number[] = [],
    movedPiece: number[] = [];
  for (let k = 0; k < flat.length; k += 4) {
    const ax = flat[k] - left - 0.5,
      ay = top - 0.5 - flat[k + 1],
      bx = flat[k + 2] - left - 0.5,
      by = top - 0.5 - flat[k + 3];
    if (ax !== bx || ay !== by) {
      moved.push(ax, ay, bx, by);
      movedPiece.push(k >> 2);
    }
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
  const kept: number[] = [],
    keptSegment: number[] = [],
    keptPlace: number[] = [],
    keptInk: number[] = [];
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
      start = kept.length,
      startMeta = keptSegment.length;
    let whole = true,
      firstInk = 0;
    for (let p = 0; p < n; p++) {
      const sx = ax + (dx * p) / n,
        sy = ay + (dy * p) / n,
        ex = p + 1 === n ? bx : ax + (dx * (p + 1)) / n,
        ey = p + 1 === n ? by : ay + (dy * (p + 1)) / n,
        mx = (sx + ex) / 2,
        my = (sy + ey) / 2,
        // (nx, ny) points to the left of the piece: ink is on the left when the winding to the right is 0.
        outLeft = windingNear(mx + nx, my + ny) === 0,
        outRight = windingNear(mx - nx, my - ny) === 0;
      if (outLeft || outRight) {
        const ink = outRight && !outLeft ? 1 : -1;
        if (!firstInk) firstInk = ink;
        kept.push(sx, sy, ex, ey);
        keptSegment.push(k >> 2);
        keptPlace.push(n === 1 ? 3 : p === 0 ? 0 : p + 1 === n ? 2 : 1);
        keptInk.push(ink);
      } else whole = false;
    }
    // A piece kept whole stays one piece, so outlines without inner edges give the same field either way.
    if (whole) {
      kept.length = start;
      keptSegment.length = keptPlace.length = keptInk.length = startMeta;
      kept.push(ax, ay, bx, by);
      keptSegment.push(k >> 2);
      keptPlace.push(3);
      keptInk.push(firstInk || -1);
    } else overlapped = true;
  }
  return {
    width,
    height,
    left,
    top,
    segments,
    segmentPiece: Int32Array.from(movedPiece),
    winding,
    kept: Float64Array.from(kept),
    keptSegment: Int32Array.from(keptSegment),
    keptPlace: Uint8Array.from(keptPlace),
    keptInk: Int8Array.from(keptInk),
    overlapped,
    flat: flatEdges,
  };
}

/** The distance pass of {@link outlineSdf}: squared distance to the nearest kept part per texel. @internal */
export function nearestSquared(
  setup: FieldSetup,
  options: OutlineSdfOptions,
): { best: Float64Array; evaluations: number } {
  const { radius, cutoff } = options,
    { width, height, kept } = setup;
  // Exact distance to the nearest piece, each piece only over its box grown by the reach of the byte range.
  const reach = Math.ceil(radius * (1 - cutoff > cutoff ? 1 - cutoff : cutoff)) + 1,
    best = new Float64Array(width * height).fill(Infinity);
  let evaluations = 0;
  for (let k = 0; k < kept.length; k += 4) {
    const ax = kept[k],
      ay = kept[k + 1],
      dx = kept[k + 2] - ax,
      dy = kept[k + 3] - ay,
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
  return { best, evaluations };
}

/** One field byte: round(255 - 255 * (d / radius + cutoff)) clamped, d in pixels, negative inside. @internal */
export function fieldByte(d: number, radius: number, cutoff: number): number {
  const byte = Math.round(255 - 255 * (d / radius + cutoff));
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}

/** The SDF bytes of a setup from its squared nearest distances. @internal */
export function sdfBytes(setup: FieldSetup, best: Float64Array, radius: number, cutoff: number): Uint8Array {
  const count = setup.width * setup.height,
    data = new Uint8Array(count);
  for (let k = 0; k < count; k++) {
    const inside = setup.winding[k] !== 0,
      squared = best[k];
    if (squared === Infinity) data[k] = inside ? 255 : 0;
    else data[k] = fieldByte(inside ? -Math.sqrt(squared) : Math.sqrt(squared), radius, cutoff);
  }
  return data;
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
  const setup = fieldSetup(contours, options);
  if (!setup) return null;
  const { best, evaluations } = nearestSquared(setup, options);
  const { width, height, left, top, overlapped } = setup;
  return {
    width,
    height,
    left,
    top,
    data: sdfBytes(setup, best, options.radius, options.cutoff),
    evaluations,
    overlapped,
  };
}
