import { MargoError, type MutableVec2, type MutableVec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, polygonAreaVector, polygonGeometryError } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import type { PolygonFace, PolygonMesh } from './types.js';

/** Which boolean {@link booleanMeshes} computes. */
export type MeshBooleanOperation = 'union' | 'difference' | 'intersection';

/** Options for {@link booleanMeshes}. */
export interface MeshBooleanOptions {
  /** Face ID generator for faces that need a new ID (default `crypto.randomUUID`). */
  createId?: () => string;
  /**
   * Distance below which points count as on a plane, and vertices as one, relative to the inputs' size (default
   * 1e-9 of the largest coordinate, at least 1e-12 units).
   */
  tolerance?: number;
  /** Checked as the work goes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Where an output face came from: input `a` or `b`, and that input's face ID. */
export interface MeshBooleanFaceSource {
  input: 'a' | 'b';
  face: string;
}

/** Result of {@link booleanMeshes}. */
export interface MeshBooleanResult {
  mesh: PolygonMesh;
  /** For each output face ID, the input face it is part of. */
  sources: Record<string, MeshBooleanFaceSource>;
  /** For each input face ID of `a` and of `b`, the output faces cut from it (empty when it was dropped). */
  faceMap: { a: Record<string, string[]>; b: Record<string, string[]> };
  /** Number of output edges joining more than two faces (shapes that only touch along an edge or at a vertex). */
  nonManifoldEdges: number;
  diagnostics: string[];
}

interface Plane {
  n: number[];
  w: number;
}

interface Poly {
  points: number[][];
  uv: number[][];
  plane: Plane;
  input: 0 | 1;
  face: string;
}

const COPLANAR = 0,
  FRONT = 1,
  BACK = 2,
  SPANNING = 3;

class Splitter {
  constructor(readonly eps: number) {}

  /** Point on segment p-q where it meets the plane, interpolated from the lexicographically smaller end, so both
   * faces sharing an edge get the very same point. */
  cut(plane: Plane, p: number[], q: number[], uvp: number[], uvq: number[]): { point: number[]; uv: number[] } {
    const swap = p[0] > q[0] || (p[0] === q[0] && (p[1] > q[1] || (p[1] === q[1] && p[2] > q[2])));
    const a = swap ? q : p,
      b = swap ? p : q,
      ua = swap ? uvq : uvp,
      ub = swap ? uvp : uvq,
      da = plane.n[0] * a[0] + plane.n[1] * a[1] + plane.n[2] * a[2] - plane.w,
      db = plane.n[0] * b[0] + plane.n[1] * b[1] + plane.n[2] * b[2] - plane.w,
      t = da / (da - db);
    return {
      point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
      uv: [ua[0] + (ub[0] - ua[0]) * t, ua[1] + (ub[1] - ua[1]) * t],
    };
  }

  /** Sort `poly` against `plane` into the four lists. */
  split(plane: Plane, poly: Poly, coFront: Poly[], coBack: Poly[], front: Poly[], back: Poly[]): void {
    let kind = 0;
    const types = poly.points.map((p) => {
      const t = plane.n[0] * p[0] + plane.n[1] * p[1] + plane.n[2] * p[2] - plane.w,
        type = t < -this.eps ? BACK : t > this.eps ? FRONT : COPLANAR;
      kind |= type;
      return type;
    });
    if (kind === COPLANAR) {
      const same = plane.n[0] * poly.plane.n[0] + plane.n[1] * poly.plane.n[1] + plane.n[2] * poly.plane.n[2] > 0;
      (same ? coFront : coBack).push(poly);
    } else if (kind === FRONT) front.push(poly);
    else if (kind === BACK) back.push(poly);
    else {
      const f: number[][] = [],
        fu: number[][] = [],
        b: number[][] = [],
        bu: number[][] = [];
      const n = poly.points.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n,
          ti = types[i],
          tj = types[j],
          p = poly.points[i],
          u = poly.uv[i];
        if (ti !== BACK) {
          f.push(p);
          fu.push(u);
        }
        if (ti !== FRONT) {
          b.push(p);
          bu.push(u);
        }
        if ((ti | tj) === SPANNING) {
          const { point, uv } = this.cut(plane, p, poly.points[j], u, poly.uv[j]);
          f.push(point);
          fu.push(uv);
          b.push(point);
          bu.push(uv);
        }
      }
      if (f.length >= 3) front.push({ ...poly, points: f, uv: fu });
      if (b.length >= 3) back.push({ ...poly, points: b, uv: bu });
    }
  }
}

