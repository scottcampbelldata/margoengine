import { Path, Shape } from '@margoengine/geometry/shapes';

/**
 * One drawing command of a 2D outline, in absolute coordinates. Every contour starts with `'M'`; a contour fills as
 * closed whether or not it ends with `'Z'`.
 */
export type OutlineCommand =
  | ['M', number, number]
  | ['L', number, number]
  | ['Q', number, number, number, number] // control, end
  | ['C', number, number, number, number, number, number] // control 1, control 2, end
  | ['Z'];

/**
 * Fill rule, with SVG `fill-rule` semantics: `'nonzero'` fills where the winding number is not 0 (TrueType and the
 * SVG default), `'evenodd'` where a ray crosses an odd number of contours.
 */
export type OutlineFillRule = 'nonzero' | 'evenodd';

/** A drawing segment of one contour: its kind and the coordinates after the kind, as written. */
type Segment = readonly ['L' | 'Q' | 'C', ...number[]];

/** One contour: its start, its segments, and what classification measured on its sampled polygon. */
interface Ring {
  x: number;
  y: number;
  segments: Segment[];
  /** Sampled polygon, flat [x0, y0, x1, y1, ...]. */
  poly: number[];
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Classification samples per curve, at equal parameter steps (the end point included). */
const QUAD_STEPS = 6;
const CUBIC_STEPS = 8;
/** Points along the inner contour that vote in the containment test (odd, so there is no tie). */
const VOTES = 9;
/** Relative slack of the bounding-box test, to absorb float noise. */
const BOX_SLACK = 1e-9;

/** Breaks a command list into contours, following the SVG path rules for M, Z and commands after Z. */
function splitContours(commands: readonly OutlineCommand[]): Ring[] {
  const rings: Ring[] = [];
  let open: Ring | undefined;
  // Where a drawing command after Z (with no new M) starts: the start of the contour Z closed.
  let restart: [number, number] | undefined;
  const ring = (x: number, y: number): Ring => ({
    x,
    y,
    segments: [],
    poly: [],
    area: 0,
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  });
  const finish = () => {
    if (open && open.segments.length) rings.push(open);
    open = undefined;
  };
  if (!Array.isArray(commands)) return rings;
  for (const command of commands) {
    if (!Array.isArray(command)) continue;
    const kind = command[0];
    if (kind === 'M') {
      finish();
      open = ring(+command[1], +command[2]);
      restart = [open.x, open.y];
    } else if (kind === 'Z') {
      if (open) restart = [open.x, open.y];
      finish();
    } else if (kind === 'L' || kind === 'Q' || kind === 'C') {
      if (!open) {
        if (!restart) continue; // before the first M
        open = ring(restart[0], restart[1]);
      }
      const count = kind === 'L' ? 2 : kind === 'Q' ? 4 : 6,
        values: number[] = [];
      for (let i = 1; i <= count; i++) values.push(+(command[i] as number));
      open.segments.push([kind, ...values]);
    }
  }
  finish();
  return rings;
}

/** Samples a contour as a polygon and records its signed shoelace area and bounding box. */
function measure(r: Ring): void {
  const poly = [r.x, r.y];
  let px = r.x,
    py = r.y;
  for (const s of r.segments) {
    if (s[0] === 'L') poly.push(s[1], s[2]);
    else if (s[0] === 'Q') {
      const [, cx, cy, x, y] = s;
      for (let k = 1; k <= QUAD_STEPS; k++) {
        const t = k / QUAD_STEPS,
          u = 1 - t;
        poly.push(u * u * px + 2 * u * t * cx + t * t * x, u * u * py + 2 * u * t * cy + t * t * y);
      }
    } else {
      const [, ax, ay, bx, by, x, y] = s;
      for (let k = 1; k <= CUBIC_STEPS; k++) {
        const t = k / CUBIC_STEPS,
          u = 1 - t,
          w0 = u * u * u,
          w1 = 3 * u * u * t,
          w2 = 3 * u * t * t,
          w3 = t * t * t;
        poly.push(w0 * px + w1 * ax + w2 * bx + w3 * x, w0 * py + w1 * ay + w2 * by + w3 * y);
      }
    }
    px = poly[poly.length - 2];
    py = poly[poly.length - 1];
  }
  // A closing sample equal to the start adds nothing to the area or the crossing test; drop it.
  if (poly.length > 2 && poly[poly.length - 2] === r.x && poly[poly.length - 1] === r.y) poly.length -= 2;
  let twice = 0,
    minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const x0 = poly[i * 2],
      y0 = poly[i * 2 + 1],
      j = (i + 1) % n;
    twice += x0 * poly[j * 2 + 1] - poly[j * 2] * y0;
    if (x0 < minX) minX = x0;
    if (x0 > maxX) maxX = x0;
    if (y0 < minY) minY = y0;
    if (y0 > maxY) maxY = y0;
  }
  r.poly = poly;
  r.area = twice / 2;
  r.minX = minX;
  r.minY = minY;
  r.maxX = maxX;
  r.maxY = maxY;
}

