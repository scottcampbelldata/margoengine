// The DXF LEADER and MULTILEADER entities as plain geometry: leader paths, arrowheads and, for a MULTILEADER, its
// text or block content. Written from Autodesk's DXF reference and public descriptions of the format
// (docs/clean-room.md, "DXF leaders"). Coordinates are the entity's own (world coordinates of its space); parseDXF
// places them.

type Value = string | number;
/** A point or vector, xyz. */
export type DXFPoint = [number, number, number];

/** An arrowhead at `tip`, pointing away from `from`, flat in the plane of `normal`. */
export interface DXFArrow {
  tip: DXFPoint;
  from: DXFPoint;
  normal: DXFPoint;
  size: number;
  /** Handle of the BLOCK_RECORD that replaces the closed filled arrow. */
  handle?: string;
}

export interface DXFLeaderPlan {
  /** Open polylines. */
  paths: DXFPoint[][];
  arrows: DXFArrow[];
}

export interface DXFMultiLeaderPlan extends DXFLeaderPlan {
  /** MTEXT content, formatting codes still in it. */
  text?: { raw: string; position: DXFPoint; height: number; direction: DXFPoint; normal: DXFPoint };
  /** Block content, and the attribute values by the handle of their ATTDEF. */
  block?: {
    handle: string;
    position: DXFPoint;
    normal: DXFPoint;
    rotation: number;
    scale: DXFPoint;
    attributes: [string, string][];
  };
  /** The content is a tolerance frame, which is not drawn. */
  tolerance: boolean;
}

/** A dimension variable by its DIMSTYLE group code. */
export type DXFDimension = (code: number) => Value | undefined;

/** Samples of a spline between each pair of fit points, and the most samples that may still be made. */
export interface DXFCurveLimits {
  segments: number;
  most: number;
  tooMany(): never;
}

const number = (v: Value | undefined, fallback = 0) => {
  const n = typeof v === 'number' ? v : v === undefined ? Number.NaN : Number(v.trim());
  return Number.isFinite(n) ? n : fallback;
};
const string = (v: Value | undefined) => (v === undefined ? '' : String(v).trim());

const add = (a: DXFPoint, b: DXFPoint, s = 1): DXFPoint => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
const distance = (a: DXFPoint, b: DXFPoint) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const unit = (v: DXFPoint): DXFPoint | undefined => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 && l < Infinity ? [v[0] / l, v[1] / l, v[2] / l] : undefined;
};
const cross = (a: DXFPoint, b: DXFPoint): DXFPoint => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The dimension variables an entity's xdata overrides: under application `ACAD`, `DSTYLE`, then between the braces
 * pairs of a variable's code (1070) and its value.
 */
export function dimensionOverrides(codes: number[], values: Value[]): Map<number, Value> {
  const out = new Map<number, Value>();
  let k = codes.findIndex((c, i) => c === 1001 && string(values[i]) === 'ACAD');
  if (k < 0) return out;
  while (k < codes.length && !(codes[k] === 1000 && string(values[k]) === 'DSTYLE')) k++;
  if (codes[k + 1] !== 1002 || string(values[k + 1]) !== '{') return out;
  for (k += 2; codes[k] === 1070 && k + 1 < codes.length && codes[k + 1] !== 1002; k += 2)
    out.set(number(values[k]), values[k + 1]);
  return out;
}

/**
 * The complete cubic spline through `points` (C. de Boor, *A Practical Guide to Splines*, Springer 1978, chapter IV):
 * chord-length parameters, end tangents along the first and last chords, solved by the tridiagonal elimination.
 */
