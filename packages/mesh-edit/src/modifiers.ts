// @margoengine/mesh-edit/modifiers: a non-destructive stack of mirror, array, solidify, screw and lattice deform. The
// base mesh is never changed; `MeshModifierStack` re-runs from the first stage that is out of date. Output face IDs are
// built from base IDs, so a re-run names the same face the same way and selections survive.
import type { MutableVec2, MutableVec3, Vec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, faceGeometryError, newellNormal } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import { clonePolygonMesh, createMeshEditResult } from './result.js';
import type { MeshEditResult, PolygonFace, PolygonMesh } from './types.js';
import { weldMeshVertices } from './weld.js';

/** An axis by name. */
export type ModifierAxis = 'x' | 'y' | 'z';

/** Fields every modifier shares. */
export interface MeshModifierBase {
  /** False skips this modifier without removing it. Default true. */
  enabled?: boolean;
}

/** Reflect the mesh across an axis plane and keep both halves. */
export interface MirrorModifier extends MeshModifierBase {
  type: 'mirror';
  /** The axis the plane faces along. Default `'x'`. */
  axis?: ModifierAxis;
  /** Where the plane crosses that axis. Default 0. */
  origin?: number;
  /** Vertices this close to the plane move onto it and join both halves; faces wholly on it are dropped. 0 joins nothing. Default 1e-6. */
  merge?: number;
}

/** Repeat the mesh along an offset. */
export interface ArrayModifier extends MeshModifierBase {
  type: 'array';
  /** Number of copies, the original included, 1 to 4096. Default 2. */
  count?: number;
  /** Fixed step between copies. Default `[0, 0, 0]`. */
  offset?: Vec3;
  /** Step as a multiple of the mesh's bounding box size, added to `offset`. Default `[1, 0, 0]` when `offset` is omitted. */
  relativeOffset?: Vec3;
  /** Weld vertices of neighboring copies this close together. 0 welds nothing. Default 0. */
  merge?: number;
}

/** Give a surface thickness: a second shell plus rim faces along open edges. */
export interface SolidifyModifier extends MeshModifierBase {
  type: 'solidify';
  /** Wall thickness, positive and finite. Default 0.1. */
  thickness?: number;
  /** Where the wall sits: -1 fully behind the surface, 0 centered, 1 fully in front. Default -1. */
  offset?: number;
  /** Keep the wall's thickness even at corners by moving them farther along their normals. Default true. */
  even?: boolean;
}

/** Sweep a surface profile around an axis through `origin`, optionally climbing along it. */
export interface ScrewModifier extends MeshModifierBase {
  type: 'screw';
  /** The axis to turn about. Default `'y'`. */
  axis?: ModifierAxis;
  /** Point the axis passes through. Default `[0, 0, 0]`. */
  origin?: Vec3;
  /** Total turn in radians, nonzero. A full turn with no `height` closes on itself. Default 2 pi. */
  angle?: number;
  /** Steps around the sweep, 1 to 4096 (3 or more for a closed sweep). Default 16. */
  steps?: number;
  /** Distance climbed along the axis over the whole sweep. Default 0. */
  height?: number;
}

/** A box of control points that bends the mesh inside it (free-form deformation; Sederberg and Parry, 1986). */
export interface LatticeModifier extends MeshModifierBase {
  type: 'lattice';
  /** Box corner with the smallest coordinates. */
  min: Vec3;
  /** Box corner with the largest coordinates. */
  max: Vec3;
  /** Control points along x, y and z, each 2 to 16. */
  resolution: readonly [number, number, number];
  /** Control points, x fastest, then y, then z. Start from {@link latticePoints}. */
  points: readonly Vec3[];
}

/** One step of a modifier stack. */
export type MeshModifier = MirrorModifier | ArrayModifier | SolidifyModifier | ScrewModifier | LatticeModifier;

const AXES: Record<ModifierAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

function axisOf(axis: unknown, fallback: ModifierAxis): 0 | 1 | 2 {
  const name = axis ?? fallback;
  if (name !== 'x' && name !== 'y' && name !== 'z')
    throw new TypeError("Modifier axis must be 'x', 'y' or 'z'; choose one.");
  return AXES[name];
}