/** Even-odd crossing test of a point against a flat polygon (ray towards +x). */
function inside(poly: readonly number[], x: number, y: number): boolean {
  let odd = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2],
      yi = poly[i * 2 + 1],
      xj = poly[j * 2],
      yj = poly[j * 2 + 1];
    if (yi > y !== yj > y && x < xj + ((y - yj) * (xi - xj)) / (yi - yj)) odd = !odd;
  }
  return odd;
}

/** Whether ring `a` encloses ring `b`: larger, box inside box, and most of b's sample points inside a. */
function encloses(a: Ring, b: Ring): boolean {
  if (!(Math.abs(a.area) > Math.abs(b.area))) return false;
  const slack = BOX_SLACK * Math.max(a.maxX - a.minX, a.maxY - a.minY, 1);
  if (b.minX < a.minX - slack || b.minY < a.minY - slack || b.maxX > a.maxX + slack || b.maxY > a.maxY + slack)
    return false;
  // Voters sit at evenly spaced fractional vertex positions, so most fall inside edges rather than on corners.
  const n = b.poly.length / 2;
  let yes = 0;
  for (let k = 0; k < VOTES; k++) {
    const at = ((k + 0.5) * n) / VOTES,
      i = Math.floor(at),
      j = (i + 1) % n,
      f = at - i,
      x = b.poly[i * 2] + (b.poly[j * 2] - b.poly[i * 2]) * f,
      y = b.poly[i * 2 + 1] + (b.poly[j * 2 + 1] - b.poly[i * 2 + 1]) * f;
    if (inside(a.poly, x, y)) yes++;
  }
  return yes * 2 > VOTES;
}

/** Replays a contour's original commands into a Shape or Path through `map`, closing it when it ends elsewhere. */
function replay<P extends Path>(target: P, r: Ring, map: (x: number, y: number) => [number, number]): P {
  const [sx, sy] = map(r.x, r.y);
  target.moveTo(sx, sy);
  let ex = sx,
    ey = sy;
  for (const s of r.segments) {
    if (s[0] === 'L') {
      [ex, ey] = map(s[1], s[2]);
      target.lineTo(ex, ey);
    } else if (s[0] === 'Q') {
      const [cx, cy] = map(s[1], s[2]);
      [ex, ey] = map(s[3], s[4]);
      target.quadraticCurveTo(cx, cy, ex, ey);
    } else {
      const [ax, ay] = map(s[1], s[2]),
        [bx, by] = map(s[3], s[4]);
      [ex, ey] = map(s[5], s[6]);
      target.bezierCurveTo(ax, ay, bx, by, ex, ey);
    }
  }
  if (ex !== sx || ey !== sy) target.lineTo(sx, sy);
  return target;
}

const same = (x: number, y: number): [number, number] => [x, y];

/**
 * Turns outline commands (glyph outlines, SVG paths) into geometry Shapes with holes. Which contours are outlines
 * and which are holes comes from how they nest plus `fillRule`, never from a fixed winding convention, so outlines
 * drawn in either direction (TrueType, PostScript, SVG) give the same holes. Curves are kept as curves. `map` is
 * applied to every output point (classification uses the unmapped coordinates), so it should preserve nesting:
 * a scale and translation, or a flip. Never throws; contours that are degenerate or contain NaN are left out.
 * @internal Shared by the SVG and font loaders.
 */
export function outlineShapes(
  commands: readonly OutlineCommand[],
  fillRule: OutlineFillRule = 'nonzero',
  map: (x: number, y: number) => [number, number] = same,
): Shape[] {
  const rings: Ring[] = [];
  for (const r of splitContours(commands)) {
    measure(r);
    const extent = (r.maxX - r.minX) * (r.maxY - r.minY);
    if (r.poly.length < 6 || !Number.isFinite(r.area) || !Number.isFinite(extent)) continue;
    if (!(Math.abs(r.area) > extent * 1e-12)) continue;
    rings.push(r);
  }
  const n = rings.length,
    containers: number[][] = rings.map(() => []);
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) if (a !== b && encloses(rings[a], rings[b])) containers[b].push(a);

  // 1 solid, -1 hole, 0 dropped.
  const role = rings.map((r, i) => {
    const around = containers[i];
    if (fillRule === 'evenodd') return around.length % 2 === 0 ? 1 : -1;
    let outside = 0;
    for (const a of around) outside += Math.sign(rings[a].area);
    const within = outside + Math.sign(r.area);
    if (outside === 0 && within !== 0) return 1;
    if (outside !== 0 && within === 0) return -1;
    return 0;
  });

  const shapes: (Shape | undefined)[] = rings.map((r, i) => (role[i] === 1 ? replay(new Shape(), r, map) : undefined));
  for (let i = 0; i < n; i++) {
    if (role[i] !== -1) continue;
    let owner = -1;
    for (const a of containers[i])
      if (role[a] === 1 && (owner < 0 || Math.abs(rings[a].area) < Math.abs(rings[owner].area))) owner = a;
    if (owner >= 0) (shapes[owner] as Shape).holes.push(replay(new Path(), rings[i], map));
  }
  return shapes.filter((s): s is Shape => s !== undefined);
}
