import type { Vec2 } from './math.js';

// Ear-clipping triangulation of a polygon with holes, after the approach popularized by Mapbox earcut: holes are
// bridged into the outer ring, collinear and duplicate points are filtered, and failed passes fall back to curing
// local self-intersections and then splitting the polygon along a valid diagonal.

interface Node {
  i: number;
  x: number;
  y: number;
  prev: Node;
  next: Node;
  steiner: boolean;
}

function insertNode(i: number, x: number, y: number, last: Node | null): Node {
  const p = { i, x, y, steiner: false } as Node;
  if (!last) {
    p.prev = p;
    p.next = p;
  } else {
    p.next = last.next;
    p.prev = last;
    last.next.prev = p;
    last.next = p;
  }
  return p;
}
function removeNode(p: Node): void {
  p.next.prev = p.prev;
  p.prev.next = p.next;
}
const area = (p: Node, q: Node, r: Node) => (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
const same = (a: Node, b: Node) => a.x === b.x && a.y === b.y;
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

function signedArea(data: ArrayLike<number>, start: number, end: number, dim: number): number {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}

/** Builds a circular list. The outer ring is stored counter-clockwise, holes clockwise, whatever the input order. */
function linkedList(data: ArrayLike<number>, start: number, end: number, dim: number, outer: boolean): Node | null {
  let last: Node | null = null;
  if (outer === signedArea(data, start, end, dim) > 0)
    for (let i = start; i < end; i += dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  else for (let i = end - dim; i >= start; i -= dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  if (last && same(last, last.next)) {
    removeNode(last);
    last = last.next;
  }
  return last;
}

/** Removes duplicate and collinear points. */
function filterPoints(start: Node | null, end?: Node): Node | null {
  if (!start) return start;
  if (!end) end = start;
  let p = start,
    again: boolean;
  do {
    again = false;
    if (!p.steiner && (same(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}

function pointInTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  );
}

function isEar(ear: Node): boolean {
  const a = ear.prev,
    b = ear,
    c = ear.next;
  if (area(a, b, c) >= 0) return false;
  const minX = Math.min(a.x, b.x, c.x),
    minY = Math.min(a.y, b.y, c.y),
    maxX = Math.max(a.x, b.x, c.x),
    maxY = Math.max(a.y, b.y, c.y);
  for (let p = c.next; p !== a; p = p.next) {
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY || (p.x === a.x && p.y === a.y)) continue;
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
  }
  return true;
}

const onSegment = (p: Node, q: Node, r: Node) =>
  q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(area(p1, q1, p2)),
    o2 = sign(area(p1, q1, q2)),
    o3 = sign(area(p2, q2, p1)),
    o4 = sign(area(p2, q2, q1));
  return (
    (o1 !== o2 && o3 !== o4) ||
    (o1 === 0 && onSegment(p1, p2, q1)) ||
    (o2 === 0 && onSegment(p1, q2, q1)) ||
    (o3 === 0 && onSegment(p2, p1, q2)) ||
    (o4 === 0 && onSegment(p2, q1, q2))
  );
}
function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}
function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}
function middleInside(a: Node, b: Node): boolean {
  let p = a,
    inside = false;
  const px = (a.x + b.x) / 2,
    py = (a.y + b.y) / 2;
  do {
    if (p.y > py !== p.next.y > py && p.next.y !== p.y && px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x)
      inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}
function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) &&
      locallyInside(b, a) &&
      middleInside(a, b) &&
      !!(area(a.prev, a, b.prev) || area(a, b.prev, b))) ||
      (same(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))
  );
}

/** Links a to b with a two-way bridge, returning the new copy of b on the far side. */
function splitPolygon(a: Node, b: Node): Node {
  const a2 = insertNode(a.i, a.x, a.y, null),
    b2 = insertNode(b.i, b.x, b.y, null),
    an = a.next,
    bp = b.prev;
  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;
  return b2;
}