function numberOption(value: unknown, fallback: number, label: string, valid: (x: number) => boolean): number {
  const x = value ?? fallback;
  if (typeof x !== 'number' || !Number.isFinite(x) || !valid(x))
    throw new RangeError(`${label} is out of range; see the modifier's documented limits.`);
  return x;
}

function vectorOption(value: unknown, fallback: Vec3, label: string): Vec3 {
  const v = value ?? fallback;
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(x)))
    throw new TypeError(`${label} must be three finite numbers; supply [x, y, z].`);
  return v as unknown as Vec3;
}

/** Collects output faces, splitting any that a move left warped, and records which input face each came from. */
class FaceSink {
  readonly faces: PolygonFace[] = [];
  readonly faceMap: Record<string, string[]> = {};
  split = 0;

  constructor(
    source: PolygonMesh,
    readonly vertices: MutableVec3[],
  ) {
    for (const face of source.faces) this.faceMap[face.id] = [];
  }

  add(from: string, id: string, vertices: readonly number[], uv: readonly (readonly number[])[]): void {
    const corners: number[] = [],
      uvs: MutableVec2[] = [];
    vertices.forEach((v, i) => {
      if (v === corners[corners.length - 1]) return;
      corners.push(v);
      uvs.push([uv[i][0], uv[i][1]]);
    });
    while (corners.length > 1 && corners[0] === corners[corners.length - 1]) {
      corners.pop();
      uvs.pop();
    }
    if (corners.length < 3) return;
    if (!faceGeometryError(this.vertices, corners)) {
      this.faces.push({ id, vertices: corners, uv: uvs });
      this.faceMap[from].push(id);
      return;
    }
    let next = 0;
    const pieces = loopFaces(this.vertices, corners, uvs, id, () => `${id}~t${++next}`);
    if (!pieces) {
      this.split++;
      return;
    }
    if (pieces.length > 1) this.split++;
    for (const piece of pieces) {
      this.faces.push(piece);
      this.faceMap[from].push(piece.id);
    }
  }

  result(source: PolygonMesh, vertexMap: number[][], diagnostics: string[] = []): MeshEditResult {
    const mesh = { vertices: this.vertices, faces: this.faces };
    if (this.split) diagnostics.push(`${this.split} warped faces were split or dropped to stay valid.`);
    return createMeshEditResult(source, mesh, {
      vertexMap,
      faceMap: this.faceMap,
      createdVertices: vertexMap.flatMap((list, v) => list.filter((x) => x !== v)),
      removedVertices: [],
      diagnostics,
    });
  }
}

function applyMirror(mesh: PolygonMesh, modifier: MirrorModifier): MeshEditResult {
  const axis = axisOf(modifier.axis, 'x'),
    origin = numberOption(modifier.origin, 0, 'Mirror origin', () => true),
    merge = numberOption(modifier.merge, 1e-6, 'Mirror merge', (x) => x >= 0),
    onPlane = mesh.vertices.map((p) => merge > 0 && Math.abs(p[axis] - origin) <= merge),
    vertices: MutableVec3[] = mesh.vertices.map((p, v) => {
      const out: MutableVec3 = [p[0], p[1], p[2]];
      if (onPlane[v]) out[axis] = origin;
      return out;
    }),
    vertexMap = mesh.vertices.map((_, v) => [v]),
    twin = mesh.vertices.map((p, v) => {
      if (onPlane[v]) return v;
      const out: MutableVec3 = [p[0], p[1], p[2]];
      out[axis] = 2 * origin - p[axis];
      vertexMap[v].push(vertices.length);
      vertices.push(out);
      return vertices.length - 1;
    }),
    sink = new FaceSink(mesh, vertices);
  let dropped = 0;
  for (const face of mesh.faces) {
    if (face.vertices.every((v) => onPlane[v])) {
      dropped++;
      continue;
    }
    sink.add(face.id, face.id, face.vertices, face.uv);
    sink.add(
      face.id,
      `${face.id}~m`,
      [...face.vertices].reverse().map((v) => twin[v]),
      [...face.uv].reverse(),
    );
  }
  return sink.result(mesh, vertexMap, dropped ? [`${dropped} faces on the mirror plane were dropped.`] : []);
}

