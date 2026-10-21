import { Path, Shape } from '@margoengine/geometry';

/**
 * One drawing command of a 2D outline, in absolute coordinates: move, line, quadratic Bézier (control, end), cubic
 * Bézier (control 1, control 2, end) and close. Every contour starts with `'M'`; a contour is closed for filling
 * whether or not it ends with `'Z'`.
 */
export type OutlineCommand =
  | ['M', number, number]
  | ['L', number, number]
  | ['Q', number, number, number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z'];

/**
 * How overlapping and nested contours fill (SVG `fill-rule`): `'nonzero'` fills where the contours' winding number is
 * not zero (TrueType and the SVG default), `'evenodd'` where a ray crosses an odd number of contours.
 */
export type OutlineFillRule = 'nonzero' | 'evenodd';

/** Maps a point while outlines become shapes (font scale and pen position, SVG y flip). */
type PointMap = (x: number, y: number) => [number, number];

interface Contour {
  commands: OutlineCommand[];
  /** Flattened polygon, x y pairs. */
  points: number[];
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Splits commands into contours that each start with M and draw at least one segment. */
function splitContours(commands: readonly OutlineCommand[]): OutlineCommand[][] {
  const out: OutlineCommand[][] = [];
  let current: OutlineCommand[] | null = null,
    startX = 0,
    startY = 0;
  for (const command of commands) {
    if (command[0] === 'M') {
      if (current && current.length > 1) out.push(current);
      current = [command];
      startX = command[1];
      startY = command[2];
    } else if (command[0] === 'Z') {
      if (current && current.length > 1) out.push(current);
      // A command after Z without M continues from the contour's start point (SVG rule).
      current = current ? [['M', startX, startY]] : null;
    } else if (current) current.push(command);
  }
  if (current && current.length > 1) out.push(current);
  return out;
}

function flatten(commands: readonly OutlineCommand[]): Contour {
  const points: number[] = [];
  let x = 0,
    y = 0;
  for (const c of commands) {
    switch (c[0]) {
      case 'M':
      case 'L':
        x = c[1];
        y = c[2];
        points.push(x, y);
        break;
      case 'Q':
        for (let i = 1; i <= 4; i++) {
          const t = i / 4,
            u = 1 - t;
          points.push(u * u * x + 2 * u * t * c[1] + t * t * c[3], u * u * y + 2 * u * t * c[2] + t * t * c[4]);
        }
        x = c[3];
        y = c[4];
        break;
      case 'C':
        for (let i = 1; i <= 6; i++) {
          const t = i / 6,
            u = 1 - t;
          points.push(
            u * u * u * x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
            u * u * u * y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
          );
        }
        x = c[5];
        y = c[6];
        break;
    }
  }
  let area = 0,
    minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0, n = points.length; i < n; i += 2) {
    const px = points[i],
      py = points[i + 1],
      j = (i + 2) % n;
    area += px * points[j + 1] - points[j] * py;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return { commands: commands as OutlineCommand[], points, area: area / 2, minX, minY, maxX, maxY };
}

/** Even-odd ray test of a point against a flattened polygon. */
function insidePolygon(points: readonly number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, n = points.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = points[i],
      yi = points[i + 1],
      xj = points[j],
      yj = points[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when `inner` lies inside `outer`: bounds first, then a majority vote of up to 9 of inner's points. */
function contains(outer: Contour, inner: Contour): boolean {
  if (Math.abs(outer.area) <= Math.abs(inner.area)) return false;
  const pad = 1e-9 * Math.max(1, outer.maxX - outer.minX, outer.maxY - outer.minY);
  if (
    inner.minX < outer.minX - pad ||
    inner.maxX > outer.maxX + pad ||
    inner.minY < outer.minY - pad ||
    inner.maxY > outer.maxY + pad
  )
    return false;
  const count = inner.points.length / 2,
    samples = Math.min(9, count);
  let votes = 0;
  for (let s = 0; s < samples; s++) {
    const i = Math.floor((s * count) / samples) * 2;
    if (insidePolygon(outer.points, inner.points[i], inner.points[i + 1])) votes++;
  }
  return votes * 2 > samples;
}

function replay(target: Path, commands: readonly OutlineCommand[], map: PointMap): void {
  let sx = 0,
    sy = 0,
    x = 0,
    y = 0;
  for (const c of commands) {
    switch (c[0]) {
      case 'M':
        [sx, sy] = map(c[1], c[2]);
        x = sx;
        y = sy;
        target.moveTo(x, y);
        break;
      case 'L':
        [x, y] = map(c[1], c[2]);
        target.lineTo(x, y);
        break;
      case 'Q': {
        const [cx, cy] = map(c[1], c[2]);
        [x, y] = map(c[3], c[4]);
        target.quadraticCurveTo(cx, cy, x, y);
        break;
      }
      case 'C': {
        const [ax, ay] = map(c[1], c[2]),
          [bx, by] = map(c[3], c[4]);
        [x, y] = map(c[5], c[6]);
        target.bezierCurveTo(ax, ay, bx, by, x, y);
        break;
      }
    }
  }
  if (x !== sx || y !== sy) target.lineTo(sx, sy);
}

/**
 * Turns outline commands into geometry `Shape`s with their holes. Which contours are solid and which are holes comes
 * from nesting (containment) and the fill rule, never from one fixed winding convention: with `'nonzero'` a contour
 * starts a filled region when the winding outside it is 0 and inside is not, and is a hole in the reverse case
 * (redundant contours inside a filled region are dropped); with `'evenodd'` contours at even nesting depth are solid.
 * Each hole goes to the smallest solid contour around it. Degenerate (zero-area) contours are skipped.
 */
export function outlineShapes(
  commands: readonly OutlineCommand[],
  fillRule: OutlineFillRule = 'nonzero',
  map: PointMap = (x, y) => [x, y],
): Shape[] {
  const contours = splitContours(commands)
    .map(flatten)
    .filter((c) => c.points.length >= 6 && c.area !== 0 && Number.isFinite(c.area));
  const n = contours.length,
    containers: number[][] = contours.map(() => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) if (i !== j && contains(contours[i], contours[j])) containers[j].push(i);
  // 1 solid, -1 hole, 0 neither.
  const role = contours.map((c, j) => {
    if (fillRule === 'evenodd') return containers[j].length % 2 ? -1 : 1;
    const outside = containers[j].reduce((sum, i) => sum + Math.sign(contours[i].area), 0),
      inside = outside + Math.sign(c.area);
    return outside === 0 && inside !== 0 ? 1 : outside !== 0 && inside === 0 ? -1 : 0;
  });
  const shapes = new Map<number, Shape>();
  for (let i = 0; i < n; i++)
    if (role[i] === 1) {
      const shape = new Shape();
      replay(shape, contours[i].commands, map);
      shapes.set(i, shape);
    }
  for (let j = 0; j < n; j++) {
    if (role[j] !== -1) continue;
    let owner = -1;
    for (const i of containers[j])
      if (role[i] === 1 && (owner < 0 || Math.abs(contours[i].area) < Math.abs(contours[owner].area))) owner = i;
    if (owner < 0) continue;
    const hole = new Path();
    replay(hole, contours[j].commands, map);
    shapes.get(owner)?.holes.push(hole);
  }
  return [...shapes.values()];
}
