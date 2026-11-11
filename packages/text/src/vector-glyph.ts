/**
 * CPU half of `@margoengine/text/vector`: turns glyph outlines into quadratic curves, splits them into
 * horizontal and vertical bands and packs them for the fragment shader, and evaluates the shader's coverage
 * in double precision (the same classification, roots and filter) for tests and CPU hit tests.
 *
 * Method: Lengyel, "GPU-Centered Font Rendering Directly from Glyph Outlines", JCGT 6(2), 2017. The winding
 * number along a ray is the signed count of the curve's crossings; which of a quadratic's two roots cross is
 * read from the signs of its three control points, so no root is ever tested against [0, 1]. Clean-room record
 * and the root classification derivation: packages/text/README.md, "Vector text".
 */

/** One quadratic Bezier curve in em units: x1, y1, x2, y2 (control), x3, y3. */
export type Quadratic = readonly [number, number, number, number, number, number];

/** Packed band data of one glyph inside a {@link VectorGlyphStore}. Empty glyphs (spaces) have `bands` 0. */
export interface VectorGlyph {
  /** Glyph id in the font. */
  readonly id: number;
  /** Index (in 16-byte rows) of the glyph's first band header in the store. */
  readonly base: number;
  /** Bands per axis; 0 for a glyph without ink. */
  readonly bands: number;
  /** Quadratic curves after splitting cubics. */
  readonly curves: number;
  /** Curve entries over all bands, both axes. */
  readonly entries: number;
  /** Largest band, in curves. */
  readonly maxBand: number;
  /** Quantization box in em: min x, min y, max x, max y (the curves' control-point hull). */
  readonly box: readonly [number, number, number, number];
  /** 1 when the outer contours run counter-clockwise (CFF), -1 when clockwise (TrueType). */
  readonly orientation: 1 | -1;
}

/** Maximum distance in em between a cubic and the quadratics that replace it. 0.1 px at 400 px per em. */
export const CUBIC_TOLERANCE = 1 / 4096;
/** Most bands per axis. */
export const MAX_BANDS = 32;
/** Target most curves in one band; a glyph gets more bands (up to {@link MAX_BANDS}) to stay under it. */
export const BAND_TARGET = 64;
const Q = 65535;
const SQRT3_36 = Math.sqrt(3) / 36;

/**
 * Converts outline segments (lines, quadratics, cubics as `FontOutlines.getGlyphSegments` returns them) to
 * quadratics. A line becomes a quadratic whose control point repeats its start (exactly representable after
 * quantization). A cubic is split at equal parameter steps into n pieces and each piece replaced by the
 * quadratic with control (3(c1 + c2) - p0 - p3) / 4, whose distance from the piece is at most
 * sqrt(3) / 36 |p3 - 3 c2 + 3 c1 - p0| (the difference is d3 t (t - 1/2) (t - 1)); splitting divides d3 by n^3.
 */