function applyArray(mesh: PolygonMesh, modifier: ArrayModifier): MeshEditResult {
  const count = numberOption(modifier.count, 2, 'Array count', (x) => Number.isInteger(x) && x >= 1 && x <= 4096),
    fixed = vectorOption(modifier.offset, [0, 0, 0], 'Array offset'),
    relative = vectorOption(modifier.relativeOffset, modifier.offset ? [0, 0, 0] : [1, 0, 0], 'Array relativeOffset'),
    merge = numberOption(modifier.merge, 0, 'Array merge', (x) => x >= 0),
    size = [0, 1, 2].map((k) => {
      const values = mesh.vertices.map((p) => p[k]);
      return values.length ? Math.max(...values) - Math.min(...values) : 0;
    }),
    step = [0, 1, 2].map((k) => fixed[k] + relative[k] * size[k]),
    vertices: MutableVec3[] = [],
    vertexMap: number[][] = mesh.vertices.map(() => []);
  for (let copy = 0; copy < count; copy++)
    mesh.vertices.forEach((p, v) => {
      vertexMap[v].push(vertices.length);
      vertices.push([p[0] + step[0] * copy, p[1] + step[1] * copy, p[2] + step[2] * copy]);
    });
  const sink = new FaceSink(mesh, vertices);
  for (let copy = 0; copy < count; copy++)
    for (const face of mesh.faces)
      sink.add(
        face.id,
        copy ? `${face.id}~a${copy}` : face.id,
        face.vertices.map((v) => vertexMap[v][copy]),
        face.uv,
      );
  const result = sink.result(mesh, vertexMap);
  if (!merge) return result;
  const welded = weldMeshVertices(result.mesh, { distance: merge });
  return compose(mesh, result, welded);
}

/** Unit vertex normals, each face weighted by its corner angle; `even` scales them to keep offset faces parallel. */
function vertexNormals(mesh: PolygonMesh, even: boolean): MutableVec3[] {
  const sums: MutableVec3[] = mesh.vertices.map(() => [0, 0, 0]),
    uses: { n: Vec3; angle: number }[][] = mesh.vertices.map(() => []);
  for (const face of mesh.faces) {
    const points = face.vertices.map((v) => mesh.vertices[v]),
      n = newellNormal(points),
      count = points.length;
    face.vertices.forEach((v, i) => {
      const p = points[i],
        a = points[(i + 1) % count],
        b = points[(i + count - 1) % count],
        u = [a[0] - p[0], a[1] - p[1], a[2] - p[2]],
        w = [b[0] - p[0], b[1] - p[1], b[2] - p[2]],
        angle = Math.acos(
          Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w)))),
        );
      for (let k = 0; k < 3; k++) sums[v][k] += n[k] * angle;
      uses[v].push({ n, angle });
    });
  }
  return sums.map((sum, v) => {
    const length = Math.hypot(sum[0], sum[1], sum[2]);
    if (!length) return [0, 0, 0];
    const n: MutableVec3 = [sum[0] / length, sum[1] / length, sum[2] / length];
    if (!even) return n;
    let weighted = 0,
      total = 0;
    for (const use of uses[v]) {
      weighted += Math.max(0.25, use.n[0] * n[0] + use.n[1] * n[1] + use.n[2] * n[2]) * use.angle;
      total += use.angle;
    }
    const scale = total / weighted;
    return [n[0] * scale, n[1] * scale, n[2] * scale];
  });
}

