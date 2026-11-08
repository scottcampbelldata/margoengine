// Solids for the convex decomposition: a closed triangle mesh cut by a plane and capped on both sides, its volume, its
// hull and the collision-aware concavity of Wei, Liu, Ling and Su, "Approximate Convex Decomposition for 3D Meshes with
// Collision-Aware Concavity and Tree Search", ACM TOG 41(4) 42, 2022 (arXiv 2205.02961), sections 4 and 5.
//
// Only + - * / and own roots, so a decomposition repeats bit for bit in every engine for the same seed.
import { buildHull, root } from '../next/hull.js';

const PI = 3.141592653589793;

/** A plane: points p with `normal . p - offset >= 0` lie on its positive side. */
export interface Plane {
  normal: [number, number, number];
  offset: number;
}

/** A solid's convex hull: unit outward face planes (nx, ny, nz, offset per face), triangles and volume. */
export interface Hull {
  points: Float64Array;
  planes: Float64Array;
  triangles: Uint32Array;
  volume: number;
}

/** A cube root from only + - * /, Newton from above, as `Math.cbrt` is not promised to round the same everywhere. */
export function cubeRoot(value: number): number {
  if (!(value > 0)) return 0;
  let estimate = 1,
    scaled = value;
  while (scaled > 8) {
    scaled /= 8;
    estimate *= 2;
  }
  while (scaled < 1) {
    scaled *= 8;
    estimate /= 2;
  }
  estimate *= 2;
  for (let i = 0; i < 80; i++) {
    const next = (2 * estimate + value / (estimate * estimate)) / 3;
    if (!(next < estimate)) break;
    estimate = next;
  }
  return estimate;
}

/** The natural logarithm from only + - * /: halvings to [0.75, 1.5], then 2 atanh((x - 1) / (x + 1)) by its series. */
export function logarithm(value: number): number {
  if (!(value > 0)) return -Infinity;
  let power = 0;
  while (value > 1.5) {
    value /= 2;
    power++;
  }
  while (value < 0.75) {
    value *= 2;
    power--;
  }
  const z = (value - 1) / (value + 1),
    z2 = z * z;
  let sum = 0,
    term = z;
  for (let n = 1; n < 60; n += 2, term *= z2) sum += term / n;
  return 2 * sum + power * 0.6931471805599453;
}

/**
 * A closed solid as triangles. `cap` tags each triangle: -1 for the input's own surface, else 2 * plane + side, the cut
 * that made it (side 1 for the part on the plane's positive side, whose cap faces against the normal).
 */
export class Solid {
  readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  readonly volume: number;
  #hull: Hull | null | undefined;
  #rv = -1;

  constructor(
    readonly positions: Float64Array,
    readonly triangles: Uint32Array,
    readonly cap: Int32Array,
    volume?: number,
  ) {
    const p = positions;
    for (let i = 0; i < p.length; i += 3)
      for (let a = 0; a < 3; a++) {
        if (p[i + a] < this.min[a]) this.min[a] = p[i + a];
        if (p[i + a] > this.max[a]) this.max[a] = p[i + a];
      }
    this.volume = volume ?? meshVolume(p, triangles, this.min);
  }

