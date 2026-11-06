// @margoengine/mesh-edit/boolean-exact: booleans whose every decision is exact. Inputs are float64, so each coordinate
// is an exact integer in one shared power-of-two scale. Faces become triangles with exact integer planes and every
// polygon is stored as a support plane plus bounding planes (Sugihara and Iri, 1989; Bernstein and Fussell, 2009): a
// cut adds a plane, never a rounded point, so numbers never grow with the number of cuts. Side tests run in float64
// with a proven error bound and fall back to BigInt only when the bound cannot decide.
import { MargoError, type MutableVec2, type MutableVec3 } from '@margoengine/math';
import {
  assertSolid,
  type BooleanLoop,
  finishBoolean,
  type MeshBooleanFaceSource,
  type MeshBooleanOperation,
  type MeshBooleanResult,
  mergeGroup,
} from './boolean.js';
import { assertOptions } from './edit-support.js';
import { dominantAxis, faceGeometryError, newellNormal } from './polygon.js';
import { convexLoopPieces } from './polygon-split.js';
import type { PolygonMesh } from './types.js';

export type { MeshBooleanFaceSource, MeshBooleanOperation };

/** Options for {@link booleanMeshesExact}. */
export interface ExactBooleanOptions {
  /** Face ID generator for faces that need a new ID (default `crypto.randomUUID`). */
  createId?: () => string;
  /** Checked as the work goes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Result of {@link booleanMeshesExact}. */
export interface ExactBooleanResult extends MeshBooleanResult {
  /** Faces of the exact result too thin to exist as a valid float64 face, folded away after rounding. */
  collapsedFaces: number;
}

/** Plane a x + b y + c z + d = 0 in the shared integer scale, with a float copy for the filter. */
interface Plane {
  a: bigint;
  b: bigint;
  c: bigint;
  d: bigint;
  fa: number;
  fb: number;
  fc: number;
  fd: number;
  /** The same plane facing the other way; only interned face planes have one. */
  flip: Plane | null;
}

/** Exact homogeneous point (X / W, Y / W, Z / W) with W > 0, and its float copy in caller units. */
interface Point {
  X: bigint;
  Y: bigint;
  Z: bigint;
  W: bigint;
  x: number;
  y: number;
  z: number;
  id: number;
}

/** The input triangle a polygon lies in: its integer corners, UVs and source face. */
interface Source {
  corners: bigint[][];
  uv: readonly (readonly number[])[];
  axis: number;
  input: 0 | 1;
  face: string;
}

/** A strictly convex polygon: support plane, corners, and the plane through each edge (corner i to i + 1). */
interface Poly {
  support: Plane;
  points: Point[];
  edges: Plane[];
  source: Source;
}

/** A polygon as exact vertex IDs. */
interface ExactLoop {
  ids: number[];
  source: Source;
}

/** Exact points on one line that carries unmatched edges, in order along it. */
interface Line {
  axis: number;
  ids: Set<number>;
  sorted: number[];
  order: Map<number, number>;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

function gcd(p: bigint, q: bigint): bigint {
  let a = abs(p),
    b = abs(q);
  while (b) [a, b] = [b, a % b];
  return a;
}

const bits = (n: bigint): number => abs(n).toString(16).length * 4;

/** x * 2^e without overflow in the scaling factor. */
function ldexp(x: number, e: number): number {
  let value = x,
    rest = e;
  while (rest > 1000) {
    value *= 2 ** 1000;
    rest -= 1000;
  }
  while (rest < -1000) {
    value *= 2 ** -1000;
    rest += 1000;
  }
  return value * 2 ** rest;
}

/** n / d * 2^e as a float64, relative error under 2^-52, the same every time for the same reduced n and d. */
function ratio(n: bigint, d: bigint, e: number): number {
  if (!n) return 0;
  const shift = 72 - (bits(n) - bits(d)),
    q = shift >= 0 ? (n << BigInt(shift)) / d : n / (d << BigInt(-shift));
  return ldexp(Number(q), e - shift);
}

const view = new DataView(new ArrayBuffer(8));

/** A finite float as integer * 2^exponent, the integer odd (zero has exponent Infinity). */
function decompose(x: number): { m: bigint; e: number } {
  if (x === 0) return { m: 0n, e: Infinity };
  view.setFloat64(0, x);
  const hi = view.getUint32(0),
    biased = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4)),
    e = -1074;
  if (biased) {
    m |= 1n << 52n;
    e = biased - 1075;
  }
  while (!(m & 1n)) {
    m >>= 1n;
    e++;
  }
  return { m: hi >>> 31 ? -m : m, e };
}

const cross = (u: bigint[], v: bigint[]): bigint[] => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