function applySolidify(mesh: PolygonMesh, modifier: SolidifyModifier): MeshEditResult {
  const thickness = numberOption(modifier.thickness, 0.1, 'Solidify thickness', (x) => x > 0),
    offset = numberOption(modifier.offset, -1, 'Solidify offset', (x) => x >= -1 && x <= 1),
    normals = vertexNormals(mesh, modifier.even ?? true),
    front = (thickness * (offset + 1)) / 2,
    back = (thickness * (offset - 1)) / 2,
    at = (p: Vec3, n: Vec3, d: number): MutableVec3 => [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d],
    vertices: MutableVec3[] = mesh.vertices.map((p, v) => at(p, normals[v], front)),
    count = vertices.length,
    vertexMap = mesh.vertices.map((p, v) => {
      vertices.push(at(p, normals[v], back));
      return [v, count + v];
    }),
    sink = new FaceSink(mesh, vertices),
    byId = new Map(mesh.faces.map((face) => [face.id, face]));
  for (const face of mesh.faces) {
    sink.add(face.id, face.id, face.vertices, face.uv);
    sink.add(
      face.id,
      `${face.id}~s`,
      [...face.vertices].reverse().map((v) => count + v),
      [...face.uv].reverse(),
    );
  }
  for (const edge of collectPolygonEdges(mesh)) {
    if (edge.incidences.length !== 1) continue;
    const { faceId, corner, from, to } = edge.incidences[0],
      face = byId.get(faceId)!,
      uvFrom = face.uv[corner],
      uvTo = face.uv[(corner + 1) % face.vertices.length];
    sink.add(faceId, `${faceId}~r${corner}`, [to, from, count + from, count + to], [uvTo, uvFrom, uvFrom, uvTo]);
  }
  return sink.result(mesh, vertexMap);
}

/** Rotate `p` about the unit axis `k` through `origin` by `angle` (Rodrigues' formula) and climb `climb` along it. */
function sweepPoint(p: Vec3, origin: Vec3, axis: 0 | 1 | 2, angle: number, climb: number): MutableVec3 {
  const u = (axis + 1) % 3,
    v = (axis + 2) % 3,
    c = Math.cos(angle),
    s = Math.sin(angle),
    du = p[u] - origin[u],
    dv = p[v] - origin[v],
    out: MutableVec3 = [0, 0, 0];
  out[axis] = p[axis] + climb;
  out[u] = origin[u] + du * c - dv * s;
  out[v] = origin[v] + du * s + dv * c;
  return out;
}

function applyScrew(mesh: PolygonMesh, modifier: ScrewModifier): MeshEditResult {
  const axis = axisOf(modifier.axis, 'y'),
    origin = vectorOption(modifier.origin, [0, 0, 0], 'Screw origin'),
    angle = numberOption(modifier.angle, Math.PI * 2, 'Screw angle', (x) => x !== 0),
    height = numberOption(modifier.height, 0, 'Screw height', () => true),
    closed = height === 0 && Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-9,
    steps = numberOption(
      modifier.steps,
      16,
      'Screw steps',
      (x) => Number.isInteger(x) && x <= 4096 && x >= (closed ? 3 : 1),
    ),
    rings = closed ? steps : steps + 1,
    u = (axis + 1) % 3,
    v = (axis + 2) % 3,
    extent = Math.max(1e-300, ...mesh.vertices.flat().map(Math.abs));
  // Which way the sweep leaves the surface decides the winding of everything it makes.
  let lean = 0;
  for (const face of mesh.faces) {
    const points = face.vertices.map((i) => mesh.vertices[i]),
      n = newellNormal(points),
      c = [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k], 0) / points.length),
      tangent = [0, 0, 0];
    tangent[u] = -(c[v] - origin[v]) * angle;
    tangent[v] = (c[u] - origin[u]) * angle;
    tangent[axis] = height;
    lean += n[0] * tangent[0] + n[1] * tangent[1] + n[2] * tangent[2];
  }
  if (Math.abs(lean) < extent * 1e-12)
    throw new RangeError('Screw sweeps the surface along itself; turn the profile so the sweep leaves its plane.');
  // Vertices on the axis of a sweep with no climb stay put, and every ring shares them.
  const vertices: MutableVec3[] = [],
    onAxis = mesh.vertices.map((p) => height === 0 && Math.hypot(p[u] - origin[u], p[v] - origin[v]) <= extent * 1e-12),
    ring = mesh.vertices.map((p, i) => {
      const copies: number[] = [];
      for (let k = 0; k < rings; k++) {
        if (k && onAxis[i]) {
          copies.push(copies[0]);
          continue;
        }
        copies.push(vertices.length);
        vertices.push(sweepPoint(p, origin, axis, (angle * k) / steps, (height * k) / steps));
      }
      return copies;
    }),
    sink = new FaceSink(mesh, vertices),
    byId = new Map(mesh.faces.map((face) => [face.id, face])),
    forward = lean > 0;
  for (const edge of collectPolygonEdges(mesh)) {
    if (edge.incidences.length !== 1) continue;
    const { faceId, corner, from, to } = edge.incidences[0],
      size = byId.get(faceId)!.vertices.length;
    if (size < 3) continue;
    for (let k = 0; k < steps; k++) {
      const next = (k + 1) % rings,
        a = k / steps,
        b = (k + 1) / steps,
        loop = [ring[from][k], ring[to][k], ring[to][next], ring[from][next]],
        uv = [
          [a, 0],
          [a, 1],
          [b, 1],
          [b, 0],
        ];
      sink.add(
        faceId,
        `${faceId}~w${corner}.${k}`,
        forward ? loop : [...loop].reverse(),
        forward ? uv : [...uv].reverse(),
      );
    }
  }
  if (!closed)
    for (const face of mesh.faces) {
      const first = face.vertices.map((i) => ring[i][0]),
        last = face.vertices.map((i) => ring[i][rings - 1]),
        reversed = [...face.uv].reverse();
      sink.add(face.id, face.id, forward ? [...first].reverse() : first, forward ? reversed : face.uv);
      sink.add(face.id, `${face.id}~e`, forward ? last : [...last].reverse(), forward ? face.uv : reversed);
    }
  const vertexMap = ring.map((copies) => [...new Set(copies)]);
  return sink.result(mesh, vertexMap);
}

