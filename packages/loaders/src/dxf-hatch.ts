// DXF HATCH entities for parseDXF, written from Autodesk's published DXF reference (HATCH group codes: boundary
// paths, pattern definition lines, hatch style, gradient colours): solid hatches become triangles, pattern hatches
// become dashed line segments. Optional: `parseDXF(bytes, { hatch: readDXFHatch })`.
//
// Boundary angles: an edge flagged clockwise (code 73 = 0) stores its angles mirrored, so it runs from -start to -end
// (Autodesk's table names the codes only). Elliptic edge angles are angles from the major axis,
// not curve parameters. Pattern lines are stored with the hatch's angle and scale already applied.
//
// Fill: rings are nested by containment, and hatch style 0 fills by the even-odd rule, 1 the outermost ring down to
// its islands, 2 the outermost ring whole. Pattern lines are clipped by parity (J. Foley, A. van Dam, S. Feiner and
// J. Hughes, "Computer Graphics: Principles and Practice", 2nd ed., 1990, section 3.6, scan conversion of polygons),
// with the half-open vertex rule, so a line through a vertex is counted once.
import { triangulateShape } from '@margoengine/geometry/triangulate';
import type { DXFColor, DXFHatchReader } from './dxf.js';
import { LoaderError } from './types.js';

const F = 'DXF';
/** Most boundary rings of one hatch: their nesting is found pair by pair. */
const MAX_RINGS = 10_000;

type Point = [number, number];
interface Ring {
  points: Point[];
  area: number;
  min: Point;
  max: Point;
  parent: number;
  depth: number;
}
interface PatternLine {
  angle: number;
  base: Point;
  offset: Point;
  dashes: number[];
}

const over = (what: string, limit: number) =>
  new LoaderError(F, 'limit', `HATCH ${what} exceeds the limit of ${limit}`);

/** The sweep in degrees from `start` to `end`, counterclockwise, in (0, 360]. */
function turn(start: number, end: number): number {
  const d = end - start;
  if (Math.abs(d) >= 360 - 1e-6) return 360;
  const s = ((d % 360) + 360) % 360;
  return s || 360;
}

function ring(points: Point[]): Ring | undefined {
  const out: Point[] = [];
  let reach = 0;
  for (const p of points) reach = Math.max(reach, Math.abs(p[0]), Math.abs(p[1]));
  const eps = reach * 1e-12;
  const same = (a: Point, b: Point) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
  for (const p of points) if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  while (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  if (out.length < 3) return undefined;
  const min: Point = [...out[0]],
    max: Point = [...out[0]];
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i],
      b = out[(i + 1) % out.length];
    // About the first point, so rings far from the origin keep their precision.
    area += (a[0] - out[0][0]) * (b[1] - out[0][1]) - (b[0] - out[0][0]) * (a[1] - out[0][1]);
    for (const k of [0, 1] as const) {
      min[k] = Math.min(min[k], a[k]);
      max[k] = Math.max(max[k], a[k]);
    }
  }
  return { points: out, area: Math.abs(area) / 2, min, max, parent: -1, depth: 0 };
}

/** Whether `p` is inside the ring (even-odd), or `undefined` when it lies on the ring. */
function inside(p: Point, r: Ring): boolean | undefined {
  const eps = Math.max(r.max[0] - r.min[0], r.max[1] - r.min[1]) * 1e-9;
  let odd = false;
  for (let i = 0; i < r.points.length; i++) {
    const a = r.points[i],
      b = r.points[(i + 1) % r.points.length],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      l = dx * dx + dy * dy,
      t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= eps) return undefined;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + (dx * (p[1] - a[1])) / dy) odd = !odd;
  }
  return odd;
}

/** Whether ring `b` lies in ring `a`: judged at the first of b's edge midpoints that is not on a. */
function contains(a: Ring, b: Ring): boolean {
  if (b.min[0] < a.min[0] || b.min[1] < a.min[1] || b.max[0] > a.max[0] || b.max[1] > a.max[1]) return false;
  for (let i = 0; i < b.points.length; i++) {
    const p = b.points[i],
      q = b.points[(i + 1) % b.points.length],
      at = inside([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], a);
    if (at !== undefined) return at;
  }
  return true;
}

/** Rings from the largest, each knowing the smallest ring around it. */
function nest(rings: Ring[]): Ring[] {
  const sorted = [...rings].sort((a, b) => b.area - a.area);
  for (let i = 1; i < sorted.length; i++)
    for (let j = i - 1; j >= 0; j--)
      if (contains(sorted[j], sorted[i])) {
        sorted[i].parent = j;
        sorted[i].depth = sorted[j].depth + 1;
        break;
      }
  return sorted;
}

/**
 * Reads one HATCH entity for {@link parseDXF}: pass it as `{ hatch: readDXFHatch }`. A solid hatch becomes triangles
 * (a gradient hatch takes its first gradient colour), a pattern hatch its dashed line family, a dot being a segment of
 * no length (round caps draw it). Returns `undefined` for a hatch without a readable boundary or pattern, which
 * parseDXF counts in `skipped`.
 */