function fitSpline(points: DXFPoint[], limits: DXFCurveLimits): DXFPoint[] {
  const p = points.filter((q, i) => i === 0 || distance(q, points[i - 1]) > 0),
    n = p.length;
  if (n < 3) return p;
  if ((n - 1) * limits.segments > limits.most) limits.tooMany();
  const h = p.slice(1).map((q, i) => distance(p[i], q)),
    tangent: DXFPoint[] = p.map(() => [0, 0, 0]),
    upper = new Float64Array(n);
  tangent[0] = unit(add(p[1], p[0], -1))!;
  tangent[n - 1] = unit(add(p[n - 1], p[n - 2], -1))!;
  // Row i: h[i] m[i-1] + 2 (h[i-1] + h[i]) m[i] + h[i-1] m[i+1] = 3 (h[i]/h[i-1] dP[i-1] + h[i-1]/h[i] dP[i]).
  for (let i = 1; i < n - 1; i++) {
    const pivot = 2 * (h[i - 1] + h[i]) - h[i] * upper[i - 1];
    upper[i] = h[i - 1] / pivot;
    for (let a = 0; a < 3; a++) {
      let right =
        3 * ((h[i] / h[i - 1]) * (p[i][a] - p[i - 1][a]) + (h[i - 1] / h[i]) * (p[i + 1][a] - p[i][a])) -
        h[i] * tangent[i - 1][a];
      if (i === n - 2) right -= h[i - 1] * tangent[n - 1][a];
      tangent[i][a] = right / pivot;
    }
  }
  for (let i = n - 3; i > 0; i--) for (let a = 0; a < 3; a++) tangent[i][a] -= upper[i] * tangent[i + 1][a];
  const out: DXFPoint[] = [p[0]];
  for (let i = 0; i < n - 1; i++)
    for (let k = 1; k <= limits.segments; k++) {
      const t = k / limits.segments,
        t2 = t * t,
        t3 = t2 * t,
        a = 2 * t3 - 3 * t2 + 1,
        b = (t3 - 2 * t2 + t) * h[i],
        c = 3 * t2 - 2 * t3,
        d = (t3 - t2) * h[i];
      out.push(
        [0, 1, 2].map((x) => a * p[i][x] + b * tangent[i][x] + c * p[i + 1][x] + d * tangent[i + 1][x]) as DXFPoint,
      );
    }
  return out;
}

/** The segment from `a` to `b` without the parts between each break's two points. */
function broken(a: DXFPoint, b: DXFPoint, breaks: [DXFPoint, DXFPoint][]): DXFPoint[][] {
  const along = add(b, a, -1),
    at = (q: DXFPoint) => (q[0] - a[0]) * along[0] + (q[1] - a[1]) * along[1] + (q[2] - a[2]) * along[2],
    gaps = breaks.map(([s, e]) => (at(s) <= at(e) ? [s, e] : [e, s])).sort((x, y) => at(x[0]) - at(y[0]));
  const pieces: DXFPoint[][] = [];
  let from = a;
  for (const [start, end] of gaps) {
    if (at(start) > at(from)) pieces.push([from, start]);
    if (at(end) > at(from)) from = end;
  }
  if (at(b) > at(from)) pieces.push([from, b]);
  return pieces;
}

/** No arrowhead is drawn on a first segment shorter than twice its size, as AutoCAD does. */
const arrowOn = (path: DXFPoint[], normal: DXFPoint, size: number): DXFArrow | undefined =>
  size > 0 && path.length > 1 && distance(path[0], path[1]) >= 2 * size
    ? { tip: path[0], from: path[1], normal, size }
    : undefined;

/** A LEADER: its vertices, as segments or a spline, the arrowhead at the first and the hook line under its text. */
export function readLeader(
  codes: number[],
  values: Value[],
  dimension: DXFDimension,
  limits: DXFCurveLimits,
): DXFLeaderPlan {
  const first = (code: number) => {
      const k = codes.indexOf(code);
      return k < 0 ? undefined : values[k];
    },
    vertices: DXFPoint[] = [];
  for (let k = 0; k < codes.length; k++)
    if (codes[k] === 10) vertices.push([number(values[k]), 0, 0]);
    else if ((codes[k] === 20 || codes[k] === 30) && vertices.length)
      vertices[vertices.length - 1][codes[k] / 10 - 1] = number(values[k]);
  const scale = number(dimension(40), 1) || 1,
    normal: DXFPoint = [number(first(210)), number(first(220)), number(first(230), 1)],
    width = number(first(41));
  // With text above the line (DIMTAD), a leader that carries text runs on under it. The file does not store this part.
  if (vertices.length > 1 && number(dimension(77)) !== 0 && number(first(73), 3) === 0 && width > 0) {
    const horizontal: DXFPoint = unit([number(first(211), 1), number(first(221)), number(first(231))]) ?? [1, 0, 0],
      length = Math.abs(number(dimension(147))) * scale + width;
    vertices.push(add(vertices[vertices.length - 1], horizontal, number(first(74)) === 1 ? -length : length));
  }
  const path = number(first(72)) === 1 ? fitSpline(vertices, limits) : vertices,
    arrow = number(first(71), 1) !== 0 ? arrowOn(vertices, normal, number(dimension(41)) * scale) : undefined;
  return { paths: path.length > 1 ? [path] : [], arrows: arrow ? [arrow] : [] };
}