/**
 * Control points of an undeformed lattice, x fastest, then y, then z: a {@link LatticeModifier} using them changes
 * nothing. Move some of them to bend the mesh.
 * @throws TypeError for bad corners; RangeError for a resolution outside 2 to 16.
 */
export function latticePoints(min: Vec3, max: Vec3, resolution: readonly [number, number, number]): MutableVec3[] {
  vectorOption(min, [0, 0, 0], 'Lattice min');
  vectorOption(max, [0, 0, 0], 'Lattice max');
  const [l, m, n] = latticeResolution(resolution),
    out: MutableVec3[] = [];
  for (let k = 0; k < n; k++)
    for (let j = 0; j < m; j++)
      for (let i = 0; i < l; i++)
        out.push([
          min[0] + ((max[0] - min[0]) * i) / (l - 1),
          min[1] + ((max[1] - min[1]) * j) / (m - 1),
          min[2] + ((max[2] - min[2]) * k) / (n - 1),
        ]);
  return out;
}

function latticeResolution(resolution: unknown): [number, number, number] {
  if (
    !Array.isArray(resolution) ||
    resolution.length !== 3 ||
    !resolution.every((x) => Number.isInteger(x) && x >= 2 && x <= 16)
  )
    throw new RangeError('Lattice resolution must be three integers from 2 to 16; supply [x, y, z] control counts.');
  return resolution as [number, number, number];
}

/** Bernstein weights of degree `count - 1` at `t`. */
function bernstein(count: number, t: number): number[] {
  const degree = count - 1,
    out: number[] = [];
  let choose = 1;
  for (let i = 0; i <= degree; i++) {
    out.push(choose * t ** i * (1 - t) ** (degree - i));
    choose = (choose * (degree - i)) / (i + 1);
  }
  return out;
}