  /** The hull of the solid's points, or null for points that span no volume. */
  hull(): Hull | null {
    if (this.#hull === undefined) this.#hull = this.volume > 0 ? hullOf(this.positions) : null;
    return this.#hull;
  }

  /** Rv (Eq. 5): the radius of a ball with the volume the hull adds. */
  rv(): number {
    if (this.#rv < 0) {
      const hull = this.hull(),
        extra = hull ? hull.volume - this.volume : 0;
      this.#rv = extra > 0 ? cubeRoot((3 * extra) / (4 * PI)) : 0;
    }
    return this.#rv;
  }
}

/** Signed volume by the divergence theorem, each triangle's tetrahedron to `origin`. */
function meshVolume(p: Float64Array, t: Uint32Array, origin: readonly number[]): number {
  let six = 0;
  const [ox, oy, oz] = origin;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3,
      b = t[i + 1] * 3,
      c = t[i + 2] * 3;
    const ax = p[a] - ox,
      ay = p[a + 1] - oy,
      az = p[a + 2] - oz,
      bx = p[b] - ox,
      by = p[b + 1] - oy,
      bz = p[b + 2] - oz,
      cx = p[c] - ox,
      cy = p[c + 1] - oy,
      cz = p[c + 2] - oz;
    six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

/** The Quickhull of `src/next/hull.ts` as unit planes, fan triangles and a volume; null when it spans no volume. */
export function hullOf(points: Float64Array): Hull | null {
  let faces;
  try {
    faces = buildHull(points);
  } catch (error) {
    // A part flatter than the hull's tolerance has no hull: it is a sliver, and the search never keeps one.
    if (error instanceof RangeError) return null;
    throw error;
  }
  const flat = new Float64Array(faces.vertices.length * 3);
  faces.vertices.forEach((v, i) => flat.set(v, i * 3));
  const planes = new Float64Array(faces.faces.length * 4),
    triangles: number[] = [];
  let six = 0;
  const [ox, oy, oz] = faces.vertices[0];
  faces.faces.forEach((face, f) => {
    // Newell's normal of the polygon, then its unit form and the plane through its first corner.
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let i = 0; i < face.length; i++) {
      const [x0, y0, z0] = faces.vertices[face[i]],
        [x1, y1, z1] = faces.vertices[face[(i + 1) % face.length]];
      nx += (y0 - y1) * (z0 + z1);
      ny += (z0 - z1) * (x0 + x1);
      nz += (x0 - x1) * (y0 + y1);
    }
    const length = root(nx * nx + ny * ny + nz * nz) || 1,
      [px, py, pz] = faces.vertices[face[0]];
    planes[f * 4] = nx / length;
    planes[f * 4 + 1] = ny / length;
    planes[f * 4 + 2] = nz / length;
    planes[f * 4 + 3] = (nx * px + ny * py + nz * pz) / length;
    for (let i = 1; i + 1 < face.length; i++) {
      triangles.push(face[0], face[i], face[i + 1]);
      const [bx, by, bz] = faces.vertices[face[i]],
        [cx, cy, cz] = faces.vertices[face[i + 1]];
      const ax = px - ox,
        ay = py - oy,
        az = pz - oz,
        ux = bx - ox,
        uy = by - oy,
        uz = bz - oz,
        wx = cx - ox,
        wy = cy - oy,
        wz = cz - oz;
      six += ax * (uy * wz - uz * wy) + ay * (uz * wx - ux * wz) + az * (ux * wy - uy * wx);
    }
  });
  return { points: flat, planes, triangles: Uint32Array.from(triangles), volume: six / 6 };
}

/** Growable typed storage for one side of a cut. */
class Side {
  positions: number[] = [];
  triangles: number[] = [];
  cap: number[] = [];
  /** Cut segments: from edge point key to edge point key, the cap's boundary in its own winding. */
  next = new Map<number, number>();
  vertex(p: Float64Array, i: number): number {
    this.positions.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    return this.positions.length / 3 - 1;
  }
  /** A triangle, unless two of its corners are one vertex (a corner on the plane): that one has no area and no edges. */
  add(a: number, b: number, c: number, tag: number): void {
    if (a === b || b === c || a === c) return;
    this.triangles.push(a, b, c);
    this.cap.push(tag);
  }
  solid(): Solid {
    return new Solid(Float64Array.from(this.positions), Uint32Array.from(this.triangles), Int32Array.from(this.cap));
  }
}

/**
 * Cuts a solid with a plane (section 5, steps a to d): triangles on one side go to that side, a triangle across the
 * plane splits into a triangle and a quad, and each side's cut loops are capped, holes left open. A vertex on the plane
 * counts as positive, the same for every triangle that shares it, so the two sides stay closed.
 * @returns the negative and positive parts, or null when every vertex lies on one side.
 */
export function cut(solid: Solid, plane: Plane, planeId: number): [Solid, Solid] | null {
  const p = solid.positions,
    t = solid.triangles,
    count = p.length / 3,
    [nx, ny, nz] = plane.normal,
    distance = new Float64Array(count);
  let above = 0;
  for (let i = 0; i < count; i++) {
    distance[i] = nx * p[i * 3] + ny * p[i * 3 + 1] + nz * p[i * 3 + 2] - plane.offset;
    if (distance[i] >= 0) above++;
  }
  if (above === 0 || above === count) return null;
  const sides = [new Side(), new Side()],
    maps = [new Int32Array(count).fill(-1), new Int32Array(count).fill(-1)],
    // Edge points by edge key, the same point for both triangles on the edge: [index on side 0, index on side 1].
    edges = new Map<number, [number, number]>();
  const at = (s: number, i: number): number => {
    if (maps[s][i] < 0) maps[s][i] = sides[s].vertex(p, i);
    return maps[s][i];
  };
  const edgeKey = (a: number, b: number): number => (a < b ? a * count + b : b * count + a);
  const edgePoint = (a: number, b: number): [number, number] => {
    const key = edgeKey(a, b);
    let point = edges.get(key);
    // An edge from a vertex on the plane meets it at that vertex: the vertex itself, on both sides.
    const on = distance[a] === 0 ? a : distance[b] === 0 ? b : -1;
    if (!point && on >= 0) edges.set(key, (point = [at(0, on), at(1, on)]));
    if (!point) {
      const lo = a < b ? a : b,
        hi = a < b ? b : a,
        s = distance[lo] / (distance[lo] - distance[hi]);
      const x = p[lo * 3] + s * (p[hi * 3] - p[lo * 3]),
        y = p[lo * 3 + 1] + s * (p[hi * 3 + 1] - p[lo * 3 + 1]),
        z = p[lo * 3 + 2] + s * (p[hi * 3 + 2] - p[lo * 3 + 2]);
      point = [0, 0];
      for (let side = 0; side < 2; side++) {
        sides[side].positions.push(x, y, z);
        point[side] = sides[side].positions.length / 3 - 1;
      }
      edges.set(key, point);
    }
    return point;
  };
  for (let i = 0; i < t.length; i += 3) {
    const v = [t[i], t[i + 1], t[i + 2]],
      s = [distance[v[0]] >= 0 ? 1 : 0, distance[v[1]] >= 0 ? 1 : 0, distance[v[2]] >= 0 ? 1 : 0],
      tag = solid.cap[i / 3];
    if (s[0] === s[1] && s[1] === s[2]) {
      sides[s[0]].add(at(s[0], v[0]), at(s[0], v[1]), at(s[0], v[2]), tag);
      continue;
    }
    // The vertex alone on its side, then the other two in the triangle's winding.
    const k = s[0] !== s[1] && s[0] !== s[2] ? 0 : s[1] !== s[0] && s[1] !== s[2] ? 1 : 2,
      lone = v[k],
      a = v[(k + 1) % 3],
      b = v[(k + 2) % 3],
      ls = s[k],
      os = 1 - ls,
      pa = edgePoint(lone, a),
      pb = edgePoint(lone, b);
    sides[ls].add(at(ls, lone), pa[ls], pb[ls], tag);
    sides[os].add(pa[os], at(os, a), at(os, b), tag);
    sides[os].add(pa[os], at(os, b), pb[os], tag);
    // Each side's cap runs the cut edge against that side's own winding of it.
    const ka = edgeKey(lone, a),
      kb = edgeKey(lone, b);
    sides[ls].next.set(kb, ka);
    sides[os].next.set(ka, kb);
  }
  for (let side = 0; side < 2; side++) {
    // The negative part's cap faces along the normal, the positive part's against it.
    const outward: [number, number, number] = side ? [-nx, -ny, -nz] : [nx, ny, nz];
    capLoops(sides[side], edges, side, outward, 2 * planeId + side);
  }
  const negative = sides[0].solid(),
    positive = sides[1].solid();
  return [negative, positive];
}

/** Chains a side's cut segments into loops and triangulates them in the plane, outer loops with their holes. */
function capLoops(side: Side, edges: Map<number, [number, number]>, index: number, outward: readonly number[], tag: number): void {
  const [ox, oy, oz] = outward,
    // A basis (u, w) of the plane with u x w along the outward normal, so a cap's outer loop runs counter-clockwise.
    ax = ox < 0 ? -ox : ox,
    ay = oy < 0 ? -oy : oy,
    az = oz < 0 ? -oz : oz,
    e = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1],
    u = [oy * e[2] - oz * e[1], oz * e[0] - ox * e[2], ox * e[1] - oy * e[0]],
    w = [oy * u[2] - oz * u[1], oz * u[0] - ox * u[2], ox * u[1] - oy * u[0]],
    p = side.positions;
  const loops: Loop[] = [],
    seen = new Set<number>();
  for (const start of side.next.keys()) {
    if (seen.has(start)) continue;
    const ids: number[] = [];
    let key: number | undefined = start;
    while (key !== undefined && !seen.has(key)) {
      seen.add(key);
      ids.push(edges.get(key)![index]);
      key = side.next.get(key);
    }
    // An open chain means the input was not closed along this cut; it gets no cap.
    if (key !== start) continue;
    const loop: Loop = { ids: [], x: [], y: [], area: 0 };
    for (const id of ids) {
      // Edges that meet the plane at one of its vertices give that vertex once for each.
      if (loop.ids.length && loop.ids[loop.ids.length - 1] === id) continue;
      loop.ids.push(id);
      loop.x.push(p[id * 3] * u[0] + p[id * 3 + 1] * u[1] + p[id * 3 + 2] * u[2]);
      loop.y.push(p[id * 3] * w[0] + p[id * 3 + 1] * w[1] + p[id * 3 + 2] * w[2]);
    }
    if (loop.ids.length > 1 && loop.ids[0] === loop.ids[loop.ids.length - 1]) {
      loop.ids.pop();
      loop.x.pop();
      loop.y.pop();
    }
    if (loop.ids.length < 3) continue;
    loop.area = signedArea(loop.x, loop.y);
    if (loop.area !== 0) loops.push(loop);
  }
  const triangles = triangulate(loops);
  for (let i = 0; i < triangles.length; i += 3) side.add(triangles[i], triangles[i + 1], triangles[i + 2], tag);
}