/** One block of a MULTILEADER: its first value of each code and its points in order, by their x code. */
interface Block {
  values: Map<number, Value>;
  points: { code: number; p: DXFPoint }[];
}
const block = (): Block => ({ values: new Map(), points: [] });
const put = (to: Block, code: number, value: Value) => {
  // Points: x codes 10 to 18 and 110 to 112, y and z 10 and 20 above them.
  const family = code >= 100 ? code - 100 : code,
    axis = Math.floor(family / 10) - 1;
  if (family >= 10 && family < 40) {
    const x = code - 10 * axis;
    if (axis === 0) to.points.push({ code: x, p: [number(value), 0, 0] });
    else {
      for (let k = to.points.length - 1; k >= 0; k--)
        if (to.points[k].code === x) {
          to.points[k].p[axis] = number(value);
          break;
        }
    }
  } else if (!to.values.has(code)) to.values.set(code, value);
};
const point = (from: Block, code: number) => from.points.find((q) => q.code === code)?.p;
/** Break pairs: each start point (`start`) with the end point (`end`) that follows it. */
const pairs = (points: Block['points'], start: number, end: number): [DXFPoint, DXFPoint][] => {
  const out: [DXFPoint, DXFPoint][] = [];
  let open: DXFPoint | undefined;
  for (const q of points)
    if (q.code === start) open = q.p;
    else if (q.code === end && open) {
      out.push([open, q.p]);
      open = undefined;
    }
  return out;
};

/**
 * A MULTILEADER, or `undefined` without its context data. The context block holds the content and one block per
 * leader (landing point, dogleg), which holds one block per leader line (vertices and breaks).
 */