function applyLattice(mesh: PolygonMesh, modifier: LatticeModifier): MeshEditResult {
  const min = vectorOption(modifier.min, [0, 0, 0], 'Lattice min'),
    max = vectorOption(modifier.max, [0, 0, 0], 'Lattice max'),
    [l, m, n] = latticeResolution(modifier.resolution),
    { points } = modifier;
  if (![0, 1, 2].every((k) => max[k] > min[k]))
    throw new RangeError('Lattice max must exceed min on every axis; supply a box with volume.');
  if (!Array.isArray(points) || points.length !== l * m * n)
    throw new TypeError('Lattice points must hold one point per control; start from latticePoints.');
  for (const p of points) vectorOption(p, [0, 0, 0], 'Lattice point');
  const vertices = mesh.vertices.map((p): MutableVec3 => {
      const s = [0, 1, 2].map((k) => (p[k] - min[k]) / (max[k] - min[k]));
      if (s.some((x) => x < 0 || x > 1)) return [p[0], p[1], p[2]];
      const bx = bernstein(l, s[0]),
        by = bernstein(m, s[1]),
        bz = bernstein(n, s[2]),
        out: MutableVec3 = [0, 0, 0];
      for (let k = 0; k < n; k++)
        for (let j = 0; j < m; j++)
          for (let i = 0; i < l; i++) {
            const w = bx[i] * by[j] * bz[k],
              q = points[(k * m + j) * l + i];
            out[0] += q[0] * w;
            out[1] += q[1] * w;
            out[2] += q[2] * w;
          }
      return out;
    }),
    sink = new FaceSink(mesh, vertices);
  for (const face of mesh.faces) sink.add(face.id, face.id, face.vertices, face.uv);
  return sink.result(
    mesh,
    mesh.vertices.map((_, v) => [v]),
  );
}

function runModifier(mesh: PolygonMesh, modifier: MeshModifier): MeshEditResult {
  switch (modifier?.type) {
    case 'mirror':
      return applyMirror(mesh, modifier);
    case 'array':
      return applyArray(mesh, modifier);
    case 'solidify':
      return applySolidify(mesh, modifier);
    case 'screw':
      return applyScrew(mesh, modifier);
    case 'lattice':
      return applyLattice(mesh, modifier);
    default:
      throw new TypeError("Modifier type must be 'mirror', 'array', 'solidify', 'screw' or 'lattice'; choose one.");
  }
}

/** `first` then `second` as one edit of `source`. */
function compose(source: PolygonMesh, first: MeshEditResult, second: MeshEditResult): MeshEditResult {
  const vertexMap = first.vertexMap.map((list) => [...new Set(list.flatMap((v) => second.vertexMap[v]))]),
    faceMap = Object.fromEntries(
      source.faces.map((face) => [face.id, [...new Set(first.faceMap[face.id].flatMap((id) => second.faceMap[id]))]]),
    ),
    kept = new Set(vertexMap.flat());
  return createMeshEditResult(source, second.mesh, {
    vertexMap,
    faceMap,
    createdVertices: [...kept].filter((v) => !vertexMap[v]?.includes(v)),
    removedVertices: vertexMap.flatMap((list, v) => (list.length ? [] : [v])),
    diagnostics: [...first.diagnostics, ...second.diagnostics],
  });
}

/** An unchanged copy of `mesh`, as a result. */
function identity(mesh: PolygonMesh): MeshEditResult {
  return createMeshEditResult(mesh, clonePolygonMesh(mesh), {
    vertexMap: mesh.vertices.map((_, v) => [v]),
    faceMap: Object.fromEntries(mesh.faces.map((face) => [face.id, [face.id]])),
    createdVertices: [],
    removedVertices: [],
  });
}

/**
 * Run `modifiers` in order on a copy of `mesh` and return the final mesh with provenance back to `mesh`: `vertexMap`
 * and `faceMap` list everything each base vertex and face became. Face IDs are derived from base IDs, so the same
 * inputs always give the same IDs. Modifiers with `enabled: false` are skipped.
 * @throws TypeError for a bad mesh or modifier; RangeError for an option outside its limits.
 */
export function applyMeshModifiers(mesh: PolygonMesh, modifiers: readonly MeshModifier[]): MeshEditResult {
  assertPolygonMesh(mesh);
  if (!Array.isArray(modifiers)) throw new TypeError('Modifiers must be an array; supply a list of modifiers.');
  let result = identity(mesh);
  for (const modifier of modifiers) {
    assertOptions(modifier, 'Modifier');
    if (modifier.enabled === false) continue;
    result = compose(mesh, result, runModifier(result.mesh, modifier));
  }
  assertPolygonMesh(result.mesh);
  return result;
}