/** One cut loop in the plane: vertex indices and their plane coordinates. */
export interface Loop {
  ids: number[];
  x: number[];
  y: number[];
  area: number;
}

function signedArea(x: readonly number[], y: readonly number[]): number {
  let twice = 0;
  for (let i = 0, j = x.length - 1; i < x.length; j = i++) twice += x[j] * y[i] - x[i] * y[j];
  return twice / 2;
}

/** Whether (px, py) lies inside a loop, by the crossing number. */
function inside(loop: Loop, px: number, py: number): boolean {
  let odd = false;
  const { x, y } = loop;
  for (let i = 0, j = x.length - 1; i < x.length; j = i++)
    if (y[i] > py !== y[j] > py && px < x[j] + ((py - y[j]) * (x[i] - x[j])) / (y[i] - y[j])) odd = !odd;
  return odd;
}

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Whether segments ab and cd cross at a point inside both. */
function crosses(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross(ax, ay, bx, by, cx, cy),
    d2 = cross(ax, ay, bx, by, dx, dy),
    d3 = cross(cx, cy, dx, dy, ax, ay),
    d4 = cross(cx, cy, dx, dy, bx, by);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Triangles of loops in one plane: counter-clockwise loops are outer, clockwise ones holes, each hole in the smallest
 * outer loop around it. The paper caps by constrained Delaunay triangulation (Shewchuk 1996); a cap's triangles only
 * need to cover it, so here each outer loop takes its holes by a bridge to a vertex it sees and is cut by ear clipping
 * (Meisters, "Polygons have ears", 1975; the bridge as in Eberly, "Triangulation by Ear Clipping", 2002).
 */
export function triangulate(loops: readonly Loop[]): number[] {
  const outer = loops.filter((loop) => loop.area > 0).sort((a, b) => a.area - b.area),
    holes = new Map<Loop, Loop[]>(outer.map((loop) => [loop, []]));
  for (const hole of loops) {
    if (hole.area > 0) continue;
    const home = outer.find((loop) => inside(loop, hole.x[0], hole.y[0]));
    if (home) holes.get(home)!.push(hole);
  }
  const out: number[] = [];
  for (const loop of outer) earClip(bridge(loop, holes.get(loop)!), out);
  return out;
}

/** An outer loop with its holes joined in by bridges, as one polygon (vertices repeat at the bridge ends). */
function bridge(outer: Loop, holes: Loop[]): Loop {
  let polygon: Loop = { ids: [...outer.ids], x: [...outer.x], y: [...outer.y], area: outer.area };
  // Holes with the rightmost vertex first, each joined at that vertex to the nearest vertex it sees.
  const order = holes
    .map((hole) => {
      let best = 0;
      for (let i = 1; i < hole.x.length; i++) if (hole.x[i] > hole.x[best] || (hole.x[i] === hole.x[best] && hole.y[i] < hole.y[best])) best = i;
      return { hole, best };
    })
    .sort((a, b) => b.hole.x[b.best] - a.hole.x[a.best]);
  const pending = order.map(({ hole }) => hole);
  for (const { hole, best } of order) {
    pending.shift();
    const mx = hole.x[best],
      my = hole.y[best],
      n = polygon.x.length;
    const candidates = [...Array(n).keys()].sort((a, b) => {
      const ax = polygon.x[a] - mx,
        ay = polygon.y[a] - my,
        bx = polygon.x[b] - mx,
        by = polygon.y[b] - my,
        da = ax * ax + ay * ay,
        db = bx * bx + by * by;
      return da - db || a - b;
    });
    let join = -1;
    for (const c of candidates) {
      const cx = polygon.x[c],
        cy = polygon.y[c];
      // The bridge leaves the vertex into the polygon: inside its corner between the edges to its neighbours.
      const prev = (c + n - 1) % n,
        next = (c + 1) % n,
        px = polygon.x[prev],
        py = polygon.y[prev],
        qx = polygon.x[next],
        qy = polygon.y[next],
        convex = cross(px, py, cx, cy, qx, qy) >= 0,
        left = cross(cx, cy, qx, qy, mx, my) > 0,
        right = cross(px, py, cx, cy, mx, my) > 0;
      if (convex ? !(left && right) : !(left || right)) continue;
      if (blocked(cx, cy, mx, my, polygon) || [hole, ...pending].some((other) => blocked(cx, cy, mx, my, other))) continue;
      join = c;
      break;
    }
    if (join < 0) continue;
    const loopIds = [...hole.ids.slice(best), ...hole.ids.slice(0, best + 1)],
      loopX = [...hole.x.slice(best), ...hole.x.slice(0, best + 1)],
      loopY = [...hole.y.slice(best), ...hole.y.slice(0, best + 1)];
    polygon = {
      ids: [...polygon.ids.slice(0, join + 1), ...loopIds, ...polygon.ids.slice(join)],
      x: [...polygon.x.slice(0, join + 1), ...loopX, ...polygon.x.slice(join)],
      y: [...polygon.y.slice(0, join + 1), ...loopY, ...polygon.y.slice(join)],
      area: polygon.area + hole.area,
    };
  }
  return polygon;
}

/** Whether segment ab crosses an edge of a loop away from a and b. */
function blocked(ax: number, ay: number, bx: number, by: number, loop: Loop): boolean {
  const { x, y } = loop;
  for (let i = 0, j = x.length - 1; i < x.length; j = i++) if (crosses(ax, ay, bx, by, x[j], y[j], x[i], y[i])) return true;
  return false;
}

/** Ear clipping of one counter-clockwise polygon. */
function earClip(polygon: Loop, out: number[]): void {
  const { ids, x, y } = polygon,
    n = ids.length,
    prev = new Int32Array(n),
    next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  let left = n,
    i = 0,
    stall = 0;
  const clip = (corner: number): void => {
    const a = prev[corner],
      c = next[corner];
    out.push(ids[a], ids[corner], ids[c]);
    next[a] = c;
    prev[c] = a;
    left--;
    stall = 0;
    i = c;
  };
  while (left > 2) {
    if (stall >= left) {
      // A full lap with no ear: rounding has folded the polygon, so its most convex corner goes and every cap closes.
      let best = i,
        most = -Infinity;
      for (let k = 0, j = i; k < left; k++, j = next[j]) {
        const turn = cross(x[prev[j]], y[prev[j]], x[j], y[j], x[next[j]], y[next[j]]);
        if (turn > most) {
          most = turn;
          best = j;
        }
      }
      clip(best);
      continue;
    }
    const a = prev[i],
      c = next[i],
      turn = cross(x[a], y[a], x[i], y[i], x[c], y[c]);
    let ear = turn > 0;
    if (ear)
      for (let j = next[c]; j !== a; j = next[j]) {
        // A vertex at a corner's own position (a bridge end) never blocks it.
        if ((x[j] === x[a] && y[j] === y[a]) || (x[j] === x[i] && y[j] === y[i]) || (x[j] === x[c] && y[j] === y[c])) continue;
        if (cross(x[a], y[a], x[i], y[i], x[j], y[j]) >= 0 && cross(x[i], y[i], x[c], y[c], x[j], y[j]) >= 0 && cross(x[c], y[c], x[a], y[a], x[j], y[j]) >= 0) {
          ear = false;
          break;
        }
      }
    // A corner with no turn is a straight run or a spike: it leaves as a triangle of no area, so every edge keeps a
    // triangle on each side and a later cut across it meets the same edges from both.
    if (ear || turn === 0) clip(i);
    else {
      stall++;
      i = next[i];
    }
  }
}

/** A stream of floats in [0, 1) for sampling. */
export type Random = () => number;

/** Closest squared distance from a point to a triangle, by Ericson, Real-Time Collision Detection (2005), 5.1.5. */
function triangleDistance(p: Float64Array, a: number, b: number, c: number, x: number, y: number, z: number): number {
  const ax = p[a],
    ay = p[a + 1],
    az = p[a + 2];
  const abx = p[b] - ax,
    aby = p[b + 1] - ay,
    abz = p[b + 2] - az,
    acx = p[c] - ax,
    acy = p[c + 1] - ay,
    acz = p[c + 2] - az,
    apx = x - ax,
    apy = y - ay,
    apz = z - az;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax;
    qy = ay;
    qz = az;
  } else {
    const bpx = x - p[b],
      bpy = y - p[b + 1],
      bpz = z - p[b + 2],
      d3 = abx * bpx + aby * bpy + abz * bpz,
      d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = x - p[c],
      cpy = y - p[c + 1],
      cpz = z - p[c + 2],
      d5 = abx * cpx + aby * cpy + abz * cpz,
      d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2,
      vb = d5 * d2 - d1 * d6,
      va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      qx = p[b];
      qy = p[b + 1];
      qz = p[b + 2];
    } else if (d6 >= 0 && d5 <= d6) {
      qx = p[c];
      qy = p[c + 1];
      qz = p[c + 2];
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      qx = ax + v * abx;
      qy = ay + v * aby;
      qz = az + v * abz;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      qx = ax + w * acx;
      qy = ay + w * acy;
      qz = az + w * acz;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = p[b] + w * (p[c] - p[b]);
      qy = p[b + 1] + w * (p[c + 1] - p[b + 1]);
      qz = p[b + 2] + w * (p[c + 2] - p[b + 2]);
    } else {
      const denom = 1 / (va + vb + vc),
        v = vb * denom,
        w = vc * denom;
      qx = ax + abx * v + acx * w;
      qy = ay + aby * v + acy * w;
      qz = az + abz * v + acz * w;
    }
  }
  const dx = x - qx,
    dy = y - qy,
    dz = z - qz;
  // Products, not `**`, which is not promised to round the same everywhere.
  return dx * dx + dy * dy + dz * dz;
}