const sub = (u: bigint[], v: bigint[]): bigint[] => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];

const dot = (u: bigint[], v: bigint[]): bigint => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/** Float filter bound: 2^-48 is over twice the worst rounding of four products of inputs good to 2^-52. */
const FILTER = 2 ** -48,
  FILTER_FLOOR = 2 ** -1000;

/** Planes and points in one integer scale: caller value = integer * 2^exponent. */
class Space {
  readonly planes = new Map<string, Plane>();

  constructor(readonly exponent: number) {}

  plane(a: bigint, b: bigint, c: bigint, d: bigint): Plane {
    const top = Math.max(bits(a), bits(b), bits(c));
    return {
      a,
      b,
      c,
      d,
      fa: ratio(a, 1n, -top),
      fb: ratio(b, 1n, -top),
      fc: ratio(c, 1n, -top),
      fd: ratio(d, 1n, this.exponent - top),
      flip: null,
    };
  }

  /** The one object for this face plane, so coplanar faces compare by identity. */
  facePlane(normal: bigint[], d: bigint): Plane {
    const g = gcd(gcd(gcd(normal[0], normal[1]), normal[2]), d),
      n = normal.map((x) => x / g),
      w = d / g,
      sign = n.find((x) => x !== 0n)! < 0n ? -1n : 1n,
      key = [...n, w].map((x) => (x * sign).toString(16)).join(',');
    let up = this.planes.get(key);
    if (!up) {
      up = this.plane(n[0] * sign, n[1] * sign, n[2] * sign, w * sign);
      up.flip = this.plane(-up.a, -up.b, -up.c, -up.d);
      up.flip.flip = up;
      this.planes.set(key, up);
    }
    return sign > 0n ? up : up.flip!;
  }

  point(X: bigint, Y: bigint, Z: bigint, W: bigint): Point {
    return {
      X,
      Y,
      Z,
      W,
      x: ratio(X, W, this.exponent),
      y: ratio(Y, W, this.exponent),
      z: ratio(Z, W, this.exponent),
      id: -1,
    };
  }

  /** Which side of `h` point `p` is on: 1, -1 or exactly 0. */
  side(h: Plane, p: Point): number {
    const ax = h.fa * p.x,
      by = h.fb * p.y,
      cz = h.fc * p.z,
      value = ax + by + cz + h.fd,
      bound = (Math.abs(ax) + Math.abs(by) + Math.abs(cz) + Math.abs(h.fd)) * FILTER + FILTER_FLOOR;
    if (value > bound) return 1;
    if (value < -bound) return -1;
    const exact = h.a * p.X + h.b * p.Y + h.c * p.Z + h.d * p.W;
    return exact > 0n ? 1 : exact < 0n ? -1 : 0;
  }

  /** The point where three independent planes meet (Cramer's rule). */
  meet(p: Plane, q: Plane, r: Plane): Point {
    const n1 = [p.a, p.b, p.c],
      n2 = [q.a, q.b, q.c],
      n3 = [r.a, r.b, r.c],
      u = cross(n2, n3),
      v = cross(n3, n1),
      w = cross(n1, n2),
      det = dot(n1, u),
      X = -(p.d * u[0] + q.d * v[0] + r.d * w[0]),
      Y = -(p.d * u[1] + q.d * v[1] + r.d * w[1]),
      Z = -(p.d * u[2] + q.d * v[2] + r.d * w[2]);
    return det < 0n ? this.point(-X, -Y, -Z, -det) : this.point(X, Y, Z, det);
  }

  /** Sort `poly` against `h` into the lists; a polygon in `h` goes to `coFront` or `coBack` by facing. */
  split(h: Plane, poly: Poly, coFront: Poly[], coBack: Poly[], front: Poly[], back: Poly[]): void {
    if (poly.support === h) {
      coFront.push(poly);
      return;
    }
    if (poly.support === h.flip) {
      coBack.push(poly);
      return;
    }
    const { points, edges, support } = poly,
      n = points.length,
      signs = points.map((p) => this.side(h, p));
    if (!signs.includes(-1)) {
      front.push(poly);
      return;
    }
    if (!signs.includes(1)) {
      back.push(poly);
      return;
    }
    const fp: Point[] = [],
      fe: Plane[] = [],
      bp: Point[] = [],
      be: Plane[] = [];
    for (let i = 0; i < n; i++) {
      const s = signs[i],
        t = signs[(i + 1) % n],
        e = edges[i];
      if (s >= 0) {
        fp.push(points[i]);
        fe.push(s === 0 && t < 0 ? h : e);
      }
      if (s <= 0) {
        bp.push(points[i]);
        be.push(s === 0 && t > 0 ? h : e);
      }
      if (s * t < 0) {
        const cut = this.meet(support, e, h);
        fp.push(cut);
        bp.push(cut);
        fe.push(s > 0 ? h : e);
        be.push(s > 0 ? e : h);
      }
    }
    front.push({ ...poly, points: fp, edges: fe });
    back.push({ ...poly, points: bp, edges: be });
  }
}