/**
 * A base mesh and an ordered list of modifiers, evaluated on demand. The base is never changed: set `base` to a new
 * mesh (every edit command returns one) and the next {@link MeshModifierStack.evaluate} re-runs the stack. Each stage's
 * output is kept, so changing one modifier re-runs only that stage and the ones after it.
 *
 * ```ts
 * const stack = new MeshModifierStack(createPrimitiveMesh('cube', 'box'), [{ type: 'mirror' }]);
 * stack.add({ type: 'array', count: 3 });
 * const { mesh } = stack.evaluate();
 * ```
 */
export class MeshModifierStack {
  #base: PolygonMesh;
  #modifiers: MeshModifier[];
  /** Results by stage, and the JSON of the modifier that made each. */
  #stages: { key: string; result: MeshEditResult }[] = [];

  /**
   * @param base Copied, so later changes to your object do nothing until you set `base`.
   * @throws TypeError for a bad mesh or modifier list.
   */
  constructor(base: PolygonMesh, modifiers: readonly MeshModifier[] = []) {
    assertPolygonMesh(base);
    if (!Array.isArray(modifiers)) throw new TypeError('Modifiers must be an array; supply a list of modifiers.');
    this.#base = clonePolygonMesh(base);
    this.#modifiers = [...modifiers];
  }

  /** A copy of the base mesh. */
  get base(): PolygonMesh {
    return clonePolygonMesh(this.#base);
  }

  /** Replace the base mesh; everything re-runs at the next evaluate. */
  set base(mesh: PolygonMesh) {
    assertPolygonMesh(mesh);
    this.#base = clonePolygonMesh(mesh);
    this.#stages = [];
  }

  /** The modifiers, in order. */
  get modifiers(): readonly MeshModifier[] {
    return [...this.#modifiers];
  }

  /** Add a modifier at `index`, by default the end. */
  add(modifier: MeshModifier, index = this.#modifiers.length): void {
    this.#modifiers.splice(index, 0, modifier);
  }

  /** Change fields of the modifier at `index`. @throws RangeError for an index with no modifier. */
  update(index: number, changes: Partial<MeshModifier>): void {
    this.#modifiers[index] = { ...this.#at(index), ...changes } as MeshModifier;
  }

  /** Remove the modifier at `index`. @throws RangeError for an index with no modifier. */
  remove(index: number): void {
    this.#at(index);
    this.#modifiers.splice(index, 1);
  }

  /** Move the modifier at `from` to position `to`. @throws RangeError for an index with no modifier. */
  move(from: number, to: number): void {
    const modifier = this.#at(from);
    this.#modifiers.splice(from, 1);
    this.#modifiers.splice(to, 0, modifier);
  }

  #at(index: number): MeshModifier {
    const modifier = this.#modifiers[index];
    if (!modifier) throw new RangeError('No modifier at that index; check stack.modifiers.');
    return modifier;
  }

  /**
   * The result of the whole stack, with provenance back to the base. Only out-of-date stages run.
   * @throws TypeError or RangeError from a modifier with bad options.
   */
  evaluate(): MeshEditResult {
    const active = this.#modifiers.filter((modifier) => modifier.enabled !== false);
    let keep = 0;
    while (keep < active.length && this.#stages[keep]?.key === JSON.stringify(active[keep])) keep++;
    this.#stages.length = Math.min(this.#stages.length, keep);
    let result = this.#stages[keep - 1]?.result ?? identity(this.#base);
    for (let i = keep; i < active.length; i++) {
      assertOptions(active[i], 'Modifier');
      result = compose(this.#base, result, runModifier(result.mesh, active[i]));
      this.#stages.push({ key: JSON.stringify(active[i]), result });
    }
    assertPolygonMesh(result.mesh);
    return { ...result, mesh: clonePolygonMesh(result.mesh) };
  }

  /** Bake: the evaluated mesh becomes the base and the stack empties. Returns the new base. */
  apply(): PolygonMesh {
    const { mesh } = this.evaluate();
    this.base = mesh;
    this.#modifiers = [];
    return clonePolygonMesh(mesh);
  }
}