function cureLocalIntersections(start: Node, triangles: number[]): Node | null {
  let p = start;
  do {
    const a = p.prev,
      b = p.next.next;
    if (!same(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      removeNode(p);
      removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

function splitEarcut(start: Node, triangles: number[]): void {
  let a = start;
  do {
    for (let b = a.next.next; b !== a.prev; b = b.next) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        const c = splitPolygon(a, b);
        clip(filterPoints(a, a.next), triangles, 0);
        clip(filterPoints(c, c.next), triangles, 0);
        return;
      }
    }
    a = a.next;
  } while (a !== start);
}

function clip(ear: Node | null, triangles: number[], pass: number): void {
  if (!ear) return;
  let stop = ear;
  while (ear.prev !== ear.next) {
    const prev: Node = ear.prev,
      next: Node = ear.next;
    if (isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      removeNode(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (pass === 0) clip(filterPoints(ear), triangles, 1);
      else if (pass === 1) {
        const cured = cureLocalIntersections(filterPoints(ear)!, triangles);
        clip(cured, triangles, 2);
      } else splitEarcut(ear, triangles);
      break;
    }
  }
}

function findHoleBridge(hole: Node, outer: Node): Node | null {
  let p = outer,
    qx = -Infinity,
    m: Node | null = null;
  const hx = hole.x,
    hy = hole.y;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;
  const stop = m,
    mx = m.x,
    my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (
      hx >= p.x &&
      p.x >= mx &&
      hx !== p.x &&
      pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)
    ) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (
        locallyInside(p, hole) &&
        (tan < tanMin ||
          (tan === tanMin &&
            (p.x > m.x || (p.x === m.x && area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0))))
      ) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function leftmost(start: Node): Node {
  let p = start,
    best = start;
  do {
    if (p.x < best.x || (p.x === best.x && p.y < best.y)) best = p;
    p = p.next;
  } while (p !== start);
  return best;
}

/**
 * Triangulates a flat polygon. `data` holds the outer ring then each hole, `dim` numbers per vertex (x and y are read);
 * `holeIndices` are the starting vertex indices of each hole. Returns vertex index triples, each wound
 * counter-clockwise (positive area in a y-up frame). Ring orientation in the input does not matter.
 */
export function triangulate(data: ArrayLike<number>, holeIndices: ArrayLike<number> = [], dim = 2): number[] {
  if (!Number.isSafeInteger(dim) || dim < 2) throw new RangeError('Invalid triangulation dimension');
  let previousHole = 0;
  for (let i = 0; i < holeIndices.length; i++) {
    const hole = holeIndices[i];
    if (!Number.isSafeInteger(hole) || hole < previousHole || hole * dim > data.length)
      throw new RangeError('Invalid triangulation hole boundary');
    previousHole = hole;
  }
  const outerLength = holeIndices.length ? holeIndices[0] * dim : data.length;
  let outer = linkedList(data, 0, outerLength, dim, true);
  const triangles: number[] = [];
  if (!outer || outer.next === outer.prev) return triangles;
  if (holeIndices.length) {
    const queue: Node[] = [];
    for (let i = 0; i < holeIndices.length; i++) {
      const start = holeIndices[i] * dim,
        end = i < holeIndices.length - 1 ? holeIndices[i + 1] * dim : data.length;
      const list = linkedList(data, start, end, dim, false);
      if (!list) continue;
      if (list === list.next) list.steiner = true;
      queue.push(leftmost(list));
    }
    queue.sort((a, b) => a.x - b.x || a.y - b.y);
    for (const hole of queue) {
      const bridge = findHoleBridge(hole, outer);
      if (!bridge) continue;
      const reverse = splitPolygon(bridge, hole);
      filterPoints(reverse, reverse.next);
      outer = filterPoints(bridge, bridge.next)!;
    }
  }
  clip(outer, triangles, 0);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * dim,
      b = triangles[t + 1] * dim,
      c = triangles[t + 2] * dim;
    const cross = (data[b] - data[a]) * (data[c + 1] - data[a + 1]) - (data[b + 1] - data[a + 1]) * (data[c] - data[a]);
    if (cross < 0) {
      const swap = triangles[t + 1];
      triangles[t + 1] = triangles[t + 2];
      triangles[t + 2] = swap;
    }
  }
  return triangles;
}

/** Signed area of a 2D contour, positive when counter-clockwise (Three.js `ShapeUtils.area`). */
export function shapeArea(contour: readonly Vec2[]): number {
  let a = 0;
  for (let p = contour.length - 1, q = 0; q < contour.length; p = q++)
    a += contour[p][0] * contour[q][1] - contour[q][0] * contour[p][1];
  return a * 0.5;
}

/** Three.js `ShapeUtils.isClockWise`: negative signed area. */
export const isClockWise = (points: readonly Vec2[]): boolean => shapeArea(points) < 0;

function withoutClosingDuplicate(points: readonly Vec2[]): Vec2[] {
  const out = points.slice();
  while (out.length > 2 && out[out.length - 1][0] === out[0][0] && out[out.length - 1][1] === out[0][1]) out.pop();
  return out;
}

/**
 * Removes consecutive points (including last-to-first) closer than 1e-10 relative to their magnitude, as Three.js
 * `ExtrudeGeometry` does. A full arc ends at (cos 2pi, sin 2pi), which is not exactly its start.
 */
export function mergeOverlappingPoints(points: readonly Vec2[]): Vec2[] {
  const out = points.slice();
  if (out.length < 2) return out;
  let prev = out[0];
  for (let i = 1; i <= out.length; i++) {
    const index = i % out.length,
      cur = out[index];
    const d2 = (cur[0] - prev[0]) ** 2 + (cur[1] - prev[1]) ** 2,
      scale = Math.max(Math.abs(cur[0]), Math.abs(cur[1]), Math.abs(prev[0]), Math.abs(prev[1]));
    if (d2 <= 1e-20 * scale * scale) {
      out.splice(index, 1);
      i--;
      if (out.length < 2) break;
      continue;
    }
    prev = cur;
  }
  return out;
}

/**
 * Three.js `ShapeUtils.triangulateShape`: drops exactly repeated closing points, then triangulates. Returns flat index
 * triples into `[...contour, ...holes.flat()]` (after the closing duplicates are removed, which is done in place
 * on copies returned as `contour` and `holes`).
 */
export function triangulateShape(
  contour: readonly Vec2[],
  holes: readonly (readonly Vec2[])[] = [],
): { indices: number[]; contour: Vec2[]; holes: Vec2[][] } {
  const outer = withoutClosingDuplicate(contour),
    inner = holes.map(withoutClosingDuplicate).filter((h) => h.length >= 3);
  const data: number[] = [],
    holeIndices: number[] = [];
  for (const p of outer) data.push(p[0], p[1]);
  for (const hole of inner) {
    holeIndices.push(data.length / 2);
    for (const p of hole) data.push(p[0], p[1]);
  }
  return { indices: triangulate(data, holeIndices), contour: outer, holes: inner };
}