/** A solid BSP tree (Thibault and Naylor, 1987) over convex polygons. */
class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Poly[] = [];

  constructor(
    readonly splitter: Splitter,
    readonly tick: () => void,
  ) {}

  invert(): void {
    const stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      for (const poly of node.polygons) flip(poly);
      if (node.plane) node.plane = { n: node.plane.n.map((x) => -x), w: -node.plane.w };
      const front = node.front;
      node.front = node.back;
      node.back = front;
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  /** Remove the parts of `polygons` inside this solid. */
  clipPolygons(polygons: Poly[]): Poly[] {
    const out: Poly[] = [],
      stack: { node: Node; polys: Poly[] }[] = [{ node: this, polys: polygons }];
    while (stack.length) {
      const { node, polys } = stack.pop()!;
      this.tick();
      if (!node.plane) {
        out.push(...polys);
        continue;
      }
      const front: Poly[] = [],
        back: Poly[] = [];
      for (const poly of polys) node.splitter.split(node.plane, poly, front, back, front, back);
      if (node.front) stack.push({ node: node.front, polys: front });
      else out.push(...front);
      if (node.back) stack.push({ node: node.back, polys: back });
    }
    return out;
  }

  clipTo(other: Node): void {
    const stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      node.polygons = other.clipPolygons(node.polygons);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  all(): Poly[] {
    const out: Poly[] = [],
      stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      out.push(...node.polygons);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
    return out;
  }

  build(polygons: Poly[]): void {
    const stack: { node: Node; polys: Poly[] }[] = [{ node: this, polys: polygons }];
    while (stack.length) {
      const { node, polys } = stack.pop()!;
      this.tick();
      if (!polys.length) continue;
      if (!node.plane) node.plane = choosePlane(node.splitter, polys);
      const front: Poly[] = [],
        back: Poly[] = [];
      for (const poly of polys) node.splitter.split(node.plane, poly, node.polygons, node.polygons, front, back);
      if (front.length) {
        node.front ??= new Node(node.splitter, node.tick);
        stack.push({ node: node.front, polys: front });
      }
      if (back.length) {
        node.back ??= new Node(node.splitter, node.tick);
        stack.push({ node: node.back, polys: back });
      }
    }
  }
}

/** Of a few candidate planes, the one splitting the fewest polygons (then the most balanced). */
function choosePlane(splitter: Splitter, polys: Poly[]): Plane {
  const candidates =
    polys.length <= 8 ? polys : Array.from({ length: 8 }, (_, i) => polys[Math.floor((i * polys.length) / 8)]);
  let best = candidates[0].plane,
    bestScore = Infinity;
  for (const candidate of candidates) {
    let spans = 0,
      front = 0,
      back = 0;
    for (const poly of polys) {
      let kind = 0;
      for (const p of poly.points) {
        const t =
          candidate.plane.n[0] * p[0] + candidate.plane.n[1] * p[1] + candidate.plane.n[2] * p[2] - candidate.plane.w;
        kind |= t < -splitter.eps ? BACK : t > splitter.eps ? FRONT : COPLANAR;
      }
      if (kind === SPANNING) spans++;
      else if (kind === FRONT) front++;
      else if (kind === BACK) back++;
    }
    const score = spans * 8 + Math.abs(front - back);
    if (score < bestScore) {
      bestScore = score;
      best = candidate.plane;
    }
  }
  return best;
}

function flip(poly: Poly): void {
  poly.points = [...poly.points].reverse();
  poly.uv = [...poly.uv].reverse();
  poly.plane = { n: poly.plane.n.map((x) => -x), w: -poly.plane.w };
}

/** Check one input: closed, two oppositely wound faces per edge, positive volume. */
function assertSolid(mesh: PolygonMesh, label: string): void {
  assertPolygonMesh(mesh);
  if (!mesh.faces.length) throw new TypeError(`Boolean input ${label} has no faces; supply a closed mesh.`);
  for (const edge of collectPolygonEdges(mesh)) {
    const [p, q] = edge.incidences;
    if (edge.incidences.length !== 2 || p.from !== q.to || p.to !== q.from)
      throw new TypeError(
        `Boolean input ${label} must be closed and consistently wound (edge ${edge.id}); close holes and fix winding.`,
      );
  }
  let volume = 0;
  const o = mesh.vertices[0];
  for (const face of mesh.faces) {
    const a = mesh.vertices[face.vertices[0]];
    for (let i = 1; i < face.vertices.length - 1; i++) {
      const b = mesh.vertices[face.vertices[i]],
        c = mesh.vertices[face.vertices[i + 1]],
        ax = a[0] - o[0],
        ay = a[1] - o[1],
        az = a[2] - o[2],
        bx = b[0] - o[0],
        by = b[1] - o[1],
        bz = b[2] - o[2],
        cx = c[0] - o[0],
        cy = c[1] - o[1],
        cz = c[2] - o[2];
      volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
  }
  if (!(volume > 0))
    throw new TypeError(
      `Boolean input ${label} faces inward or has no volume; reverse its faces so normals point out.`,
    );
}

function polygonsOf(mesh: PolygonMesh, input: 0 | 1): Poly[] {
  return mesh.faces.map((face) => {
    const points = face.vertices.map((v) => [...mesh.vertices[v]]),
      area = polygonAreaVector(points as MutableVec3[]),
      length = Math.hypot(area[0], area[1], area[2]),
      n = area.map((x) => x / length),
      // Plane offset from the face's centroid: the most accurate single point.
      c = [0, 1, 2].map((axis) => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
    return {
      points,
      uv: face.uv.map((uv) => [...uv]),
      plane: { n, w: n[0] * c[0] + n[1] * c[1] + n[2] * c[2] },
      input,
      face: face.id,
    };
  });
}

/**
 * Boolean of two closed solids: `union` (in either), `difference` (in `a`, not in `b`) or `intersection` (in
 * both). Both inputs must be closed, consistently wound and outward facing; they may overlap, touch, share coplanar
 * faces, nest or be apart. Built on solid BSP trees (Thibault and Naylor, 1987): faces are clipped against the other
 * solid's planes in floating point with a plane tolerance (see `tolerance`), each split point is computed from the
 * same edge end on both sides so neighbors agree, then vertices are welded, T-junctions are closed and slivers with no
 * area are dropped. The result is checked to be closed (every half-edge has its twin) before it is returned. Shapes
 * that only touch along an edge give edges with four faces, counted in `nonManifoldEdges`.
 *
 * Output faces keep their source face's ID where they can (the first piece of each face; `b`'s IDs when free) and
 * interpolate their UVs; `sources` and `faceMap` give the provenance. Pieces of one source face that form a convex
 * face again are merged back.
 * @throws TypeError for an input that is not a closed, outward, consistently wound mesh, or bad options; RangeError
 * for a bad tolerance; MargoError `failed` when the result cannot be closed (nearly coincident geometry finer than
 * the tolerance): nudge one input or raise `tolerance`; the signal's reason when aborted.
 */
export function booleanMeshes(
  a: PolygonMesh,
  b: PolygonMesh,
  operation: MeshBooleanOperation,
  options: MeshBooleanOptions = {},
): MeshBooleanResult {
  if (operation !== 'union' && operation !== 'difference' && operation !== 'intersection')
    throw new TypeError("Boolean operation must be 'union', 'difference' or 'intersection'; choose one.");
  assertOptions(options, 'Boolean');
  assertSolid(a, 'a');
  assertSolid(b, 'b');
  if (options.createId !== undefined && typeof options.createId !== 'function')
    throw new TypeError('Boolean createId must be a function; supply a generator or omit it.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Boolean signal must be an AbortSignal; pass controller.signal or omit it.');
  let scale = 0;
  for (const mesh of [a, b])
    for (const p of mesh.vertices) for (let axis = 0; axis < 3; axis++) scale = Math.max(scale, Math.abs(p[axis]));
  const tolerance = options.tolerance ?? Math.max(1e-12, scale * 1e-9);
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance <= 0)
    throw new RangeError('Boolean tolerance must be positive and finite; choose a small distance in local units.');
  const signal = options.signal;
  let ticks = 0;
  const tick = () => {
    if (signal && ++ticks % 256 === 0) signal.throwIfAborted();
  };
  signal?.throwIfAborted();
  const splitter = new Splitter(tolerance),
    A = new Node(splitter, tick),
    B = new Node(splitter, tick);
  A.build(polygonsOf(a, 0));
  B.build(polygonsOf(b, 1));
  if (operation === 'union') {
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    A.build(B.all());
  } else if (operation === 'difference') {
    A.invert();
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    A.build(B.all());
    A.invert();
  } else {
    A.invert();
    B.clipTo(A);
    B.invert();
    A.clipTo(B);
    B.clipTo(A);
    A.build(B.all());
    A.invert();
  }
  return assemble(a, b, A.all(), tolerance, options.createId, tick);
}

/** Weld, close T-junctions, drop slivers, check closure, merge pieces and name faces. */
function assemble(
  a: PolygonMesh,
  b: PolygonMesh,
  polys: Poly[],
  tolerance: number,
  createIdOption: (() => string) | undefined,
  tick: () => void,
): MeshBooleanResult {
  // Weld: vertices within the tolerance become one (grid hash of the tolerance, checking neighbor cells).
  const vertices: MutableVec3[] = [],
    grid = new Map<string, number[]>(),
    cell = tolerance * 4,
    key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const vertexOf = (p: number[]): number => {
    const cx = Math.floor(p[0] / cell),
      cy = Math.floor(p[1] / cell),
      cz = Math.floor(p[2] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const index of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            const q = vertices[index];
            if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= tolerance) return index;
          }
    const index = vertices.length;
    vertices.push([p[0], p[1], p[2]]);
    const k = key(cx, cy, cz),
      list = grid.get(k);
    if (list) list.push(index);
    else grid.set(k, [index]);
    return index;
  };
  type Loop = { vertices: number[]; uv: MutableVec2[]; input: 0 | 1; face: string; plane: Plane };
  let loops: Loop[] = polys.map((poly) => {
    const loop: Loop = { vertices: [], uv: [], input: poly.input, face: poly.face, plane: poly.plane };
    poly.points.forEach((p, i) => {
      const v = vertexOf(p);
      if (loop.vertices[loop.vertices.length - 1] === v) return;
      loop.vertices.push(v);
      loop.uv.push([poly.uv[i][0], poly.uv[i][1]]);
    });
    while (loop.vertices.length > 1 && loop.vertices[0] === loop.vertices[loop.vertices.length - 1]) {
      loop.vertices.pop();
      loop.uv.pop();
    }
    return loop;
  });
  loops = loops.filter((loop) => loop.vertices.length >= 3);
  // T-junctions: a vertex lying inside another loop's edge is inserted into that edge.
  const used = [...new Set(loops.flatMap((loop) => loop.vertices))],
    vgrid = new Map<string, number[]>(),
    big = Math.max(tolerance * 1e6, 1e-6);
  for (const v of used) {
    const p = vertices[v],
      k = key(Math.floor(p[0] / big), Math.floor(p[1] / big), Math.floor(p[2] / big)),
      list = vgrid.get(k);
    if (list) list.push(v);
    else vgrid.set(k, [v]);
  }
  const onEdge = (p: number, q: number): { v: number; t: number }[] => {
    const P = vertices[p],
      Q = vertices[q],
      lo = [0, 1, 2].map((axis) => Math.floor((Math.min(P[axis], Q[axis]) - tolerance) / big)),
      hi = [0, 1, 2].map((axis) => Math.floor((Math.max(P[axis], Q[axis]) + tolerance) / big)),
      e = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]],
      ee = e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
      found: { v: number; t: number }[] = [];
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096) {
      // A long edge in a fine grid: scan all vertices instead.
      for (const v of used) test(v);
    } else
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) for (const v of vgrid.get(key(x, y, z)) ?? []) test(v);
    function test(v: number) {
      if (v === p || v === q) return;
      const R = vertices[v],
        r = [R[0] - P[0], R[1] - P[1], R[2] - P[2]],
        t = (r[0] * e[0] + r[1] * e[1] + r[2] * e[2]) / ee;
      if (t <= 0 || t >= 1) return;
      const off = Math.hypot(r[0] - t * e[0], r[1] - t * e[1], r[2] - t * e[2]);
      if (off <= tolerance && t * Math.sqrt(ee) > tolerance && (1 - t) * Math.sqrt(ee) > tolerance)
        found.push({ v, t });
    }
    return found.sort((x, y) => x.t - y.t);
  };
  for (const loop of loops) {
    tick();
    const vs: number[] = [],
      uvs: MutableVec2[] = [],
      n = loop.vertices.length;
    for (let i = 0; i < n; i++) {
      const p = loop.vertices[i],
        q = loop.vertices[(i + 1) % n],
        up = loop.uv[i],
        uq = loop.uv[(i + 1) % n];
      vs.push(p);
      uvs.push(up);
      for (const { v, t } of onEdge(p, q)) {
        vs.push(v);
        uvs.push([up[0] + (uq[0] - up[0]) * t, up[1] + (uq[1] - up[1]) * t]);
      }
    }
    loop.vertices = vs;
    loop.uv = uvs;
  }
  // Drop loops with no area (slivers squeezed onto a line by welding).
  loops = loops.filter((loop) => {
    const area = polygonAreaVector(vertices, loop.vertices);
    return Math.hypot(area[0], area[1], area[2]) > tolerance * tolerance * 4;
  });
  // Closure: every half-edge must be matched by its reverse, as often.
  const half = new Map<string, number>();
  for (const loop of loops)
    loop.vertices.forEach((p, i) => {
      const q = loop.vertices[(i + 1) % loop.vertices.length],
        k = `${p}>${q}`;
      half.set(k, (half.get(k) ?? 0) + 1);
    });
  let nonManifold = 0;
  for (const [k, count] of half) {
    const [p, q] = k.split('>');
    if (half.get(`${q}>${p}`) !== count)
      throw new MargoError(
        'failed',
        'Boolean result is not closed: the inputs have nearly coincident geometry finer than the tolerance; nudge one input or raise tolerance.',
      );
    if (count > 1 && p < q) nonManifold++;
  }
  // Merge pieces of the same source face back where the union is still one valid convex face.
  const merged: Loop[] = [];
  const groups = new Map<string, Loop[]>();
  for (const loop of loops) {
    const k = `${loop.input}|${loop.face}`,
      list = groups.get(k);
    if (list) list.push(loop);
    else groups.set(k, [loop]);
  }
  for (const group of groups.values()) merged.push(...mergeGroup(group, vertices, tick));
  // Name faces: the first piece of each source face keeps its ID (b's only when a does not use it).
  const usedIds = new Set<string>(),
    taken = new Set([...a.faces.map((f) => f.id), ...b.faces.map((f) => f.id)]),
    generate = createIdOption ?? (() => globalThis.crypto.randomUUID()),
    createId = () => {
      const id = generate();
      if (typeof id !== 'string' || !id.length || usedIds.has(id) || taken.has(id))
        throw new TypeError('Generated face ID must be nonempty and unique; fix the createId generator.');
      usedIds.add(id);
      return id;
    },
    faces: PolygonFace[] = [],
    sources: Record<string, MeshBooleanFaceSource> = {},
    faceMap = {
      a: Object.fromEntries(a.faces.map((face) => [face.id, [] as string[]])),
      b: Object.fromEntries(b.faces.map((face) => [face.id, [] as string[]])),
    };
  let triangulated = 0;
  for (const loop of merged) {
    const input = loop.input === 0 ? 'a' : 'b',
      wanted = loop.face,
      id = usedIds.has(wanted) ? createId() : (usedIds.add(wanted), wanted);
    let pieces: PolygonFace[] | null =
      loop.vertices.length <= 64 && !polygonGeometryError(loop.vertices.map((v) => vertices[v]))
        ? [{ id, vertices: loop.vertices, uv: loop.uv }]
        : null;
    if (!pieces) {
      pieces = loopFaces(vertices, loop.vertices, loop.uv, id, createId);
      triangulated++;
    }
    if (!pieces)
      throw new MargoError('failed', 'Boolean result has a folded face; nudge one input or raise tolerance.');
    for (const piece of pieces) {
      faces.push(piece);
      sources[piece.id] = { input, face: wanted };
      faceMap[input][wanted].push(piece.id);
    }
  }
  // Compact to the used vertices.
  const remap = new Map<number, number>(),
    out: MutableVec3[] = [];
  for (const face of faces)
    face.vertices = face.vertices.map((v) => {
      let index = remap.get(v);
      if (index === undefined) {
        index = out.length;
        remap.set(v, index);
        out.push(vertices[v]);
      }
      return index;
    });
  // Interpolated UVs stay inside each source face's UVs; clamping only removes last-bit rounding outside [0, 1].
  for (const face of faces) for (const uv of face.uv) for (const k of [0, 1]) uv[k] = Math.min(1, Math.max(0, uv[k]));
  const mesh: PolygonMesh = { vertices: out, faces };
  assertPolygonMesh(mesh);
  const diagnostics: string[] = [];
  if (nonManifold) diagnostics.push(`${nonManifold} edges join four or more faces where the shapes only touch.`);
  if (triangulated) diagnostics.push(`${triangulated} pieces were split to keep every face planar and convex.`);
  if (!faces.length) diagnostics.push('The result is empty.');
  return { mesh, sources, faceMap, nonManifoldEdges: nonManifold, diagnostics };
}