function flipPoly(poly: Poly): void {
  const n = poly.points.length;
  poly.edges = poly.points.map((_, i) => poly.edges[(2 * n - 2 - i) % n]);
  poly.points = [...poly.points].reverse();
  poly.support = poly.support.flip!;
}

/** Of a few candidate planes, the one splitting the fewest of a sample of polygons. Only speed rides on this float guess. */
function choosePlane(polys: Poly[]): Plane {
  const candidates =
      polys.length <= 8 ? polys : Array.from({ length: 8 }, (_, i) => polys[Math.floor((i * polys.length) / 8)]),
    stride = Math.max(1, Math.floor(polys.length / 256));
  let best = candidates[0].support,
    bestScore = Infinity;
  for (const { support: h } of candidates) {
    let spans = 0,
      front = 0,
      back = 0;
    for (let i = 0; i < polys.length; i += stride) {
      let above = false,
        below = false;
      for (const p of polys[i].points) {
        const t = h.fa * p.x + h.fb * p.y + h.fc * p.z + h.fd;
        above ||= t > 0;
        below ||= t < 0;
      }
      if (above && below) spans++;
      else if (above) front++;
      else if (below) back++;
    }
    const score = spans * 8 + Math.abs(front - back);
    if (score < bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

/** A solid BSP tree (Thibault and Naylor, 1987) of exact polygons. */
class Tree {
  plane: Plane | null = null;
  front: Tree | null = null;
  back: Tree | null = null;
  polygons: Poly[] = [];

  invert(): void {
    const stack: Tree[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      for (const poly of node.polygons) flipPoly(poly);
      if (node.plane) node.plane = node.plane.flip;
      [node.front, node.back] = [node.back, node.front];
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  /** Remove the parts of `polygons` inside this solid. */
  clipPolygons(space: Space, polygons: Poly[], tick: () => void): Poly[] {
    const out: Poly[] = [],
      stack: { node: Tree; polys: Poly[] }[] = [{ node: this, polys: polygons }];
    while (stack.length) {
      const { node, polys } = stack.pop()!;
      tick();
      if (!node.plane) {
        out.push(...polys);
        continue;
      }
      const front: Poly[] = [],
        back: Poly[] = [];
      for (const poly of polys) space.split(node.plane, poly, front, back, front, back);
      if (node.front) stack.push({ node: node.front, polys: front });
      else out.push(...front);
      if (node.back) stack.push({ node: node.back, polys: back });
    }
    return out;
  }

  clipTo(space: Space, other: Tree, tick: () => void): void {
    const stack: Tree[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      node.polygons = other.clipPolygons(space, node.polygons, tick);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  all(): Poly[] {
    const out: Poly[] = [],
      stack: Tree[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      out.push(...node.polygons);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
    return out;
  }

  build(space: Space, polygons: Poly[], tick: () => void): void {
    const stack: { node: Tree; polys: Poly[] }[] = [{ node: this, polys: polygons }];
    while (stack.length) {
      const { node, polys } = stack.pop()!;
      tick();
      if (!polys.length) continue;
      node.plane ??= choosePlane(polys);
      const front: Poly[] = [],
        back: Poly[] = [];
      for (const poly of polys) space.split(node.plane, poly, node.polygons, node.polygons, front, back);
      if (front.length) {
        node.front ??= new Tree();
        stack.push({ node: node.front, polys: front });
      }
      if (back.length) {
        node.back ??= new Tree();
        stack.push({ node: node.back, polys: back });
      }
    }
  }
}

/** Corner triples covering a face, by exact ear clipping in its dominant projection. */
function earClip(corners: bigint[][], axis: number, flipped: boolean): number[][] {
  const u = axis === 0 ? 1 : 0,
    v = axis === 2 ? 1 : 2,
    orient = (p: number, q: number, r: number): bigint => {
      const value =
        (corners[q][u] - corners[p][u]) * (corners[r][v] - corners[p][v]) -
        (corners[q][v] - corners[p][v]) * (corners[r][u] - corners[p][u]);
      return flipped ? -value : value;
    },
    ring = corners.map((_, i) => i),
    out: number[][] = [];
  while (ring.length > 3) {
    let cut = -1;
    for (let i = 0; i < ring.length && cut < 0; i++) {
      const p = ring[(i + ring.length - 1) % ring.length],
        q = ring[i],
        r = ring[(i + 1) % ring.length];
      if (orient(p, q, r) <= 0n) continue;
      const blocked = ring.some(
        (k) => k !== p && k !== q && k !== r && orient(p, q, k) >= 0n && orient(q, r, k) >= 0n && orient(r, p, k) >= 0n,
      );
      if (!blocked) cut = i;
    }
    // Only a face folded by rounding has no ear; a fan still covers it with a closed set of triangles.
    if (cut < 0) cut = 1;
    out.push([ring[(cut + ring.length - 1) % ring.length], ring[cut], ring[(cut + 1) % ring.length]]);
    ring.splice(cut, 1);
  }
  out.push(ring);
  return out;
}

/** Exact polygons of one input: every face as triangles, each with its own exact plane. */
function polysOf(space: Space, mesh: PolygonMesh, ints: bigint[][], input: 0 | 1): Poly[] {
  const points = ints.map((p) => space.point(p[0], p[1], p[2], 1n)),
    polys: Poly[] = [];
  for (const face of mesh.faces) {
    const corners = face.vertices.map((v) => ints[v]),
      normal = newellNormal(face.vertices.map((v) => mesh.vertices[v])),
      drop = dominantAxis(normal),
      triples = corners.length === 3 ? [[0, 1, 2]] : earClip(corners, drop, normal[drop] * (drop === 1 ? -1 : 1) < 0);
    for (const [i, j, k] of triples) {
      const n = cross(sub(corners[j], corners[i]), sub(corners[k], corners[i]));
      if (!n[0] && !n[1] && !n[2]) continue;
      const axis = abs(n[0]) >= abs(n[1]) && abs(n[0]) >= abs(n[2]) ? 0 : abs(n[1]) >= abs(n[2]) ? 1 : 2,
        trio = [corners[i], corners[j], corners[k]],
        unit = [0n, 0n, 0n];
      unit[axis] = 1n;
      polys.push({
        support: space.facePlane(n, -dot(n, corners[i])),
        points: [i, j, k].map((c) => points[face.vertices[c]]),
        // Through each edge and parallel to the dominant axis: never the face's own plane, and with small numbers.
        edges: trio.map((p, c) => {
          const m = cross(sub(trio[(c + 1) % 3], p), unit);
          return space.plane(m[0], m[1], m[2], -dot(m, p));
        }),
        source: { corners: trio, uv: [face.uv[i], face.uv[j], face.uv[k]], axis, input, face: face.id },
      });
    }
  }
  return polys;
}

/** Each undirected edge's count of uses one way minus the other; zero counts are left out. */
function edgeBalance(loops: readonly ExactLoop[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { ids } of loops)
    ids.forEach((p, i) => {
      const q = ids[(i + 1) % ids.length],
        key = p < q ? `${p}:${q}` : `${q}:${p}`;
      counts.set(key, (counts.get(key) ?? 0) + (p < q ? 1 : -1));
    });
  for (const [key, count] of counts) if (!count) counts.delete(key);
  return counts;
}

/** The line through two exact points, as reduced Pluecker coordinates, and an axis it advances along. */
function lineThrough(P: bigint[], Q: bigint[]): { key: string; axis: number } {
  const direction = [0, 1, 2].map((k) => Q[k] * P[3] - P[k] * Q[3]),
    all = [...direction, ...cross(P, Q)],
    g = all.reduce((x, y) => gcd(x, y), 0n),
    sign = all.find((x) => x !== 0n)! < 0n ? -g : g;
  return { key: all.map((x) => (x / sign).toString(16)).join(','), axis: direction.findIndex((x) => x !== 0n) };
}

/** Cancel each edge against its reverse; what is left are T-junctions. Split those edges at every point on their line. */
function closeJunctions(loops: ExactLoop[], exact: bigint[][], tick: () => void): void {
  const open = edgeBalance(loops);
  if (!open.size) return;
  const lines = new Map<string, Line>(),
    lineOfEdge = new Map<string, Line>();
  for (const key of open.keys()) {
    const [p, q] = key.split(':').map(Number),
      { key: lineKey, axis } = lineThrough(exact[p], exact[q]);
    let line = lines.get(lineKey);
    if (!line) {
      line = { axis, ids: new Set(), sorted: [], order: new Map() };
      lines.set(lineKey, line);
    }
    line.ids.add(p).add(q);
    lineOfEdge.set(key, line);
  }
  for (const line of lines.values()) {
    const { axis } = line;
    line.sorted = [...line.ids].sort((p, q) => {
      const value = exact[p][axis] * exact[q][3] - exact[q][axis] * exact[p][3];
      return value < 0n ? -1 : value > 0n ? 1 : 0;
    });
    line.order = new Map(line.sorted.map((id, i) => [id, i]));
  }
  for (const loop of loops) {
    tick();
    const out: number[] = [],
      { ids } = loop;
    ids.forEach((p, i) => {
      const q = ids[(i + 1) % ids.length],
        line = lineOfEdge.get(p < q ? `${p}:${q}` : `${q}:${p}`);
      out.push(p);
      if (!line) return;
      const from = line.order.get(p)!,
        to = line.order.get(q)!;
      if (from < to) out.push(...line.sorted.slice(from + 1, to));
      else out.push(...line.sorted.slice(to + 1, from).reverse());
    });
    loop.ids = out;
  }
  if (edgeBalance(loops).size)
    throw new MargoError(
      'failed',
      'Exact boolean result is not closed, so an input intersects itself; separate the crossing parts of that input first.',
    );
}

/** UV of an exact point from the affine map of its source triangle, by exact barycentric coordinates. */
function exactUV(source: Source, P: bigint[]): MutableVec2 {
  const u = source.axis === 0 ? 1 : 0,
    v = source.axis === 2 ? 1 : 2,
    [a, b, c] = source.corners,
    W = P[3],
    pu = P[u] - a[u] * W,
    pv = P[v] - a[v] * W,
    bu = b[u] - a[u],
    bv = b[v] - a[v],
    cu = c[u] - a[u],
    cv = c[v] - a[v],
    area = (bu * cv - bv * cu) * W,
    s = ratio(pu * cv - pv * cu, area, 0),
    t = ratio(bu * pv - bv * pu, area, 0),
    [ua, ub, uc] = source.uv;
  return [
    Math.min(1, Math.max(0, ua[0] + (ub[0] - ua[0]) * s + (uc[0] - ua[0]) * t)),
    Math.min(1, Math.max(0, ua[1] + (ub[1] - ua[1]) * s + (uc[1] - ua[1]) * t)),
  ];
}

/** Rebuild `loop` over `find`, cutting it wherever a corner repeats. Two-corner pieces are an edge and its reverse. */
function simplifyLoop(loop: BooleanLoop, find: (v: number) => number, out: BooleanLoop[]): void {
  const vs: number[] = [],
    uvs: MutableVec2[] = [],
    seen = new Map<number, number>(),
    emit = (vertices: number[], uv: MutableVec2[]) => {
      if (vertices.length >= 3) out.push({ ...loop, vertices, uv });
    };
  loop.vertices.forEach((raw, i) => {
    const v = find(raw),
      at = seen.get(v);
    if (at === undefined) {
      seen.set(v, vs.length);
      vs.push(v);
      uvs.push(loop.uv[i]);
      return;
    }
    const tail = vs.splice(at + 1),
      tailUV = uvs.splice(at + 1);
    for (const w of tail) seen.delete(w);
    emit([v, ...tail], [uvs[at], ...tailUV]);
  });
  emit(vs, uvs);
}

const distance = (p: readonly number[], q: readonly number[]): number =>
  Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** The tolerance {@link faceGeometryError} applies to these corners. */
function validityEpsilon(points: readonly MutableVec3[]): number {
  let extent = 0,
    size = 0;
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      extent = Math.max(extent, Math.abs(p[k] - points[0][k]));
      size = Math.max(size, Math.abs(p[k]));
    }
  return Math.max(1e-9, (size * Number.EPSILON * 8) / extent);
}

/** Rounds of folding before a face that still will not fold just merges its shortest edge. */
const FOLD_ROUNDS = 64;

/** Triangles covering a loop too warped to be one face: each step cuts the fattest ear, so thin ones come last. */
function fattestEars(points: readonly MutableVec3[]): number[][] {
  const normal = newellNormal(points),
    ring = points.map((_, i) => i),
    out: number[][] = [],
    quality = (p: number, q: number, r: number): number => {
      const P = points[p],
        u = [points[q][0] - P[0], points[q][1] - P[1], points[q][2] - P[2]],
        v = [points[r][0] - P[0], points[r][1] - P[1], points[r][2] - P[2]],
        area =
          normal[0] * (u[1] * v[2] - u[2] * v[1]) +
          normal[1] * (u[2] * v[0] - u[0] * v[2]) +
          normal[2] * (u[0] * v[1] - u[1] * v[0]),
        longest = Math.max(distance(P, points[q]), distance(points[q], points[r]), distance(points[r], P));
      return area / (longest * longest);
    };
  while (ring.length > 3) {
    let best = 0,
      bestQuality = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[(i + ring.length - 1) % ring.length],
        q = ring[i],
        r = ring[(i + 1) % ring.length],
        value = quality(p, q, r);
      if (value <= bestQuality) continue;
      const blocked = ring.some(
        (k) => k !== p && k !== q && k !== r && quality(p, q, k) > 0 && quality(q, r, k) > 0 && quality(r, p, k) > 0,
      );
      if (blocked) continue;
      best = i;
      bestQuality = value;
    }
    out.push([ring[(best + ring.length - 1) % ring.length], ring[best], ring[(best + 1) % ring.length]]);
    ring.splice(best, 1);
  }
  out.push(ring);
  return out;
}

/** A loop's chord (its two farthest corners, near enough), the position of each corner along it and the greatest height off it. */
function chordOf(points: readonly MutableVec3[]): { length: number; along: number[]; height: number } {
  const farthest = (from: readonly number[]): readonly number[] =>
      points.reduce((best, p) => (distance(from, p) > distance(from, best) ? p : best), points[0]),
    start = farthest(points[0]),
    end = farthest(start),
    length = distance(start, end),
    d = [end[0] - start[0], end[1] - start[1], end[2] - start[2]].map((x) => x / length);
  let height = 0;
  const along = points.map((p) => {
    const r = [p[0] - start[0], p[1] - start[1], p[2] - start[2]],
      t = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
    height = Math.max(height, Math.hypot(r[0] - t * d[0], r[1] - t * d[1], r[2] - t * d[2]));
    return t;
  });
  return { length, along, height };
}

/**
 * Rounding to float64 can leave faces too thin to be valid. Fold them away with moves that keep every edge matched by
 * its reverse: a very short edge merges its ends; a loop lying along one line vanishes, and each corner goes into the
 * face across the edge that passes it; a loop that is merely warped becomes triangles. Merging and folding remove
 * vertices or faces, and warped loops only ever become valid triangles or thin ones, so the loop ends.
 */
function repairLoops(
  start: BooleanLoop[],
  vertices: MutableVec3[],
  tick: () => void,
): { loops: BooleanLoop[]; collapsed: number } {
  let loops = start,
    collapsed = 0;
  const parent = vertices.map((_, i) => i),
    find = (v: number): number => {
      let root = v;
      while (parent[root] !== root) root = parent[root];
      return root;
    };
  for (let round = 0; ; round++) {
    tick();
    const bad: number[] = [];
    loops.forEach((loop, i) => {
      if (loop.vertices.length > 64 || faceGeometryError(vertices, loop.vertices)) bad.push(i);
    });
    if (!bad.length) return { loops, collapsed };
    const owner = new Map<string, number>(),
      touched = new Set<number>(),
      next: (BooleanLoop | null)[] = [...loops],
      extra: BooleanLoop[] = [];
    loops.forEach((loop, i) => {
      loop.vertices.forEach((p, c) => {
        owner.set(`${p}>${loop.vertices[(c + 1) % loop.vertices.length]}`, i);
      });
    });
    for (const i of bad) {
      if (touched.has(i)) continue;
      const loop = next[i]!,
        { vertices: vs } = loop,
        n = vs.length,
        corners = vs.map((v) => vertices[v]),
        snap = 4 * validityEpsilon(corners),
        { length, along, height } = chordOf(corners),
        sides = corners.map((p, c) => distance(p, corners[(c + 1) % n])),
        shortest = sides.indexOf(Math.min(...sides));
      if (sides[shortest] <= snap * length || round >= FOLD_ROUNDS) {
        const x = find(vs[shortest]),
          y = find(vs[(shortest + 1) % n]);
        parent[Math.max(x, y)] = Math.min(x, y);
        touched.add(i);
        collapsed++;
        continue;
      }
      if (height > snap * length && n > 3) {
        touched.add(i);
        next[i] = null;
        const pieces = convexLoopPieces(corners),
          valid = pieces?.every((piece) => !faceGeometryError(corners, piece));
        for (const piece of pieces && valid ? pieces : fattestEars(corners))
          extra.push({ ...loop, vertices: piece.map((c) => vs[c]), uv: piece.map((c) => loop.uv[c]) });
        continue;
      }
      // Fold: every edge of this loop is replaced, in the face across it, by the path through the corners it passes.
      const across = vs.map((p, c) => owner.get(`${vs[(c + 1) % n]}>${p}`));
      if (across.some((j) => j === undefined || j === i || touched.has(j))) continue;
      // Ranks, not positions: two corners level with each other still need one agreed order.
      const order = vs.map((_, c) => c).sort((p, q) => along[p] - along[q]),
        rank: number[] = [];
      order.forEach((c, r) => {
        rank[c] = r;
      });
      vs.forEach((p, c) => {
        const to = (c + 1) % n,
          j = across[c]!,
          neighbor = next[j]!,
          q = vs[to],
          size = neighbor.vertices.length,
          at = neighbor.vertices.findIndex((v, k) => v === q && neighbor.vertices[(k + 1) % size] === p),
          passed = order.slice(Math.min(rank[c], rank[to]) + 1, Math.max(rank[c], rank[to]));
        if (!passed.length) return;
        if (rank[to] > rank[c]) passed.reverse();
        const ua = neighbor.uv[at],
          ub = neighbor.uv[(at + 1) % size],
          span = along[c] - along[to];
        next[j] = {
          ...neighbor,
          vertices: [
            ...neighbor.vertices.slice(0, at + 1),
            ...passed.map((k) => vs[k]),
            ...neighbor.vertices.slice(at + 1),
          ],
          uv: [
            ...neighbor.uv.slice(0, at + 1),
            ...passed.map((k): MutableVec2 => {
              const t = span ? (along[k] - along[to]) / span : 0.5;
              return [ua[0] + (ub[0] - ua[0]) * t, ua[1] + (ub[1] - ua[1]) * t];
            }),
            ...neighbor.uv.slice(at + 1),
          ],
        };
      });
      for (const j of across) touched.add(j!);
      touched.add(i);
      next[i] = null;
      collapsed++;
    }
    const rebuilt: BooleanLoop[] = [];
    for (const loop of [...next, ...extra]) if (loop) simplifyLoop(loop, find, rebuilt);
    loops = rebuilt;
  }
}

/** Remove pairs of faces with the same corners in opposite order: a fin of no thickness left by folding. */
function cancelFins(loops: BooleanLoop[]): BooleanLoop[] {
  const keyOf = (vs: readonly number[]): string => {
      const start = vs.indexOf(Math.min(...vs));
      return [...vs.slice(start), ...vs.slice(0, start)].join(',');
    },
    live = new Map<string, number[]>(),
    drop = new Set<number>();
  loops.forEach((loop, i) => {
    const twin = live.get(keyOf([...loop.vertices].reverse()));
    if (twin?.length) {
      drop.add(twin.pop()!);
      drop.add(i);
      return;
    }
    const key = keyOf(loop.vertices),
      list = live.get(key);
    if (list) list.push(i);
    else live.set(key, [i]);
  });
  return drop.size ? loops.filter((_, i) => !drop.has(i)) : loops;
}

/** Count edges joining more than two faces, and check every half-edge has its reverse as often. */
function closedNonManifoldEdges(loops: readonly BooleanLoop[]): number {
  const half = new Map<string, number>();
  for (const { vertices: vs } of loops)
    vs.forEach((p, i) => {
      const k = `${p}>${vs[(i + 1) % vs.length]}`;
      half.set(k, (half.get(k) ?? 0) + 1);
    });
  let nonManifold = 0;
  for (const [k, count] of half) {
    const [p, q] = k.split('>').map(Number);
    if (half.get(`${q}>${p}`) !== count)
      throw new MargoError(
        'failed',
        'Exact boolean result is not closed after rounding, which is a Margo bug; report the two input meshes.',
      );
    if (count > 1 && p < q) nonManifold++;
  }
  return nonManifold;
}

/** Exact integer coordinates for both meshes in one power-of-two scale. */
function integerCoordinates(meshes: readonly PolygonMesh[]): { ints: bigint[][][]; exponent: number } {
  const parts = meshes.map((mesh) => mesh.vertices.map((p) => p.map(decompose)));
  let exponent = Infinity;
  for (const part of parts) for (const p of part) for (const { e } of p) exponent = Math.min(exponent, e);
  if (exponent === Infinity) exponent = 0;
  return {
    ints: parts.map((part) => part.map((p) => p.map(({ m, e }) => (m ? m << BigInt(e - exponent) : 0n)))),
    exponent,
  };
}

/** Run the boolean on the two trees and return the surviving polygons. */
function clipTrees(space: Space, A: Tree, B: Tree, operation: MeshBooleanOperation, tick: () => void): Poly[] {
  const clip = (x: Tree, y: Tree) => x.clipTo(space, y, tick);
  if (operation === 'union') {
    clip(A, B);
    clip(B, A);
    B.invert();
    clip(B, A);
    B.invert();
  } else if (operation === 'difference') {
    A.invert();
    clip(A, B);
    clip(B, A);
    B.invert();
    clip(B, A);
    A.invert();
  } else {
    A.invert();
    clip(B, A);
    B.invert();
    clip(A, B);
    clip(B, A);
    A.invert();
    B.invert();
  }
  return [...A.all(), ...B.all()];
}

/**
 * Boolean of two closed solids with exact decisions, so nearly coincident faces, edges and vertices never fail and
 * never need nudging: `union`, `difference` (`a` minus `b`) or `intersection`. Every side test is exact (a float64
 * filter with a proven bound, then BigInt), and no cut point is rounded until the end, so the result's topology is
 * the true one for the given float64 coordinates. Only then are corners rounded to float64; faces thinner than a
 * valid face (about 1e-9 of their length) fold away and are counted in `collapsedFaces`. The returned mesh is always
 * closed and passes every mesh-edit check.
 *
 * Inputs must be closed, consistently wound, outward facing and free of self-intersection. Output faces keep source
 * IDs and interpolate UVs as `booleanMeshes` does.
 * @throws TypeError for an input that is not a closed, outward, consistently wound mesh, or bad options; MargoError
 * `failed` when an input intersects itself; the signal's reason when aborted.
 */
export function booleanMeshesExact(
  a: PolygonMesh,
  b: PolygonMesh,
  operation: MeshBooleanOperation,
  options: ExactBooleanOptions = {},
): ExactBooleanResult {
  if (operation !== 'union' && operation !== 'difference' && operation !== 'intersection')
    throw new TypeError("Boolean operation must be 'union', 'difference' or 'intersection'; choose one.");
  assertOptions(options, 'Exact boolean');
  assertSolid(a, 'a');
  assertSolid(b, 'b');
  if (options.createId !== undefined && typeof options.createId !== 'function')
    throw new TypeError('Exact boolean createId must be a function; supply a generator or omit it.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Exact boolean signal must be an AbortSignal; pass controller.signal or omit it.');
  const signal = options.signal;
  let ticks = 0;
  const tick = () => {
    if (signal && ++ticks % 256 === 0) signal.throwIfAborted();
  };
  signal?.throwIfAborted();
  const { ints, exponent } = integerCoordinates([a, b]),
    space = new Space(exponent),
    A = new Tree(),
    B = new Tree();
  A.build(space, polysOf(space, a, ints[0], 0), tick);
  B.build(space, polysOf(space, b, ints[1], 1), tick);
  // Number the distinct exact points: reduced homogeneous coordinates are one string per point.
  const exact: bigint[][] = [],
    ids = new Map<string, number>(),
    idOf = (p: Point): number => {
      if (p.id >= 0) return p.id;
      const g = p.W === 1n ? 1n : gcd(gcd(gcd(p.X, p.Y), p.Z), p.W),
        reduced = [p.X / g, p.Y / g, p.Z / g, p.W / g],
        key = reduced.map((x) => x.toString(16)).join(',');
      let id = ids.get(key);
      if (id === undefined) {
        id = exact.length;
        ids.set(key, id);
        exact.push(reduced);
      }
      p.id = id;
      return id;
    },
    exactLoops: ExactLoop[] = clipTrees(space, A, B, operation, tick).map((poly) => ({
      ids: poly.points.map(idOf),
      source: poly.source,
    }));
  closeJunctions(exactLoops, exact, tick);
  // Round: exact points that round to one float64 point become one vertex.
  const vertices: MutableVec3[] = [],
    rounded = new Map<string, number>(),
    vertexOf = exact.map((P) => {
      const x = ratio(P[0], P[3], exponent) + 0,
        y = ratio(P[1], P[3], exponent) + 0,
        z = ratio(P[2], P[3], exponent) + 0,
        key = `${x},${y},${z}`;
      let v = rounded.get(key);
      if (v === undefined) {
        v = vertices.length;
        rounded.set(key, v);
        vertices.push([x, y, z]);
      }
      return v;
    }),
    start: BooleanLoop[] = [];
  for (const { ids: corners, source } of exactLoops)
    simplifyLoop(
      {
        vertices: corners.map((id) => vertexOf[id]),
        uv: corners.map((id) => exactUV(source, exact[id])),
        input: source.input,
        face: source.face,
      },
      (v) => v,
      start,
    );
  const { loops: repaired, collapsed } = repairLoops(start, vertices, tick),
    loops = cancelFins(repaired),
    nonManifold = closedNonManifoldEdges(loops),
    groups = new Map<string, BooleanLoop[]>();
  for (const loop of loops) {
    const k = `${loop.input}|${loop.face}`,
      list = groups.get(k);
    if (list) list.push(loop);
    else groups.set(k, [loop]);
  }
  const merged = [...groups.values()].flatMap((group) => mergeGroup(group, vertices, tick)),
    result = finishBoolean(a, b, merged, vertices, nonManifold, options.createId);
  if (collapsed) result.diagnostics.push(`${collapsed} faces too thin for float64 were folded away.`);
  return { ...result, collapsedFaces: collapsed };
}