/** Points sampled evenly on triangles, about `density` per unit area (3,000 in the paper's appendix C). */
function sample(p: Float64Array, t: Uint32Array, density: number, random: Random, emit: (x: number, y: number, z: number) => void): void {
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3,
      b = t[i + 1] * 3,
      c = t[i + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx,
      area = root(cx * cx + cy * cy + cz * cz) / 2,
      count = (area * density + random()) | 0;
    // Every triangle gives its corners too, so a small triangle far from the other surface is never missed.
    emit(p[a], p[a + 1], p[a + 2]);
    for (let k = 0; k < count; k++) {
      const s = root(random()),
        r = random(),
        wb = s * (1 - r),
        wc = s * r;
      emit(p[a] + wb * ux + wc * vx, p[a + 1] + wb * uy + wc * vy, p[a + 2] + wb * uz + wc * vz);
    }
  }
}

/** Triangles bucketed in a grid over their bounds, for nearest-surface searches. */
class Grid {
  readonly cells: number[][];
  readonly res: number;
  readonly lo: number[];
  readonly size: number[];
  readonly stamp: Int32Array;
  #query = 0;
  constructor(
    readonly p: Float64Array,
    readonly t: Uint32Array,
    min: readonly number[],
    max: readonly number[],
  ) {
    const triangles = t.length / 3;
    this.res = Math.max(1, Math.min(48, (cubeRoot(triangles) * 1.5) | 0));
    this.lo = [...min];
    this.size = [0, 1, 2].map((a) => (max[a] - min[a]) / this.res || 1);
    this.cells = Array.from({ length: this.res ** 3 }, () => []);
    this.stamp = new Int32Array(triangles);
    for (let f = 0; f < triangles; f++) {
      const lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++)
        for (let a = 0; a < 3; a++) {
          const v = p[t[f * 3 + k] * 3 + a];
          if (v < lo[a]) lo[a] = v;
          if (v > hi[a]) hi[a] = v;
        }
      const c0 = lo.map((v, a) => this.cell(v, a)),
        c1 = hi.map((v, a) => this.cell(v, a));
      for (let i = c0[0]; i <= c1[0]; i++)
        for (let j = c0[1]; j <= c1[1]; j++) for (let k = c0[2]; k <= c1[2]; k++) this.cells[(i * this.res + j) * this.res + k].push(f);
    }
  }
  cell(v: number, a: number): number {
    const c = ((v - this.lo[a]) / this.size[a]) | 0;
    return c < 0 ? 0 : c >= this.res ? this.res - 1 : c;
  }
  /** The squared distance to the nearest triangle, or any value under `enough` once one is nearer than it. */
  nearest(x: number, y: number, z: number, enough: number): number {
    const q = ++this.#query,
      ci = this.cell(x, 0),
      cj = this.cell(y, 1),
      ck = this.cell(z, 2),
      step = Math.min(this.size[0], this.size[1], this.size[2]);
    let best = Infinity;
    for (let ring = 0; ring < this.res; ring++) {
      // Cells in ring r lie at least (r - 1) cells away from the point.
      const reach = ring > 0 ? (ring - 1) * step : 0;
      if (reach * reach >= best) break;
      for (let i = ci - ring; i <= ci + ring; i++)
        for (let j = cj - ring; j <= cj + ring; j++)
          for (let k = ck - ring; k <= ck + ring; k++) {
            if (i < 0 || j < 0 || k < 0 || i >= this.res || j >= this.res || k >= this.res) continue;
            if (i !== ci - ring && i !== ci + ring && j !== cj - ring && j !== cj + ring && k !== ck - ring && k !== ck + ring) continue;
            for (const f of this.cells[(i * this.res + j) * this.res + k]) {
              if (this.stamp[f] === q) continue;
              this.stamp[f] = q;
              const d = triangleDistance(this.p, this.t[f * 3] * 3, this.t[f * 3 + 1] * 3, this.t[f * 3 + 2] * 3, x, y, z);
              if (d < best) {
                best = d;
                if (best < enough) return best;
              }
            }
          }
    }
    return best;
  }
}