export function toQuadratics(contours: readonly (readonly (readonly number[])[])[], tolerance = CUBIC_TOLERANCE): Quadratic[] {
  const out: Quadratic[] = [];
  for (const loop of contours)
    for (const s of loop) {
      if (s.length === 4) {
        if (s[0] !== s[2] || s[1] !== s[3]) out.push([s[0], s[1], s[0], s[1], s[2], s[3]]);
      } else if (s.length === 6) out.push([s[0], s[1], s[2], s[3], s[4], s[5]]);
      else if (s.length === 8) {
        const [x0, y0, x1, y1, x2, y2, x3, y3] = s;
        const dx = x3 - 3 * x2 + 3 * x1 - x0,
          dy = y3 - 3 * y2 + 3 * y1 - y0;
        const n = Math.max(1, Math.min(64, Math.ceil(Math.cbrt((SQRT3_36 * Math.hypot(dx, dy)) / tolerance))));
        const at = (t: number): [number, number] => {
          const u = 1 - t;
          return [
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          ];
        };
        // Derivative of the cubic, for the piece's inner control points (c = p +- h/3 B').
        const tangent = (t: number): [number, number] => {
          const u = 1 - t;
          return [
            3 * (u * u * (x1 - x0) + 2 * u * t * (x2 - x1) + t * t * (x3 - x2)),
            3 * (u * u * (y1 - y0) + 2 * u * t * (y2 - y1) + t * t * (y3 - y2)),
          ];
        };
        let start = [x0, y0] as [number, number];
        for (let i = 1; i <= n; i++) {
          const t0 = (i - 1) / n,
            t1 = i / n,
            h = 1 / n,
            end = i === n ? ([x3, y3] as [number, number]) : at(t1),
            d0 = tangent(t0),
            d1 = tangent(t1);
          const c1x = start[0] + (h / 3) * d0[0],
            c1y = start[1] + (h / 3) * d0[1],
            c2x = end[0] - (h / 3) * d1[0],
            c2y = end[1] - (h / 3) * d1[1];
          out.push([start[0], start[1], (3 * (c1x + c2x) - start[0] - end[0]) / 4, (3 * (c1y + c2y) - start[1] - end[1]) / 4, end[0], end[1]]);
          start = end;
        }
      } else throw new RangeError('Outline segments have 4, 6 or 8 coordinates');
    }
  return out;
}

/**
 * Growable store of packed glyph bands: rows of four u32. A glyph is `bands` header rows (horizontal band start
 * and count, vertical band start and count, as absolute row indices) followed by its curve rows. A curve row holds
 * its three control points as 16-bit fractions of the glyph's box: x | y << 16 for each point, fourth word 0.
 * Horizontal band lists are sorted by largest x first, vertical ones by largest y first, so a ray in +x (+y)
 * can stop at the first curve wholly behind the pixel.
 */
export class VectorGlyphStore {
  /** Packed rows; only the first `length` u32 are used. */
  data = new Uint32Array(4096);
  /** Used u32 count (a multiple of 4). */
  length = 0;
  /** Bumped whenever rows are appended. */
  revision = 0;