/** Greedy merge of one source face's pieces across shared edges while the union stays a valid convex face. */
function mergeGroup(
  group: { vertices: number[]; uv: MutableVec2[]; input: 0 | 1; face: string; plane: Plane }[],
  vertices: MutableVec3[],
  tick: () => void,
): typeof group {
  const pieces: ((typeof group)[number] | null)[] = [...group];
  let changed = pieces.length > 1;
  while (changed) {
    changed = false;
    tick();
    const owner = new Map<string, number>();
    pieces.forEach((piece, p) => {
      if (piece)
        piece.vertices.forEach((v, i) => owner.set(`${v}>${piece.vertices[(i + 1) % piece.vertices.length]}`, p));
    });
    for (let p = 0; p < pieces.length && !changed; p++) {
      const piece = pieces[p];
      if (!piece) continue;
      for (let i = 0; i < piece.vertices.length; i++) {
        const x = piece.vertices[i],
          y = piece.vertices[(i + 1) % piece.vertices.length],
          q = owner.get(`${y}>${x}`);
        if (q === undefined || q === p) continue;
        const other = pieces[q]!,
          start = (i + 1) % piece.vertices.length,
          j = other.vertices.indexOf(x),
          rotate = <T>(list: T[], at: number) => [...list.slice(at), ...list.slice(0, at)],
          verts = [...rotate(piece.vertices, start), ...rotate(other.vertices, j).slice(1, -1)],
          uv = [...rotate(piece.uv, start), ...rotate(other.uv, j).slice(1, -1)];
        if (verts.length > 64 || new Set(verts).size !== verts.length) continue;
        if (polygonGeometryError(verts.map((v) => vertices[v]))) continue;
        pieces[p] = { ...piece, vertices: verts, uv };
        pieces[q] = null;
        changed = true;
        break;
      }
    }
  }
  return pieces.filter((piece): piece is (typeof group)[number] => piece !== null);
}