/**
 * Hb (Eq. 2): the Hausdorff distance between points sampled on the solid's surface and on its hull's, each measured to
 * the other surface itself (point to triangle, section 4.2). A point of the solid lies inside its hull, so its distance
 * to the hull's surface is its depth under the nearest face plane.
 */
export function boundaryDistance(solid: Solid, hull: Hull, density: number, random: Random): number {
  let worst = 0;
  const planes = hull.planes,
    faces = planes.length / 4;
  sample(solid.positions, solid.triangles, density, random, (x, y, z) => {
    let depth = Infinity;
    for (let f = 0; f < faces * 4; f += 4) {
      const d = planes[f + 3] - planes[f] * x - planes[f + 1] * y - planes[f + 2] * z;
      if (d < depth) depth = d;
      if (depth <= worst) return;
    }
    if (depth > worst) worst = depth;
  });
  const grid = new Grid(solid.positions, solid.triangles, solid.min, solid.max);
  let worstSquared = worst * worst;
  sample(hull.points, hull.triangles, density, random, (x, y, z) => {
    const d = grid.nearest(x, y, z, worstSquared);
    if (d > worstSquared) worstSquared = d;
  });
  return root(worstSquared);
}

/** Concavity (Eq. 6): max(Hb, k Rv), with k = 0.3 as in appendix C. */
export function concavity(solid: Solid, density: number, random: Random): number {
  const hull = solid.hull();
  if (!hull) return 0;
  const hb = boundaryDistance(solid, hull, density, random),
    rv = 0.3 * solid.rv();
  return hb > rv ? hb : rv;
}