export const readDXFHatch: DXFHatchReader = (input) => {
  const { codes, values } = input;
  let at = codes.indexOf(91),
    bad = at < 0;
  if (bad) return undefined;
  const value = (i: number) => {
    const n = Number(values[i]);
    return Number.isFinite(n) ? n : 0;
  };
  /** The value of the next pair, which must have this code. */
  const need = (code: number) => {
    if (codes[at] !== code) {
      bad = true;
      return 0;
    }
    return value(at++);
  };
  const optional = (code: number, fallback = 0) => (codes[at] === code ? value(at++) : fallback);
  const pair = (x: number): Point => [need(x), need(x + 10)];
  const head = (code: number) => {
    const i = codes.indexOf(code);
    return i < 0 || i > codes.indexOf(91) ? 0 : value(i);
  };
  const elevation = head(30),
    solid = head(70) === 1,
    paths = need(91);
  if (paths > MAX_RINGS) throw over('boundary path count', MAX_RINGS);

  // --- boundary paths ---------------------------------------------------------------------------------------------
  const rings: Ring[] = [];
  let total = 0;
  const room = (points: Point[]) => {
    total += points.length;
    if (total > input.maxVertices) throw over('boundary point count', input.maxVertices);
  };
  const flat = (points: number[][]): Point[] => points.map((p) => [p[0], p[1]]);
  /** One edge of an edge path as points. */
  const edge = (): Point[] => {
    const type = need(72);
    if (type === 1) return [pair(10), pair(11)];
    if (type === 2) {
      const c = pair(10),
        r = need(40),
        a0 = need(50),
        a1 = need(51),
        ccw = need(73) !== 0,
        sign = ccw ? 1 : -1,
        rad = Math.PI / 180;
      return flat(input.arc(c[0], c[1], 0, r, sign * a0 * rad, sign * turn(a0, a1) * rad));
    }
    if (type === 3) {
      const c = pair(10),
        major = pair(11),
        ratio = need(40),
        a0 = need(50),
        a1 = need(51),
        sign = need(73) !== 0 ? 1 : -1,
        sweep = turn(a0, a1);
      if (!(ratio > 0)) {
        bad = true;
        return [];
      }
      const parameter = (degrees: number) => {
        const a = (degrees * Math.PI) / 180;
        return Math.atan2(Math.sin(a) / ratio, Math.cos(a));
      };
      const t0 = parameter(a0);
      let span = parameter(a0 + sweep) - t0;
      if (sweep === 360) span = 2 * Math.PI;
      else while (span <= 0) span += 2 * Math.PI;
      const count = Math.max(1, Math.ceil((input.arcSegments * span) / (2 * Math.PI))),
        out: Point[] = [];
      for (let k = 0; k <= count; k++) {
        const t = sign * (t0 + (span * k) / count),
          u = Math.cos(t),
          v = Math.sin(t) * ratio;
        out.push([c[0] + major[0] * u - major[1] * v, c[1] + major[1] * u + major[0] * v]);
      }
      return out;
    }
    if (type === 4) {
      const degree = need(94);
      need(73);
      need(74);
      const knotCount = need(95),
        controlCount = need(96),
        knots: number[] = [],
        control: number[][] = [],
        weights: number[] = [],
        fit: Point[] = [];
      for (let k = 0; k < knotCount && !bad; k++) knots.push(need(40));
      for (let k = 0; k < controlCount && !bad; k++) {
        const p = pair(10);
        control.push([p[0], p[1], 0]);
        if (codes[at] === 42) weights[k] = value(at++);
      }
      // Fit data (R2010 on) starts with code 97, as does the count of source objects after a path's last edge: only
      // the former is followed by a fit point, another 97 or the next edge.
      if (codes[at] === 97 && [11, 97, 72].includes(codes[at + 1])) {
        const count = need(97);
        for (let k = 0; k < count && !bad; k++) fit.push(pair(11));
        for (const tangent of [12, 13]) if (codes[at] === tangent) pair(tangent);
      }
      return control.length ? flat(input.spline(degree, knots, control, weights)) : fit;
    }
    bad = true;
    return [];
  };
  for (let p = 0; p < paths && !bad; p++) {
    const flags = need(92);
    let points: Point[] = [];
    if (flags & 2) {
      const bulges = need(72);
      need(73);
      const count = need(93),
        vertices: { x: number; y: number; bulge: number }[] = [];
      if (count > input.maxVertices) throw over('boundary point count', input.maxVertices);
      for (let k = 0; k < count && !bad; k++) {
        const [x, y] = pair(10);
        vertices.push({ x, y, bulge: bulges ? optional(42) : 0 });
      }
      // A boundary is closed whatever its flag says: a fill has no open side.
      points = flat(input.bulged(vertices, true, 0));
      room(points);
    } else {
      const count = need(93);
      for (let k = 0; k < count && !bad; k++) {
        const next = edge();
        room(next);
        for (const q of next) points.push(q);
      }
    }
    const sources = optional(97);
    for (let k = 0; k < sources && codes[at] === 330; k++) at++;
    const r = ring(points);
    if (r) rings.push(r);
  }
  if (bad || !rings.length) return undefined;

  // --- style, pattern lines and gradient --------------------------------------------------------------------------
  let style = 0,
    color: DXFColor | undefined,
    gradient = false;
  const pattern: PatternLine[] = [];
  while (at < codes.length && !bad) {
    const code = codes[at],
      v = value(at++);
    if (code === 75) style = v;
    else if (code === 450) gradient = v === 1;
    else if (code === 421 && gradient && !color)
      color = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
    else if (code === 78)
      for (let k = 0; k < v && !bad; k++) {
        const angle = (need(53) * Math.PI) / 180,
          base: Point = [need(43), need(44)],
          offset: Point = [need(45), need(46)],
          count = need(79),
          dashes: number[] = [];
        for (let d = 0; d < count && !bad; d++) dashes.push(need(49));
        pattern.push({ angle, base, offset, dashes });
      }
  }
  if (bad || (!solid && !pattern.length)) return undefined;

  const all = nest(rings),
    kept = all.map((r) => (style === 2 ? r.depth === 0 : style === 1 ? r.depth <= 1 : true));
  const triangles: number[] = [],
    segments: number[] = [];

  if (solid) {
    const holes: Point[][][] = all.map(() => []);
    all.forEach((r, i) => {
      if (kept[i] && r.depth % 2 === 1) holes[r.parent].push(r.points);
    });
    all.forEach((r, i) => {
      if (!kept[i] || r.depth % 2) return;
      const fill = triangulateShape(r.points, holes[i]),
        corners = fill.contour.concat(...fill.holes);
      if ((triangles.length / 2 + fill.indices.length) / 3 > input.maxTriangles)
        throw over('triangle count', input.maxTriangles);
      for (const index of fill.indices) triangles.push(corners[index][0], corners[index][1]);
    });
    return { triangles, segments, elevation, color };
  }

  // --- pattern ----------------------------------------------------------------------------------------------------
  const used = all.filter((_, i) => kept[i]);
  let crossings = 0;
  const most = input.maxSegments;
  for (const line of pattern) {
    const c = Math.cos(line.angle),
      s = Math.sin(line.angle),
      [bx, by] = line.base;
    // Line k runs along (c, s) at k * gap across it, its dashes starting k * shift along it.
    let gap = -s * line.offset[0] + c * line.offset[1],
      shift = c * line.offset[0] + s * line.offset[1];
    if (gap < 0) {
      gap = -gap;
      shift = -shift;
    }
    let period = 0;
    for (const d of line.dashes) period += Math.abs(d);
    // A family with no spacing, or with nothing but gaps, draws nothing.
    if (!(gap > 0) || (line.dashes.length && (!(period > 0) || line.dashes.every((d) => d < 0)))) continue;
    const cut = new Map<number, number[]>();
    for (const r of used) {
      const along: number[] = [],
        across: number[] = [],
        first: number[] = [];
      for (const [x, y] of r.points) {
        along.push(c * (x - bx) + s * (y - by));
        const v = -s * (x - bx) + c * (y - by);
        across.push(v);
        first.push(Math.ceil(v / gap));
      }
      for (let i = 0; i < r.points.length; i++) {
        const j = (i + 1) % r.points.length,
          low = Math.min(first[i], first[j]),
          high = Math.max(first[i], first[j]);
        crossings += high - low;
        // Two crossings bound one run of line, so more than this cannot fit the segment limit.
        if (!(crossings <= 2 * most)) throw over('line segment count', most);
        for (let k = low; k < high; k++) {
          const t = along[i] + ((along[j] - along[i]) * (k * gap - across[i])) / (across[j] - across[i]);
          const list = cut.get(k);
          if (list) list.push(t);
          else cut.set(k, [t]);
        }
      }
    }
    for (const k of [...cut.keys()].sort((a, b) => a - b)) {
      const ts = cut.get(k)!.sort((a, b) => a - b),
        v = k * gap,
        ox = bx - s * v,
        oy = by + c * v;
      const emit = (from: number, to: number) => {
        if (segments.length / 4 >= most) throw over('line segment count', most);
        segments.push(ox + c * from, oy + s * from, ox + c * to, oy + s * to);
      };
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const from = ts[i],
          to = ts[i + 1];
        if (!(to > from)) continue;
        if (!line.dashes.length) {
          emit(from, to);
          continue;
        }
        const origin = k * shift,
          start = Math.floor((from - origin) / period),
          end = Math.ceil((to - origin) / period);
        if (!(end - start <= most + 2)) throw over('line segment count', most);
        for (let n = start; n < end; n++) {
          let t = origin + n * period;
          for (const d of line.dashes) {
            const length = Math.abs(d);
            if (d > 0) {
              const a = Math.max(t, from),
                b = Math.min(t + length, to);
              if (b > a) emit(a, b);
            } else if (d === 0 && t >= from && t <= to) emit(t, t);
            t += length;
          }
        }
      }
    }
  }
  return { triangles, segments, elevation, color };
};