export function readMultiLeader(
  codes: number[],
  values: Value[],
  dimension: DXFDimension,
  limits: DXFCurveLimits,
): DXFMultiLeaderPlan | undefined {
  const common = block(),
    context = block(),
    leaders: { own: Block; lines: Block[] }[] = [],
    attributes: [string, string][] = [];
  let level: 'common' | 'context' | 'leader' | 'line' = 'common',
    found = false,
    attribute = '';
  for (let k = 0; k < codes.length && codes[k] < 1000; k++) {
    const code = codes[k],
      value = values[k],
      mark = code >= 300 && code <= 305 ? string(value) : '';
    if (level === 'common' && code === 300 && mark === 'CONTEXT_DATA{') {
      level = 'context';
      found = true;
    } else if (level === 'context' && code === 302 && mark === 'LEADER{') {
      level = 'leader';
      leaders.push({ own: block(), lines: [] });
    } else if (level === 'leader' && code === 304 && mark === 'LEADER_LINE{') {
      level = 'line';
      leaders[leaders.length - 1].lines.push(block());
    } else if (level === 'line' && code === 305 && mark === '}') level = 'leader';
    else if (level === 'leader' && code === 303 && mark === '}') level = 'context';
    else if (level === 'context' && code === 301 && mark === '}') level = 'common';
    else if (level === 'context') put(context, code, value);
    else if (level === 'leader') put(leaders[leaders.length - 1].own, code, value);
    else if (level === 'line') put(leaders[leaders.length - 1].lines.at(-1)!, code, value);
    else if (code === 330) attribute = string(value);
    else if (code === 302) attributes.push([attribute, String(value)]);
    else if (!common.values.has(code)) common.values.set(code, value);
  }
  if (!found) return undefined;

  const type = number(common.values.get(170), 1),
    doglegs = number(common.values.get(291), 1) !== 0,
    xAxis = point(context, 111),
    yAxis = point(context, 112),
    normal: DXFPoint = (xAxis && yAxis && unit(cross(xAxis, yAxis))) || point(context, 11) || ([0, 0, 1] as DXFPoint),
    size = number(
      context.values.get(140),
      number(common.values.get(42), number(dimension(41)) * (number(dimension(40), 1) || 1)),
    ),
    handle = string(common.values.get(342)),
    paths: DXFPoint[][] = [],
    arrows: DXFArrow[] = [];
  // A leader type of 0 is invisible: only the content is drawn.
  if (type !== 0)
    for (const { own, lines } of leaders) {
      const landing = number(own.values.get(290), 1) !== 0 ? point(own, 10) : undefined,
        direction = number(own.values.get(291), 1) !== 0 ? unit(point(own, 11) ?? [0, 0, 0]) : undefined,
        length = number(own.values.get(40)),
        end = landing && direction ? add(landing, direction, length) : landing,
        // Without a drawn dogleg the lines run straight to where it would have ended.
        dogleg = !!(doglegs && type === 1 && landing && direction && length !== 0),
        join = dogleg ? landing : end;
      for (const line of lines) {
        const vertices = line.points.filter((q) => q.code === 10).map((q) => q.p);
        if (!vertices.length) continue;
        if (join) vertices.push(join);
        const arrow = arrowOn(vertices, normal, size);
        if (arrow) arrows.push(handle && !/^0*$/.test(handle) ? { ...arrow, handle } : arrow);
        if (type === 2) {
          const path = fitSpline(vertices, limits);
          if (path.length > 1) paths.push(path);
          continue;
        }
        // Breaks follow the vertex their segment starts at.
        let start = 0,
          run: DXFPoint[] = [vertices[0]];
        for (let i = 0; i + 1 < vertices.length; i++) {
          while (start < line.points.length && line.points[start].code !== 10) start++;
          let stop = start + 1;
          while (stop < line.points.length && line.points[stop].code !== 10) stop++;
          const breaks = pairs(line.points.slice(start + 1, stop), 11, 12);
          start = stop;
          if (!breaks.length) {
            run.push(vertices[i + 1]);
            continue;
          }
          if (run.length > 1) paths.push(run);
          const pieces = broken(vertices[i], vertices[i + 1], breaks),
            last = pieces.at(-1),
            // The part that reaches the next vertex goes on into the next segment.
            joins = last && distance(last[1], vertices[i + 1]) === 0;
          paths.push(...(joins ? pieces.slice(0, -1) : pieces));
          run = joins ? [...last] : [vertices[i + 1]];
        }
        if (run.length > 1) paths.push(run);
      }
      if (dogleg) paths.push(...broken(landing!, end!, pairs(own.points, 12, 13)));
    }

  const content = number(common.values.get(172), -1),
    hasText = number(context.values.get(290)) !== 0,
    hasBlock = number(context.values.get(296)) !== 0,
    raw = String(context.values.get(304) ?? ''),
    plan: DXFMultiLeaderPlan = { paths, arrows, tolerance: content === 3 };
  if (raw && (content === 2 || (content < 0 && hasText)))
    plan.text = {
      raw,
      position: point(context, 12) ?? point(context, 10) ?? [0, 0, 0],
      height: number(context.values.get(41)),
      direction: point(context, 13) ?? [1, 0, 0],
      normal: point(context, 11) ?? [0, 0, 1],
    };
  if (content === 1 || (content < 0 && hasBlock))
    plan.block = {
      handle: string(context.values.get(341) ?? common.values.get(344)),
      position: point(context, 15) ?? point(context, 10) ?? [0, 0, 0],
      normal: point(context, 14) ?? [0, 0, 1],
      // Radians, unlike the degrees of INSERT.
      rotation: number(context.values.get(46)),
      scale: point(context, 16) ?? [1, 1, 1],
      attributes,
    };
  return plan;
}