  private reserve(words: number): void {
    if (this.length + words <= this.data.length) return;
    let size = this.data.length;
    while (size < this.length + words) size *= 2;
    const next = new Uint32Array(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  /** Packs one glyph's curves and returns its record. */
  add(id: number, curves: readonly Quadratic[]): VectorGlyph {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      area = 0;
    for (const c of curves) {
      for (let i = 0; i < 6; i += 2) {
        minX = Math.min(minX, c[i]);
        maxX = Math.max(maxX, c[i]);
        minY = Math.min(minY, c[i + 1]);
        maxY = Math.max(maxY, c[i + 1]);
      }
      // Signed area of the closed boundary, (1/2) integral of x dy - y dx, in closed form per quadratic.
      const [x1, y1, x2, y2, x3, y3] = c;
      area += (2 * (x1 * y2 - y1 * x2) + 2 * (x2 * y3 - y2 * x3) + (x1 * y3 - y1 * x3)) / 6;
    }
    const base = this.length / 4;
    if (!curves.length || !(maxX > minX) || !(maxY > minY))
      return { id, base, bands: 0, curves: 0, entries: 0, maxBand: 0, box: [0, 0, 0, 0], orientation: 1 };
    const box = [minX, minY, maxX, maxY] as const,
      sx = (maxX - minX) / Q,
      sy = (maxY - minY) / Q;
    // Quantize, then work on what the shader will see.
    const packed = curves.map((c) => {
      const q = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 6; i += 2) {
        q[i] = Math.min(Q, Math.max(0, Math.round((c[i] - minX) / sx)));
        q[i + 1] = Math.min(Q, Math.max(0, Math.round((c[i + 1] - minY) / sy)));
      }
      return q;
    });
    const range = (q: number[], axis: 0 | 1): [number, number] => {
      // Exact extent of the quadratic along an axis: endpoints plus the interior extremum.
      const a = q[axis],
        b = q[axis + 2],
        c = q[axis + 4];
      let lo = Math.min(a, c),
        hi = Math.max(a, c);
      const den = a - 2 * b + c;
      if (den !== 0) {
        const t = (a - b) / den;
        if (t > 0 && t < 1) {
          const v = (1 - t) * (1 - t) * a + 2 * t * (1 - t) * b + t * t * c;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      return [lo, hi];
    };
    const spans = packed.map((q) => [range(q, 1), range(q, 0)] as const);
    const build = (bands: number) => {
      const lists: number[][][] = [[], []];
      for (let axis = 0; axis < 2; axis++) {
        // axis 0: horizontal bands (split along y) hold curves that cross a horizontal ray, sorted by max x.
        for (let b = 0; b < bands; b++) lists[axis].push([]);
        packed.forEach((q, i) => {
          const [lo, hi] = spans[i][axis];
          // A curve flat along the band axis is never crossed by that axis's ray.
          if (lo === hi) return;
          const first = Math.max(0, Math.floor((lo / Q) * bands - 1e-4)),
            last = Math.min(bands - 1, Math.floor((hi / Q) * bands + 1e-4));
          for (let b = first; b <= last; b++) lists[axis][b].push(i);
        });
        const along = axis === 0 ? 0 : 1;
        for (const list of lists[axis])
          list.sort((i, j) => Math.max(packed[j][along], packed[j][along + 2], packed[j][along + 4]) - Math.max(packed[i][along], packed[i][along + 2], packed[i][along + 4]));
      }
      return lists;
    };
    let bands = Math.min(MAX_BANDS, Math.max(1, Math.ceil(curves.length / 4))),
      lists = build(bands);
    const largest = (l: number[][][]) => Math.max(...l[0].map((x) => x.length), ...l[1].map((x) => x.length));
    while (largest(lists) > BAND_TARGET && bands < MAX_BANDS) {
      bands = Math.min(MAX_BANDS, bands * 2);
      lists = build(bands);
    }
    let entries = 0;
    for (const axis of lists) for (const list of axis) entries += list.length;
    this.reserve((bands + entries) * 4);
    const data = this.data;
    let row = base + bands;
    const starts: number[][] = [[], []];
    for (let axis = 0; axis < 2; axis++)
      for (const list of lists[axis]) {
        starts[axis].push(row);
        for (const i of list) {
          const q = packed[i],
            o = row * 4;
          data[o] = (q[0] | (q[1] << 16)) >>> 0;
          data[o + 1] = (q[2] | (q[3] << 16)) >>> 0;
          data[o + 2] = (q[4] | (q[5] << 16)) >>> 0;
          data[o + 3] = 0;
          row++;
        }
      }
    for (let b = 0; b < bands; b++) {
      const o = (base + b) * 4;
      data[o] = starts[0][b];
      data[o + 1] = lists[0][b].length;
      data[o + 2] = starts[1][b];
      data[o + 3] = lists[1][b].length;
    }
    this.length = row * 4;
    this.revision++;
    return {
      id,
      base,
      bands,
      curves: curves.length,
      entries,
      maxBand: largest(lists),
      box,
      orientation: area >= 0 ? 1 : -1,
    };
  }
}

/** Options of {@link vectorCoverage}, the CPU mirror of the shader. */
export interface VectorCoverageOptions {
  /** Outline growth in pixels (positive) or shrink (negative). Default 0. */
  dilation?: number;
  /** Box filter width in pixels. Default 1. */
  filter?: number;
  /**
   * Rays per axis, an odd count spread evenly across the pixel: 1 through its centre, 3 at -1/3, 0 and 1/3 of a
   * pixel, 5 at fifths; 'auto' (default) is 5 under {@link SMALL_PPEM} pixels per em and 3 from there up. The
   * off-centre rays are cast only where a curve's control hull reaches the pixel square or a band does not cover
   * it; elsewhere the pixel is wholly in or out.
   */
  rays?: number | 'auto';
  /** Collects work counts: curve rows read. */
  work?: { curves: number };
}

/** Root classification by the signs of the three control points (bit 0: root t1 crosses, bit 1: root t2). */
export const ROOT_CODES = 0x2e74;
/** Rays per axis from this many pixels per em up, under 'auto'; 5 below it. */
export const DEFAULT_RAYS = 3;
/** Pixels per em under which 'auto' casts 5 rays per axis. */
export const SMALL_PPEM = 7.5;
/** Crossings inside one pixel's filter window that a ray resolves exactly; more fall back to the summed ramps. */
export const WINDOW_SLOTS = 4;

/**
 * Coverage (0..1) of a glyph at an em-space point for a pixel `ppeX` x `ppeY` pixels per em, computed exactly
 * as the vector shader does (in double precision). Along a +x ray through the horizontal band and a +y ray through
 * the vertical band, every crossing is found from the root classification; crossings inside the pixel's filter
 * window are kept sorted (up to {@link WINDOW_SLOTS}) so the nonzero rule is applied to each piece of the window,
 * which stays exact where contours overlap. The two axes are blended by how near their nearest crossing is.
 */
export function vectorCoverage(
  store: VectorGlyphStore,
  glyph: VectorGlyph,
  x: number,
  y: number,
  ppeX: number,
  ppeY = ppeX,
  options: VectorCoverageOptions = {},
): number {
  if (!glyph.bands) return 0;
  const [x0, y0, x1, y1] = glyph.box,
    sx = (x1 - x0) / Q,
    sy = (y1 - y0) / Q,
    n = glyph.bands,
    data = store.data,
    fw = options.filter ?? 1,
    hw = 0.5 * fw,
    dil = (options.dilation ?? 0) * glyph.orientation,
    stop = -hw - Math.abs(dil),
    choice = options.rays ?? 'auto',
    rays = choice === 'auto' ? (Math.min(ppeX, ppeY) < SMALL_PPEM ? 5 : DEFAULT_RAYS) : choice;
  if (!Number.isInteger(rays) || rays < 1 || rays > 7 || rays % 2 === 0) throw new RangeError("rays must be 'auto', 1, 3, 5 or 7");
  // Pixel square half-size in em on each axis (with dilation), for the band-cover and hull-touch tests.
  const rx = (1.001 * (hw + Math.abs(dil))) / ppeX,
    ry = (1.001 * (hw + Math.abs(dil))) / ppeY,
    R = 1.001 * (hw + Math.abs(dil));
  const ray = (px: number, py: number, axis: 0 | 1): [number, number, boolean] => {
    const t = axis === 0 ? (py - y0) / (y1 - y0) : (px - x0) / (x1 - x0),
      band = Math.min(n - 1, Math.max(0, Math.floor(t * n))),
      header = (glyph.base + band) * 4,
      start = data[header + 2 * axis],
      count = data[header + 2 * axis + 1];
    // Exact unless a curve's hull reaches the pixel square or the band does not cover the square's span.
    const lo = axis === 0 ? Math.max(py - ry, y0) : Math.max(px - rx, x0),
      hi = axis === 0 ? Math.min(py + ry, y1) : Math.min(px + rx, x1),
      edge = axis === 0 ? y1 - y0 : x1 - x0,
      base = axis === 0 ? y0 : x0;
    let touched = lo < base + (band / n) * edge || hi > base + ((band + 1) / n) * edge,
      linear = 0,
      far = 0,
      inside = 0,
      near = Infinity;
    const ds = [hw, hw, hw, hw],
      ss = [0, 0, 0, 0];
    const cross = (raw: number, d: number, s: number) => {
      near = Math.min(near, Math.abs(raw));
      linear += s * Math.min(1, Math.max(0, d / fw + 0.5));
      if (d >= hw) far += s;
      else if (d > -hw) {
        inside++;
        let cd = d,
          cs = s;
        for (let j = 0; j < WINDOW_SLOTS; j++)
          if (cd < ds[j]) {
            const td = ds[j],
              ts = ss[j];
            ds[j] = cd;
            ss[j] = cs;
            cd = td;
            cs = ts;
          }
      }
    };
    const sign = axis === 0 ? 1 : -1;
    for (let r = start; r < start + count; r++) {
      if (options.work) options.work.curves++;
      const o = r * 4,
        p: number[] = [];
      for (let k = 0; k < 3; k++) {
        const w = data[o + k];
        p.push((x0 + (w & 0xffff) * sx - px) * ppeX, (y0 + (w >>> 16) * sy - py) * ppeY);
      }
      // Along: the ray's axis; across: the axis whose signs classify the roots.
      const a1 = p[axis],
        a2 = p[axis + 2],
        a3 = p[axis + 4],
        c1 = p[1 - axis],
        c2 = p[3 - axis],
        c3 = p[5 - axis];
      if (Math.max(a1, a2, a3) < stop) break;
      if (Math.min(a1, a2, a3) <= R && Math.max(c1, c2, c3) >= -R && Math.min(c1, c2, c3) <= R) touched = true;
      const code = (ROOT_CODES >> ((c1 > 0 ? 2 : 0) + (c2 > 0 ? 4 : 0) + (c3 > 0 ? 8 : 0))) & 3;
      if (!code) continue;
      const a = c1 - 2 * c2 + c3,
        b = c1 - c2,
        s = Math.sqrt(Math.max(b * b - a * c1, 0)),
        q = b >= 0 ? b + s : b - s,
        safeA = a === 0 ? 1 : a,
        safeQ = q === 0 ? 1 : q,
        t1 = b >= 0 ? c1 / safeQ : q / safeA,
        t2 = b >= 0 ? q / safeA : c1 / safeQ;
      const ax = a1 - 2 * a2 + a3,
        bx = a1 - a2;
      // t1: the across coordinate falls through zero there (winding +1 left of it); t2: it rises (-1).
      if (code & 1) {
        const d = (ax * t1 - 2 * bx) * t1 + a1;
        cross(d, d - sign * dil, 1);
      }
      if (code & 2) {
        const d = (ax * t2 - 2 * bx) * t2 + a1;
        cross(d, d + sign * dil, -1);
      }
    }
    if (inside > WINDOW_SLOTS) return [Math.min(1, Math.abs(linear)), near, touched];
    // Walk the window right to left: winding is `far` at its right end and steps by each crossing's sign.
    let w = far,
      right = hw,
      covered = 0;
    for (let j = WINDOW_SLOTS - 1; j >= 0; j--) {
      covered += (right - ds[j]) * Math.min(1, Math.abs(w));
      w += ss[j];
      right = ds[j];
    }
    covered += (right + hw) * Math.min(1, Math.abs(w));
    return [covered / fw, near, touched];
  };
  const reach = hw + Math.abs(dil),
    centreH = ray(x, y, 0),
    centreV = ray(x, y, 1);
  let ch = centreH[0],
    cv = centreV[0],
    nh = centreH[1],
    nv = centreV[1];
  if (rays > 1 && (centreH[2] || centreV[2])) {
    for (let k = 0; k < rays; k++) {
      const offset = (k - (rays - 1) / 2) / rays;
      if (!offset) continue;
      const h = ray(x, y + offset / ppeY, 0),
        v = ray(x + offset / ppeX, y, 1);
      ch += h[0];
      cv += v[0];
      nh = Math.min(nh, h[1]);
      nv = Math.min(nv, v[1]);
    }
    ch /= rays;
    cv /= rays;
  }
  const wh = Math.min(1, Math.max(0, 1 - nh / reach)),
    wv = Math.min(1, Math.max(0, 1 - nv / reach));
  return wh + wv > 1e-5 ? (wh * ch + wv * cv) / (wh + wv) : 0.5 * (ch + cv);
}
