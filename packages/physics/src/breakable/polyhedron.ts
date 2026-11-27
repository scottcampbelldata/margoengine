// Clean-room 3D convex-polyhedron Voronoi clipper (Raghavachary 2002; Müller, Chentanez & Kim 2013)
// and exact polyhedral mass properties (Mirtich 1996) with cyclic Jacobi principal-axis diagonalization.
import { Geometry } from '@margoengine/core';
import { buildHull } from '../hull.js';
import type { Vec3 } from '../math.js';
import { geometryPositions, type ColliderGeometry } from '../shapes.js';
import { breakableInput } from './errors.js';
import { SeededRandom } from './prng.js';

/** A single polygonal face of a {@link BreakablePolyhedron}, wound counter-clockwise seen from outside. */
export interface BreakablePolyhedronFace {
  /** Vertex indices into {@link BreakablePolyhedron.vertices}, counter-clockwise from outside. */
  readonly indices: readonly number[];
  /** Unit outward normal. */
  readonly normal: readonly [number, number, number];
  /** Signed plane offset `normal · x = offset`. */
  readonly offset: number;
  /** True for an interior cut face created by Voronoi clipping; false for an original outer surface face. */
  readonly interior: boolean;
  /** Neighboring Voronoi site index across this cut face, or `-1` on an exterior boundary face. */
  readonly neighborSite: number;
}

/** A closed convex polyhedron represented by vertices and outward-wound faces. */
export interface BreakablePolyhedron {
  /** Vertex coordinates in local space. */
  readonly vertices: readonly (readonly [number, number, number])[];
  /** Counter-clockwise outward-wound faces. */
  readonly faces: readonly BreakablePolyhedronFace[];
}

/** Index range and material slot for a chunk mesh (`0` exterior surface, `1` interior fracture cut). */
export interface BreakableMaterialGroup {
  /** First index in the geometry's `indices` buffer. */
  readonly start: number;
  /** Number of indices in this group. */
  readonly count: number;
  /** Material slot: `0` for exterior faces, `1` for interior cut faces. */
  readonly materialIndex: 0 | 1;
}

/** Exact polyhedral mass properties computed by tetrahedral integration (Mirtich 1996). */
export interface BreakableMassProperties {
  /** Enclosed volume in cubic metres. */
  readonly volume: number;
  /** Mass in kilograms (`volume * density`). */
  readonly mass: number;
  /** Centre of mass in the polyhedron's local frame. */
  readonly centroid: readonly [number, number, number];
  /** Symmetric 3×3 inertia tensor about the centroid: `[Ixx, Iyy, Izz, Ixy, Ixz, Iyz]`. */
  readonly inertiaTensor: readonly [number, number, number, number, number, number];
  /** Principal moments of inertia `[Ix, Iy, Iz]` in kg·m². */
  readonly principalInertia: readonly [number, number, number];
  /** Rotation quaternion `[x, y, z, w]` aligning the principal axes to the local frame. */
  readonly inertiaFrame: readonly [number, number, number, number];
}

/** One convex Voronoi fracture cell with exact mass properties, render meshes, UVs and collider points. */
export interface BreakableCell {
  /** Zero-based index of this cell in its parent fracture set. */
  readonly index: number;
  /** Voronoi generator site in the parent body's local frame. */
  readonly site: readonly [number, number, number];
  /** Exact centre of mass in the parent body's local frame. */
  readonly centroid: readonly [number, number, number];
  /** Enclosed polyhedral volume in cubic metres. */
  readonly volume: number;
  /** Exact mass in kilograms (`volume * density`). */
  readonly mass: number;
  /** Principal moments of inertia about `centroid` in kg·m². */
  readonly principalInertia: readonly [number, number, number];
  /** Principal inertia frame quaternion `[x, y, z, w]`. */
  readonly inertiaFrame: readonly [number, number, number, number];
  /** Symmetric 3×3 inertia tensor about `centroid`: `[Ixx, Iyy, Izz, Ixy, Ixz, Iyz]`. */
  readonly inertiaTensor: readonly [number, number, number, number, number, number];
  /** Axis-aligned minimum corner in the parent body's local frame. */
  readonly boundsMin: readonly [number, number, number];
  /** Axis-aligned maximum corner in the parent body's local frame. */
  readonly boundsMax: readonly [number, number, number];
  /** Flat `[x, y, z, ...]` convex-hull vertex positions centred on `centroid`. */
  readonly hullPoints: Float32Array;
  /** Unique undirected edge pairs `[a0, b0, a1, b1, ...]` indexing `hullPoints` (for debug rendering). */
  readonly edges: Uint32Array;
  /** Render geometry centred on `centroid` (exterior faces followed by interior cut faces). */
  readonly geometry: Geometry;
  /** Render geometry of only exterior faces centred on `centroid`, or `null` if wholly interior. */
  readonly exteriorGeometry: Geometry | null;
  /** Render geometry of only interior cut faces centred on `centroid`, or `null` if uncut. */
  readonly interiorGeometry: Geometry | null;
  /** Planar-projected UV coordinates `[u, v, ...]` matching `geometry` vertices. */
  readonly uvs: Float32Array;
  /** Material groups splitting `geometry.indices` into exterior (`0`) and interior (`1`) faces. */
  readonly materialGroups: readonly BreakableMaterialGroup[];
  /** Underlying convex polyhedron in the parent body's local frame. */
  readonly polyhedron: BreakablePolyhedron;
}

/** Shared-face adjacency between two Voronoi cells, used to build the connection graph. */
export interface CellAdjacency {
  readonly cellA: number;
  readonly cellB: number;
  readonly area: number;
  readonly centroid: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}

/** Pattern used when generating Voronoi fracture sites inside a body's bounds. */
export type BreakableFracturePattern = 'uniform' | 'brick' | 'radial';

/** Result of Voronoi-fracturing a closed convex polyhedron. */
export interface VoronoiFractureResult {
  /** Surviving convex fracture cells with positive volume. */
  readonly cells: readonly BreakableCell[];
  /** Deduplicated adjacent cell bonds with exact shared cut-face area and centroid. */
  readonly adjacencies: readonly CellAdjacency[];
}

type MutableVec3 = [number, number, number];

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3, b: Vec3): MutableVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(v: Vec3): MutableVec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-12)) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function tangentBasis(normal: Vec3): [MutableVec3, MutableVec3] {
  const ref: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize3(cross3(ref, normal));
  const v = cross3(normal, u);
  return [u, v];
}

/** Builds an exact 6-face CCW convex polyhedron for an axis-aligned box centred on the origin. */
export function createBoxPolyhedron(width: number, height: number, depth: number): BreakablePolyhedron {
  if (
    !(
      width > 0 &&
      height > 0 &&
      depth > 0 &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      Number.isFinite(depth)
    )
  )
    throw breakableInput(`Box dimensions must be positive finite numbers (got [${width}, ${height}, ${depth}])`);
  const hx = width * 0.5;
  const hy = height * 0.5;
  const hz = depth * 0.5;
  const vertices: readonly [number, number, number][] = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ];
  const faces: BreakablePolyhedronFace[] = [
    {
      indices: [0, 3, 2, 1],
      normal: [0, 0, -1],
      offset: hz,
      interior: false,
      neighborSite: -1,
    },
    {
      indices: [4, 5, 6, 7],
      normal: [0, 0, 1],
      offset: hz,
      interior: false,
      neighborSite: -1,
    },
    {
      indices: [0, 4, 7, 3],
      normal: [-1, 0, 0],
      offset: hx,
      interior: false,
      neighborSite: -1,
    },
    {
      indices: [1, 2, 6, 5],
      normal: [1, 0, 0],
      offset: hx,
      interior: false,
      neighborSite: -1,
    },
    {
      indices: [0, 1, 5, 4],
      normal: [0, -1, 0],
      offset: hy,
      interior: false,
      neighborSite: -1,
    },
    {
      indices: [3, 7, 6, 2],
      normal: [0, 1, 0],
      offset: hy,
      interior: false,
      neighborSite: -1,
    },
  ];
  return { vertices, faces };
}

/**
 * Builds an outward-wound convex polyhedron from the convex hull of a core `Geometry` (any glTF mesh's) or a raw
 * `{ vertices, stride? }` buffer. A concave mesh breaks as its hull: split it with `convexDecomposition` first.
 */
export function createPolyhedronFromGeometry(geometry: ColliderGeometry): BreakablePolyhedron {
  // The stride geometryPositions reads: a core Geometry interleaves position and normal (6), a raw buffer is xyz (3).
  const stride =
    geometry && typeof geometry === 'object'
      ? (('stride' in geometry ? geometry.stride : undefined) ?? ('bounds' in geometry ? 6 : 3))
      : 0;
  if (!geometry?.vertices || !(Number.isInteger(stride) && stride >= 3 && geometry.vertices.length % stride === 0))
    throw breakableInput(
      'Breakable geometry is a core Geometry or { vertices, stride } with whole vertices of stride >= 3',
    );
  const positions = geometryPositions(geometry);
  for (let i = 0; i < positions.length; i++)
    if (!Number.isFinite(positions[i]))
      throw breakableInput(`Breakable geometry vertex ${(i / 3) | 0} is not finite; pass finite positions`);
  if (positions.length < 12) throw breakableInput('Breakable geometry needs at least four vertices that span a volume');
  let hull: ReturnType<typeof buildHull>;
  try {
    hull = buildHull(positions);
  } catch (error) {
    // Not hidden: the hull's own reason (all in one plane, on one line) is passed on as this entry's coded error.
    throw breakableInput(`Breakable geometry has no volume to break: ${(error as Error).message}`);
  }
  const vertices: readonly [number, number, number][] = hull.vertices.map((v) => [v[0], v[1], v[2]]);
  const faces: BreakablePolyhedronFace[] = [];
  for (let i = 0; i < hull.faces.length; i++) {
    const loop = hull.faces[i]!;
    if (loop.length < 3) continue;
    const v0 = vertices[loop[0]!]!;
    // Newell normal for numerical stability on polygons with near-collinear consecutive edges.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let k = 0; k < loop.length; k++) {
      const a = vertices[loop[k]!]!;
      const b = vertices[loop[(k + 1) % loop.length]!]!;
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const normal = normalize3([nx, ny, nz]);
    const offset = dot3(normal, v0);
    faces.push({
      indices: [...loop],
      normal,
      offset,
      interior: false,
      neighborSite: -1,
    });
  }
  return { vertices, faces };
}

/** Computes the axis-aligned bounding box of a polyhedron's vertices. */
export function polyhedronBounds(poly: BreakablePolyhedron): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < poly.vertices.length; i++) {
    const v = poly.vertices[i]!;
    if (v[0] < min[0]) min[0] = v[0];
    if (v[1] < min[1]) min[1] = v[1];
    if (v[2] < min[2]) min[2] = v[2];
    if (v[0] > max[0]) max[0] = v[0];
    if (v[1] > max[1]) max[1] = v[1];
    if (v[2] > max[2]) max[2] = v[2];
  }
  return { min, max };
}

/**
 * Clips a closed convex polyhedron against the half-space `normal · x <= offset`.
 * Returns the unchanged polyhedron if wholly inside, `null` if wholly outside, or the clipped
 * watertight polyhedron with a new CCW interior cap face tagged with `neighborSite`.
 */
export function clipPolyhedronHalfSpace(
  poly: BreakablePolyhedron,
  normal: Vec3,
  offset: number,
  neighborSite: number,
): BreakablePolyhedron | null {
  const verts = poly.vertices;
  const nVerts = verts.length;
  if (nVerts < 4) return null;

  // Scale tolerance relative to polyhedron diameter so large and tiny objects clip cleanly.
  let maxCoord = 1;
  for (let i = 0; i < nVerts; i++) {
    const v = verts[i]!;
    const a = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
    if (a > maxCoord) maxCoord = a;
  }
  const eps = 1e-7 * maxCoord;

  const dist = new Float64Array(nVerts);
  const side = new Int8Array(nVerts);
  let hasInside = false;
  let hasOutside = false;
  for (let i = 0; i < nVerts; i++) {
    const v = verts[i]!;
    const d = v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2] - offset;
    dist[i] = d;
    if (d > eps) {
      side[i] = 1;
      hasOutside = true;
    } else if (d < -eps) {
      side[i] = -1;
      hasInside = true;
    } else {
      side[i] = 0;
    }
  }

  if (!hasOutside) return poly;
  if (!hasInside) return null;

  const nextVerts: MutableVec3[] = verts.map((v) => [v[0], v[1], v[2]]);
  const edgeCache = new Map<number, number>();
  const capVertexSet = new Set<number>();

  const intersectEdge = (a: number, b: number): number => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * nVerts + hi;
    const cached = edgeCache.get(key);
    if (cached !== undefined) return cached;
    const da = dist[a]!;
    const db = dist[b]!;
    const denom = da - db;
    const t = Math.abs(denom) > 1e-15 ? Math.min(1, Math.max(0, da / denom)) : 0.5;
    const va = verts[a]!;
    const vb = verts[b]!;
    const idx = nextVerts.length;
    nextVerts.push([va[0] + t * (vb[0] - va[0]), va[1] + t * (vb[1] - va[1]), va[2] + t * (vb[2] - va[2])]);
    edgeCache.set(key, idx);
    capVertexSet.add(idx);
    return idx;
  };

  const nextFaces: BreakablePolyhedronFace[] = [];

  for (let f = 0; f < poly.faces.length; f++) {
    const face = poly.faces[f]!;
    const loop = face.indices;
    const count = loop.length;
    const out: number[] = [];

    for (let i = 0; i < count; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % count]!;
      const sa = side[a]!;
      const sb = side[b]!;

      if (sa <= 0) {
        out.push(a);
        if (sa === 0) capVertexSet.add(a);
      }
      if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
        out.push(intersectEdge(a, b));
      }
    }

    // Deduplicate consecutive identical indices.
    const dedup: number[] = [];
    for (let i = 0; i < out.length; i++) {
      const idx = out[i]!;
      const prev = dedup.length > 0 ? dedup[dedup.length - 1] : -1;
      if (idx !== prev) dedup.push(idx);
    }
    if (dedup.length > 1 && dedup[0] === dedup[dedup.length - 1]) dedup.pop();

    if (dedup.length >= 3) {
      nextFaces.push({
        indices: dedup,
        normal: face.normal,
        offset: face.offset,
        interior: face.interior,
        neighborSite: face.neighborSite,
      });
    }
  }

  // Construct the convex cap polygon on the clipping plane by angular ordering around its centroid.
  if (capVertexSet.size >= 3) {
    const rawCap = [...capVertexSet];
    // Filter nearly coincident vertices that can arise when a plane passes near an existing corner.
    const capVerts: number[] = [];
    const mergeSq = eps * 2 * (eps * 2);
    for (let i = 0; i < rawCap.length; i++) {
      const idx = rawCap[i]!;
      const p = nextVerts[idx]!;
      let duplicate = false;
      for (let j = 0; j < capVerts.length; j++) {
        const q = nextVerts[capVerts[j]!]!;
        const dx = p[0] - q[0];
        const dy = p[1] - q[1];
        const dz = p[2] - q[2];
        if (dx * dx + dy * dy + dz * dz <= mergeSq) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) capVerts.push(idx);
    }

    if (capVerts.length >= 3) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let i = 0; i < capVerts.length; i++) {
        const p = nextVerts[capVerts[i]!]!;
        cx += p[0];
        cy += p[1];
        cz += p[2];
      }
      const inv = 1 / capVerts.length;
      cx *= inv;
      cy *= inv;
      cz *= inv;

      const [u, v] = tangentBasis(normal);
      const angles = new Map<number, number>();
      for (let i = 0; i < capVerts.length; i++) {
        const idx = capVerts[i]!;
        const p = nextVerts[idx]!;
        const rx = p[0] - cx;
        const ry = p[1] - cy;
        const rz = p[2] - cz;
        angles.set(idx, Math.atan2(rx * v[0] + ry * v[1] + rz * v[2], rx * u[0] + ry * u[1] + rz * u[2]));
      }
      capVerts.sort((a, b) => angles.get(a)! - angles.get(b)!);
      nextFaces.push({
        indices: capVerts,
        normal: [normal[0], normal[1], normal[2]],
        offset,
        interior: true,
        neighborSite,
      });
    }
  }

  if (nextFaces.length < 4) return null;

  // Compact vertex list to referenced vertices only.
  const remap = new Int32Array(nextVerts.length).fill(-1);
  const compactVerts: [number, number, number][] = [];
  const compactFaces: BreakablePolyhedronFace[] = [];
  for (let f = 0; f < nextFaces.length; f++) {
    const face = nextFaces[f]!;
    const indices: number[] = [];
    for (let i = 0; i < face.indices.length; i++) {
      const oldIdx = face.indices[i]!;
      let mapped = remap[oldIdx]!;
      if (mapped < 0) {
        mapped = compactVerts.length;
        remap[oldIdx] = mapped;
        const p = nextVerts[oldIdx]!;
        compactVerts.push([p[0], p[1], p[2]]);
      }
      indices.push(mapped);
    }
    compactFaces.push({
      indices,
      normal: face.normal,
      offset: face.offset,
      interior: face.interior,
      neighborSite: face.neighborSite,
    });
  }

  return compactVerts.length >= 4 ? { vertices: compactVerts, faces: compactFaces } : null;
}

/**
 * Diagonalizes a symmetric 3×3 matrix `[m00, m11, m22, m01, m02, m12]` using cyclic Jacobi rotations,
 * returning positive eigenvalues and a proper (`det = +1`) rotation quaternion `[x, y, z, w]`.
 */
export function diagonalizeSymmetric3x3(
  m00: number,
  m11: number,
  m22: number,
  m01: number,
  m02: number,
  m12: number,
): {
  eigenvalues: [number, number, number];
  quaternion: [number, number, number, number];
} {
  const a = [
    [m00, m01, m02],
    [m01, m11, m12],
    [m02, m12, m22],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  const pairs: readonly (readonly [number, number])[] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];

  for (let sweep = 0; sweep < 24; sweep++) {
    let offDiag = 0;
    for (let p = 0; p < 3; p++) {
      const [i, j] = pairs[p]!;
      offDiag = Math.max(offDiag, Math.abs(a[i]![j]!));
    }
    if (offDiag < 1e-13) break;

    for (let p = 0; p < 3; p++) {
      const [i, j] = pairs[p]!;
      const aij = a[i]![j]!;
      if (Math.abs(aij) < 1e-15) continue;
      const diff = a[j]![j]! - a[i]![i]!;
      let t: number;
      if (Math.abs(aij) < Math.abs(diff) * 1e-15) {
        t = aij / diff;
      } else {
        const phi = diff / (2 * aij);
        t = 1 / (Math.abs(phi) + Math.sqrt(phi * phi + 1));
        if (phi < 0) t = -t;
      }
      const c = 1 / Math.sqrt(1 + t * t);
      const s = t * c;
      const tau = s / (1 + c);

      a[i]![i]! -= t * aij;
      a[j]![j]! += t * aij;
      a[i]![j] = 0;
      a[j]![i] = 0;

      const k = 3 - i - j;
      const aik = a[i]![k]!;
      const ajk = a[j]![k]!;
      a[i]![k] = a[k]![i] = aik - s * (ajk + tau * aik);
      a[j]![k] = a[k]![j] = ajk + s * (aik - tau * ajk);

      for (let r = 0; r < 3; r++) {
        const vir = v[r]![i]!;
        const vjr = v[r]![j]!;
        v[r]![i] = vir - s * (vjr + tau * vir);
        v[r]![j] = vjr + s * (vir - tau * vjr);
      }
    }
  }

  // Ensure proper right-handed basis (det = +1) before converting to quaternion.
  const det =
    v[0]![0]! * (v[1]![1]! * v[2]![2]! - v[1]![2]! * v[2]![1]!) -
    v[0]![1]! * (v[1]![0]! * v[2]![2]! - v[1]![2]! * v[2]![0]!) +
    v[0]![2]! * (v[1]![0]! * v[2]![1]! - v[1]![1]! * v[2]![0]!);
  if (det < 0) {
    v[0]![2] = -v[0]![2]!;
    v[1]![2] = -v[1]![2]!;
    v[2]![2] = -v[2]![2]!;
  }

  const quaternion = rotationMatrixToQuat(v);
  const minMoment = 1e-6;
  const eigenvalues: [number, number, number] = [
    Math.max(minMoment, a[0]![0]!),
    Math.max(minMoment, a[1]![1]!),
    Math.max(minMoment, a[2]![2]!),
  ];
  return { eigenvalues, quaternion };
}

function rotationMatrixToQuat(m: number[][]): [number, number, number, number] {
  const m00 = m[0]![0]!;
  const m11 = m[1]![1]!;
  const m22 = m[2]![2]!;
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m[2]![1]! - m[1]![2]!) / s;
    y = (m[0]![2]! - m[2]![0]!) / s;
    z = (m[1]![0]! - m[0]![1]!) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m[2]![1]! - m[1]![2]!) / s;
    x = 0.25 * s;
    y = (m[0]![1]! + m[1]![0]!) / s;
    z = (m[0]![2]! + m[2]![0]!) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m[0]![2]! - m[2]![0]!) / s;
    x = (m[0]![1]! + m[1]![0]!) / s;
    y = 0.25 * s;
    z = (m[1]![2]! + m[2]![1]!) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m[1]![0]! - m[0]![1]!) / s;
    x = (m[0]![2]! + m[2]![0]!) / s;
    y = (m[1]![2]! + m[2]![1]!) / s;
    z = 0.25 * s;
  }
  const len = Math.hypot(x, y, z, w);
  if (!(len > 1e-12)) return [0, 0, 0, 1];
  return [x / len, y / len, z / len, w / len];
}

/**
 * Computes exact volume, centre of mass, 3×3 inertia tensor, principal moments, and principal frame
 * of a closed convex polyhedron via tetrahedral volume integration (Mirtich 1996).
 */
export function computePolyhedronMassProperties(poly: BreakablePolyhedron, density: number): BreakableMassProperties {
  if (!(density > 0 && Number.isFinite(density)))
    throw breakableInput(`Density must be a positive finite number (got ${density})`);

  const verts = poly.vertices;
  let rx = 0;
  let ry = 0;
  let rz = 0;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]!;
    rx += v[0];
    ry += v[1];
    rz += v[2];
  }
  const invN = verts.length > 0 ? 1 / verts.length : 1;
  rx *= invN;
  ry *= invN;
  rz *= invN;

  let volume = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  // Covariance integrals ∫ x_p x_q dV about reference point r.
  let c00 = 0;
  let c11 = 0;
  let c22 = 0;
  let c01 = 0;
  let c02 = 0;
  let c12 = 0;

  for (let f = 0; f < poly.faces.length; f++) {
    const loop = poly.faces[f]!.indices;
    if (loop.length < 3) continue;
    const p0 = verts[loop[0]!]!;
    const ax = p0[0] - rx;
    const ay = p0[1] - ry;
    const az = p0[2] - rz;

    for (let m = 1; m < loop.length - 1; m++) {
      const p1 = verts[loop[m]!]!;
      const p2 = verts[loop[m + 1]!]!;
      const bx = p1[0] - rx;
      const by = p1[1] - ry;
      const bz = p1[2] - rz;
      const px = p2[0] - rx;
      const py = p2[1] - ry;
      const pz = p2[2] - rz;

      // Signed volume of tetrahedron (r, p0, p1, p2).
      const dV = (ax * (by * pz - bz * py) - ay * (bx * pz - bz * px) + az * (bx * py - by * px)) / 6;
      volume += dV;
      cx += dV * (ax + bx + px) * 0.25;
      cy += dV * (ay + by + py) * 0.25;
      cz += dV * (az + bz + pz) * 0.25;

      const w = dV / 20;
      c00 += w * (2 * (ax * ax + bx * bx + px * px) + 2 * (ax * bx + bx * px + px * ax));
      c11 += w * (2 * (ay * ay + by * by + py * py) + 2 * (ay * by + by * py + py * ay));
      c22 += w * (2 * (az * az + bz * bz + pz * pz) + 2 * (az * bz + bz * pz + pz * az));
      c01 += w * (2 * (ax * ay + bx * by + px * py) + ax * by + ay * bx + bx * py + by * px + px * ay + py * ax);
      c02 += w * (2 * (ax * az + bx * bz + px * pz) + ax * bz + az * bx + bx * pz + bz * px + px * az + pz * ax);
      c12 += w * (2 * (ay * az + by * bz + py * pz) + ay * bz + az * by + by * pz + bz * py + py * az + pz * ay);
    }
  }

  if (!(volume > 1e-12)) {
    return {
      volume: 0,
      mass: 0,
      centroid: [rx, ry, rz],
      inertiaTensor: [1e-6, 1e-6, 1e-6, 0, 0, 0],
      principalInertia: [1e-6, 1e-6, 1e-6],
      inertiaFrame: [0, 0, 0, 1],
    };
  }

  const dgx = cx / volume;
  const dgy = cy / volume;
  const dgz = cz / volume;
  const centroid: [number, number, number] = [rx + dgx, ry + dgy, rz + dgz];

  // Shift covariance to centre of mass via parallel-axis theorem.
  const k00 = c00 - volume * dgx * dgx;
  const k11 = c11 - volume * dgy * dgy;
  const k22 = c22 - volume * dgz * dgz;
  const k01 = c01 - volume * dgx * dgy;
  const k02 = c02 - volume * dgx * dgz;
  const k12 = c12 - volume * dgy * dgz;

  const ixx = density * (k11 + k22);
  const iyy = density * (k00 + k22);
  const izz = density * (k00 + k11);
  const ixy = -density * k01;
  const ixz = -density * k02;
  const iyz = -density * k12;

  const { eigenvalues, quaternion } = diagonalizeSymmetric3x3(ixx, iyy, izz, ixy, ixz, iyz);
  return {
    volume,
    mass: volume * density,
    centroid,
    inertiaTensor: [ixx, iyy, izz, ixy, ixz, iyz],
    principalInertia: eigenvalues,
    inertiaFrame: quaternion,
  };
}

/** Combines exact mass properties of multiple cells into one compound island via the parallel-axis theorem. */
export function combineCellMassProperties(cells: readonly BreakableCell[]): BreakableMassProperties {
  let volume = 0;
  let mass = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    volume += c.volume;
    mass += c.mass;
    cx += c.mass * c.centroid[0];
    cy += c.mass * c.centroid[1];
    cz += c.mass * c.centroid[2];
  }

  if (!(mass > 1e-12)) {
    return {
      volume: 0,
      mass: 0,
      centroid: [0, 0, 0],
      inertiaTensor: [1e-6, 1e-6, 1e-6, 0, 0, 0],
      principalInertia: [1e-6, 1e-6, 1e-6],
      inertiaFrame: [0, 0, 0, 1],
    };
  }

  const centroid: [number, number, number] = [cx / mass, cy / mass, cz / mass];
  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  let ixy = 0;
  let ixz = 0;
  let iyz = 0;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const dx = c.centroid[0] - centroid[0];
    const dy = c.centroid[1] - centroid[1];
    const dz = c.centroid[2] - centroid[2];
    const m = c.mass;
    const t = c.inertiaTensor;
    ixx += t[0] + m * (dy * dy + dz * dz);
    iyy += t[1] + m * (dx * dx + dz * dz);
    izz += t[2] + m * (dx * dx + dy * dy);
    ixy += t[3] - m * dx * dy;
    ixz += t[4] - m * dx * dz;
    iyz += t[5] - m * dy * dz;
  }

  const { eigenvalues, quaternion } = diagonalizeSymmetric3x3(ixx, iyy, izz, ixy, ixz, iyz);
  return {
    volume,
    mass,
    centroid,
    inertiaTensor: [ixx, iyy, izz, ixy, ixz, iyz],
    principalInertia: eigenvalues,
    inertiaFrame: quaternion,
  };
}

function buildFaceMeshData(
  poly: BreakablePolyhedron,
  origin: Vec3,
  uvScale: number,
  includeFace: (face: BreakablePolyhedronFace) => boolean,
): {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  exteriorCount: number;
  interiorCount: number;
} {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const appendFaces = (wantInterior: boolean): number => {
    const startIndices = indices.length;
    for (let f = 0; f < poly.faces.length; f++) {
      const face = poly.faces[f]!;
      if (face.interior !== wantInterior || !includeFace(face)) continue;
      const loop = face.indices;
      if (loop.length < 3) continue;
      const [u, v] = tangentBasis(face.normal);
      const baseVertex = positions.length / 3;
      for (let i = 0; i < loop.length; i++) {
        const p = poly.vertices[loop[i]!]!;
        const lx = p[0] - origin[0];
        const ly = p[1] - origin[1];
        const lz = p[2] - origin[2];
        positions.push(lx, ly, lz);
        normals.push(face.normal[0], face.normal[1], face.normal[2]);
        uvs.push(
          (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) * uvScale,
          (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) * uvScale,
        );
      }
      for (let m = 1; m < loop.length - 1; m++) {
        indices.push(baseVertex, baseVertex + m, baseVertex + m + 1);
      }
    }
    return indices.length - startIndices;
  };

  const exteriorCount = appendFaces(false);
  const interiorCount = appendFaces(true);
  return { positions, normals, uvs, indices, exteriorCount, interiorCount };
}

function buildGeometryFromParts(
  positions: readonly number[],
  normals: readonly number[],
  indices: readonly number[],
): Geometry | null {
  if (positions.length === 0 || indices.length === 0) return null;
  return new Geometry(positions, normals, indices);
}

/** Builds combined exterior/interior render meshes for a multi-cell island, omitting hidden bonded seams. */
export function buildIslandMeshes(
  cells: readonly BreakableCell[],
  islandCentroid: Vec3,
  uvScale: number,
): {
  geometry: Geometry;
  exteriorGeometry: Geometry | null;
  interiorGeometry: Geometry | null;
  uvs: Float32Array;
  materialGroups: readonly BreakableMaterialGroup[];
} {
  const memberSet = new Set<number>();
  for (let i = 0; i < cells.length; i++) memberSet.add(cells[i]!.index);

  const extPos: number[] = [];
  const extNorm: number[] = [];
  const extUv: number[] = [];
  const extIdx: number[] = [];

  const intPos: number[] = [];
  const intNorm: number[] = [];
  const intUv: number[] = [];
  const intIdx: number[] = [];

  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c]!;
    const poly = cell.polyhedron;
    for (let f = 0; f < poly.faces.length; f++) {
      const face = poly.faces[f]!;
      // Skip internal faces shared between two cells inside the same bonded island.
      if (face.interior && face.neighborSite >= 0 && memberSet.has(face.neighborSite)) continue;
      const loop = face.indices;
      if (loop.length < 3) continue;
      const [u, v] = tangentBasis(face.normal);
      const posArr = face.interior ? intPos : extPos;
      const normArr = face.interior ? intNorm : extNorm;
      const uvArr = face.interior ? intUv : extUv;
      const idxArr = face.interior ? intIdx : extIdx;
      const baseVertex = posArr.length / 3;
      for (let i = 0; i < loop.length; i++) {
        const p = poly.vertices[loop[i]!]!;
        posArr.push(p[0] - islandCentroid[0], p[1] - islandCentroid[1], p[2] - islandCentroid[2]);
        normArr.push(face.normal[0], face.normal[1], face.normal[2]);
        uvArr.push(
          (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) * uvScale,
          (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) * uvScale,
        );
      }
      for (let m = 1; m < loop.length - 1; m++) {
        idxArr.push(baseVertex, baseVertex + m, baseVertex + m + 1);
      }
    }
  }

  const combinedPos = extPos.concat(intPos);
  const combinedNorm = extNorm.concat(intNorm);
  const combinedUv = extUv.concat(intUv);
  const intOffset = extPos.length / 3;
  const combinedIdx = extIdx.concat(intIdx.map((idx) => idx + intOffset));

  const materialGroups: BreakableMaterialGroup[] = [];
  if (extIdx.length > 0) materialGroups.push({ start: 0, count: extIdx.length, materialIndex: 0 });
  if (intIdx.length > 0)
    materialGroups.push({
      start: extIdx.length,
      count: intIdx.length,
      materialIndex: 1,
    });

  const geometry = new Geometry(combinedPos, combinedNorm, combinedIdx);
  const exteriorGeometry = buildGeometryFromParts(extPos, extNorm, extIdx);
  const interiorGeometry = buildGeometryFromParts(intPos, intNorm, intIdx);
  return {
    geometry,
    exteriorGeometry,
    interiorGeometry,
    uvs: Float32Array.from(combinedUv),
    materialGroups,
  };
}

function buildUniqueEdges(poly: BreakablePolyhedron): Uint32Array {
  const n = poly.vertices.length;
  const seen = new Set<number>();
  const out: number[] = [];
  for (let f = 0; f < poly.faces.length; f++) {
    const loop = poly.faces[f]!.indices;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * n + hi;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(lo, hi);
      }
    }
  }
  return Uint32Array.from(out);
}

function polygonAreaAndCentroid(
  poly: BreakablePolyhedron,
  face: BreakablePolyhedronFace,
): { area: number; centroid: [number, number, number] } {
  const loop = face.indices;
  if (loop.length < 3) return { area: 0, centroid: [0, 0, 0] };
  const p0 = poly.vertices[loop[0]!]!;
  let totalArea = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let m = 1; m < loop.length - 1; m++) {
    const p1 = poly.vertices[loop[m]!]!;
    const p2 = poly.vertices[loop[m + 1]!]!;
    const ex = p1[0] - p0[0];
    const ey = p1[1] - p0[1];
    const ez = p1[2] - p0[2];
    const fx = p2[0] - p0[0];
    const fy = p2[1] - p0[1];
    const fz = p2[2] - p0[2];
    const kx = ey * fz - ez * fy;
    const ky = ez * fx - ex * fz;
    const kz = ex * fy - ey * fx;
    const triArea = 0.5 * Math.hypot(kx, ky, kz);
    totalArea += triArea;
    cx += (triArea * (p0[0] + p1[0] + p2[0])) / 3;
    cy += (triArea * (p0[1] + p1[1] + p2[1])) / 3;
    cz += (triArea * (p0[2] + p1[2] + p2[2])) / 3;
  }
  if (!(totalArea > 1e-12)) return { area: 0, centroid: [p0[0], p0[1], p0[2]] };
  return {
    area: totalArea,
    centroid: [cx / totalArea, cy / totalArea, cz / totalArea],
  };
}

/**
 * Generates deterministic Voronoi generator sites inside `[min, max]` for uniform, brick, radial, or
 * impact-clustered fracture patterns (Raghavachary 2002; Müller, Chentanez & Kim 2013).
 */
export function generateVoronoiSites(
  min: Vec3,
  max: Vec3,
  count: number,
  seed: number,
  pattern: BreakableFracturePattern | 'impact',
  impactCenter?: Vec3,
  impactRadius?: number,
): [number, number, number][] {
  if (!Number.isInteger(count) || count < 2 || count > 256)
    throw breakableInput(`Fracture cellCount must be an integer from 2 to 256 (got ${count})`);
  if (!Number.isSafeInteger(seed)) throw breakableInput(`Fracture seed must be a safe integer (got ${seed})`);

  const rng = new SeededRandom(seed);
  const sx = max[0] - min[0];
  const sy = max[1] - min[1];
  const sz = max[2] - min[2];
  const cx = (min[0] + max[0]) * 0.5;
  const cy = (min[1] + max[1]) * 0.5;
  const cz = (min[2] + max[2]) * 0.5;
  const margin = 0.04;
  const clampPoint = (x: number, y: number, z: number): [number, number, number] => [
    Math.min(max[0] - sx * margin, Math.max(min[0] + sx * margin, x)),
    Math.min(max[1] - sy * margin, Math.max(min[1] + sy * margin, y)),
    Math.min(max[2] - sz * margin, Math.max(min[2] + sz * margin, z)),
  ];

  const sites: [number, number, number][] = [];

  if (pattern === 'impact') {
    const center = impactCenter ?? [cx, cy, cz];
    const maxSpan = Math.max(sx, sy, sz);
    const radius = impactRadius && impactRadius > 0 ? impactRadius : maxSpan * 0.35;
    const clusteredCount = Math.max(2, Math.round(count * 0.65));
    // Place one site very close to the impact point so fine shards radiate outward.
    sites.push(clampPoint(center[0], center[1], center[2]));
    for (let i = 1; i < clusteredCount; i++) {
      const gx = rng.gaussian() * radius * 0.45;
      const gy = rng.gaussian() * radius * 0.45;
      const gz = rng.gaussian() * radius * 0.45;
      sites.push(clampPoint(center[0] + gx, center[1] + gy, center[2] + gz));
    }
    for (let i = clusteredCount; i < count; i++) {
      sites.push(clampPoint(rng.range(min[0], max[0]), rng.range(min[1], max[1]), rng.range(min[2], max[2])));
    }
    return sites;
  }

  if (pattern === 'brick') {
    // Staggered masonry courses along the widest horizontal axis and vertical Y.
    const rows = Math.max(2, Math.round(Math.sqrt(count * (sy / Math.max(sx, sz, 1e-4)))));
    const cols = Math.max(1, Math.ceil(count / rows));
    const wideX = sx >= sz;
    for (let r = 0; r < rows && sites.length < count; r++) {
      const y = min[1] + ((r + 0.5) / rows) * sy;
      const stagger = (r % 2) * 0.5;
      for (let c = 0; c < cols && sites.length < count; c++) {
        const u = ((c + 0.5 + stagger * 0.5) % cols) / cols;
        const jitterA = (rng.next() - 0.5) * 0.06;
        const jitterY = (rng.next() - 0.5) * (sy / rows) * 0.08;
        const jitterT = (rng.next() - 0.5) * 0.12;
        if (wideX) {
          sites.push(clampPoint(min[0] + (u + jitterA) * sx, y + jitterY, cz + jitterT * sz));
        } else {
          sites.push(clampPoint(cx + jitterT * sx, y + jitterY, min[2] + (u + jitterA) * sz));
        }
      }
    }
    return sites;
  }

  if (pattern === 'radial') {
    // Concentric rings around the impact or face centre — ideal for brittle panes and glass.
    const focus = impactCenter ?? [cx, cy, cz];
    // Identify thinnest axis so rings radiate cleanly across the broad face.
    const thinAxis = sx <= sy && sx <= sz ? 0 : sy <= sx && sy <= sz ? 1 : 2;
    const spanA = thinAxis === 0 ? sy : sx;
    const spanB = thinAxis === 2 ? sy : sz;
    sites.push(clampPoint(focus[0], focus[1], focus[2]));
    const rings = Math.max(2, Math.round(Math.sqrt(count / 3)));
    let remaining = count - 1;
    for (let ring = 1; ring <= rings && remaining > 0; ring++) {
      const ringSites =
        ring === rings ? remaining : Math.max(3, Math.round(((count - 1) * ring) / ((rings * (rings + 1)) / 2)));
      const take = Math.min(remaining, ringSites);
      const frac = ring / (rings + 0.35);
      const angleOffset = rng.next() * Math.PI * 2;
      for (let k = 0; k < take; k++) {
        const theta = angleOffset + (k / take) * Math.PI * 2 + (rng.next() - 0.5) * (Math.PI / take) * 0.55;
        const radScale = frac * (0.88 + rng.next() * 0.24);
        const da = Math.cos(theta) * spanA * 0.52 * radScale;
        const db = Math.sin(theta) * spanB * 0.52 * radScale;
        const dThin = (rng.next() - 0.5) * (thinAxis === 0 ? sx : thinAxis === 1 ? sy : sz) * 0.15;
        if (thinAxis === 0) sites.push(clampPoint(focus[0] + dThin, focus[1] + da, focus[2] + db));
        else if (thinAxis === 1) sites.push(clampPoint(focus[0] + da, focus[1] + dThin, focus[2] + db));
        else sites.push(clampPoint(focus[0] + da, focus[1] + db, focus[2] + dThin));
      }
      remaining -= take;
    }
    return sites;
  }

  // Stratified 3D jittered grid so chunks stay well-proportioned with deterministic seeding.
  const vol = Math.max(1e-9, sx * sy * sz);
  const step = Math.cbrt(vol / count);
  const nx = Math.max(1, Math.round(sx / step));
  const ny = Math.max(1, Math.round(sy / step));
  const nz = Math.max(1, Math.round(sz / step));
  const grid: [number, number, number][] = [];
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        grid.push(
          clampPoint(
            min[0] + ((ix + 0.15 + rng.next() * 0.7) / nx) * sx,
            min[1] + ((iy + 0.15 + rng.next() * 0.7) / ny) * sy,
            min[2] + ((iz + 0.15 + rng.next() * 0.7) / nz) * sz,
          ),
        );
      }
    }
  }
  // Fisher-Yates shuffle deterministically, then take or pad to exact `count`.
  for (let i = grid.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = grid[i]!;
    grid[i] = grid[j]!;
    grid[j] = tmp;
  }
  while (grid.length < count) {
    grid.push(clampPoint(rng.range(min[0], max[0]), rng.range(min[1], max[1]), rng.range(min[2], max[2])));
  }
  return grid.slice(0, count);
}

/** The thinnest a kept cell may be: the ball about its centroid that fits inside spans this share of its size. */
const SLIVER = 1e-3;

/**
 * Whether a convex cell is a sliver: the largest ball about its centroid that stays inside (the least distance to a face
 * plane) is under {@link SLIVER} of the cell's bounding diagonal. A cell from a site inside the body holds a ball about
 * its site, so only a site outside the body, or two nearly on top of each other, makes one. A kept cell is then at
 * least 1/500 of its size thick, far above the kernel hull's flatness tolerance (1e-4 x 0.25 of the size), so every
 * kept cell's convex hull builds.
 */
function isSliver(poly: BreakablePolyhedron, centroid: Vec3): boolean {
  let inner = Infinity;
  for (let f = 0; f < poly.faces.length; f++) {
    const face = poly.faces[f]!;
    const d = face.offset - dot3(face.normal, centroid);
    if (d < inner) inner = d;
  }
  const { min, max } = polyhedronBounds(poly);
  return !(inner >= SLIVER * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
}

/**
 * Splits a closed convex polyhedron along the 3D Voronoi diagram of `sites` using exact half-space
 * polyhedral clipping (Raghavachary 2002; Müller, Chentanez & Kim 2013). Returns watertight convex
 * cells with exact mass properties (Mirtich 1996), interior/exterior material groups, UVs, and
 * shared-face adjacency bonds.
 */
export function voronoiFracturePolyhedron(
  poly: BreakablePolyhedron,
  sites: readonly Vec3[],
  density: number,
  uvScale = 1,
): VoronoiFractureResult {
  if (sites.length < 2) throw breakableInput(`Voronoi fracture requires at least 2 sites (got ${sites.length})`);
  if (!(density > 0 && Number.isFinite(density)))
    throw breakableInput(`Density must be a positive finite number (got ${density})`);
  if (!(uvScale > 0 && Number.isFinite(uvScale)))
    throw breakableInput(`uvScale must be a positive finite number (got ${uvScale})`);

  const totalProps = computePolyhedronMassProperties(poly, density);
  const minCellVolume = Math.max(1e-10, totalProps.volume * 1e-6);

  // Clip polyhedron for each site against every other site's bisector, nearest-first for fast culling.
  const siteToCellIndex = new Int32Array(sites.length).fill(-1);
  const rawPolys: {
    siteIdx: number;
    poly: BreakablePolyhedron;
    props: BreakableMassProperties;
  }[] = [];

  for (let i = 0; i < sites.length; i++) {
    const si = sites[i]!;
    // Sort other sites by squared distance from si so nearby planes trim the cell immediately.
    const others: { j: number; d2: number }[] = [];
    for (let j = 0; j < sites.length; j++) {
      if (j === i) continue;
      const sj = sites[j]!;
      const dx = sj[0] - si[0];
      const dy = sj[1] - si[1];
      const dz = sj[2] - si[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 1e-14) others.push({ j, d2 });
    }
    others.sort((a, b) => a.d2 - b.d2);

    let cellPoly: BreakablePolyhedron | null = poly;
    let maxRadiusSq = Infinity;

    for (let k = 0; k < others.length && cellPoly !== null; k++) {
      const { j, d2 } = others[k]!;
      // Early cull: if the bisector lies farther from si than the farthest surviving vertex, no further site can cut.
      if (d2 > 4 * maxRadiusSq * 1.0001) break;

      const sj = sites[j]!;
      const dx = sj[0] - si[0];
      const dy = sj[1] - si[1];
      const dz = sj[2] - si[2];
      const dist = Math.sqrt(d2);
      const normal: Vec3 = [dx / dist, dy / dist, dz / dist];
      const mx = (si[0] + sj[0]) * 0.5;
      const my = (si[1] + sj[1]) * 0.5;
      const mz = (si[2] + sj[2]) * 0.5;
      const offset = normal[0] * mx + normal[1] * my + normal[2] * mz;

      const clipped = clipPolyhedronHalfSpace(cellPoly, normal, offset, j);
      if (clipped !== cellPoly) {
        cellPoly = clipped;
        if (cellPoly !== null) {
          let r2 = 0;
          for (let v = 0; v < cellPoly.vertices.length; v++) {
            const p = cellPoly.vertices[v]!;
            const vx = p[0] - si[0];
            const vy = p[1] - si[1];
            const vz = p[2] - si[2];
            const vr2 = vx * vx + vy * vy + vz * vz;
            if (vr2 > r2) r2 = vr2;
          }
          maxRadiusSq = r2;
        }
      }
    }

    if (cellPoly === null) continue;
    const props = computePolyhedronMassProperties(cellPoly, density);
    if (!(props.volume > minCellVolume) || isSliver(cellPoly, props.centroid)) continue;

    siteToCellIndex[i] = rawPolys.length;
    rawPolys.push({ siteIdx: i, poly: cellPoly, props });
  }

  // Remap face neighborSite from original site indices to surviving cell indices and build BreakableCell records.
  const cells: BreakableCell[] = [];
  const adjacencyMap = new Map<number, CellAdjacency>();
  const cellCount = rawPolys.length;

  for (let c = 0; c < cellCount; c++) {
    const entry = rawPolys[c]!;
    const remappedFaces: BreakablePolyhedronFace[] = entry.poly.faces.map((face) => ({
      ...face,
      neighborSite: face.neighborSite >= 0 ? siteToCellIndex[face.neighborSite]! : -1,
    }));
    const remappedPoly: BreakablePolyhedron = {
      vertices: entry.poly.vertices,
      faces: remappedFaces,
    };
    const { centroid, volume, mass, principalInertia, inertiaFrame, inertiaTensor } = entry.props;
    const bounds = polyhedronBounds(remappedPoly);

    const hullPoints = new Float32Array(remappedPoly.vertices.length * 3);
    for (let v = 0; v < remappedPoly.vertices.length; v++) {
      const p = remappedPoly.vertices[v]!;
      hullPoints[v * 3] = p[0] - centroid[0];
      hullPoints[v * 3 + 1] = p[1] - centroid[1];
      hullPoints[v * 3 + 2] = p[2] - centroid[2];
    }

    const meshData = buildFaceMeshData(remappedPoly, centroid, uvScale, () => true);
    const geometry = new Geometry(meshData.positions, meshData.normals, meshData.indices);
    const uvs = Float32Array.from(meshData.uvs);
    const materialGroups: BreakableMaterialGroup[] = [];
    if (meshData.exteriorCount > 0)
      materialGroups.push({
        start: 0,
        count: meshData.exteriorCount,
        materialIndex: 0,
      });
    if (meshData.interiorCount > 0)
      materialGroups.push({
        start: meshData.exteriorCount,
        count: meshData.interiorCount,
        materialIndex: 1,
      });

    const extData = buildFaceMeshData(remappedPoly, centroid, uvScale, (face) => !face.interior);
    const intData = buildFaceMeshData(remappedPoly, centroid, uvScale, (face) => face.interior);
    const exteriorGeometry = buildGeometryFromParts(extData.positions, extData.normals, extData.indices);
    const interiorGeometry = buildGeometryFromParts(intData.positions, intData.normals, intData.indices);

    const site = sites[entry.siteIdx]!;
    cells.push({
      index: c,
      site: [site[0], site[1], site[2]],
      centroid,
      volume,
      mass,
      principalInertia,
      inertiaFrame,
      inertiaTensor,
      boundsMin: bounds.min,
      boundsMax: bounds.max,
      hullPoints,
      edges: buildUniqueEdges(remappedPoly),
      geometry,
      exteriorGeometry,
      interiorGeometry,
      uvs,
      materialGroups,
      polyhedron: remappedPoly,
    });

    // Record deduplicated shared cut faces as adjacency bonds.
    for (let f = 0; f < remappedFaces.length; f++) {
      const face = remappedFaces[f]!;
      if (!face.interior || face.neighborSite < 0 || face.neighborSite === c) continue;
      const a = c < face.neighborSite ? c : face.neighborSite;
      const b = c < face.neighborSite ? face.neighborSite : c;
      const key = a * cellCount + b;
      if (adjacencyMap.has(key)) continue;
      const { area, centroid: faceCentroid } = polygonAreaAndCentroid(remappedPoly, face);
      if (!(area > 1e-10)) continue;
      const normal: [number, number, number] =
        c === a
          ? [face.normal[0], face.normal[1], face.normal[2]]
          : [-face.normal[0], -face.normal[1], -face.normal[2]];
      adjacencyMap.set(key, {
        cellA: a,
        cellB: b,
        area,
        centroid: faceCentroid,
        normal,
      });
    }
  }

  return {
    cells,
    adjacencies: [...adjacencyMap.values()],
  };
}

/**
 * Convenience helper: splits an axis-aligned box `[width, height, depth]` into deterministic 3D
 * Voronoi fracture cells with exact mass properties, interior/exterior material groups, and bonds.
 */
export function voronoiFractureBox(
  size: Vec3,
  options: {
    cellCount?: number;
    seed?: number;
    pattern?: BreakableFracturePattern;
    sites?: readonly Vec3[];
    density?: number;
    uvScale?: number;
  } = {},
): VoronoiFractureResult {
  const poly = createBoxPolyhedron(size[0], size[1], size[2]);
  const bounds = polyhedronBounds(poly);
  const sites =
    options.sites ??
    generateVoronoiSites(
      bounds.min,
      bounds.max,
      options.cellCount ?? 12,
      options.seed ?? 1,
      options.pattern ?? 'uniform',
    );
  return voronoiFracturePolyhedron(poly, sites, options.density ?? 1, options.uvScale ?? 1);
}

/**
 * Convenience helper: splits a closed convex geometry into deterministic 3D Voronoi fracture cells
 * with exact mass properties, interior/exterior material groups, and bonds.
 */
export function voronoiFractureGeometry(
  geometry: ColliderGeometry,
  options: {
    cellCount?: number;
    seed?: number;
    pattern?: BreakableFracturePattern;
    sites?: readonly Vec3[];
    density?: number;
    uvScale?: number;
  } = {},
): VoronoiFractureResult {
  const poly = createPolyhedronFromGeometry(geometry);
  const bounds = polyhedronBounds(poly);
  const sites =
    options.sites ??
    generateVoronoiSites(
      bounds.min,
      bounds.max,
      options.cellCount ?? 12,
      options.seed ?? 1,
      options.pattern ?? 'uniform',
    );
  return voronoiFracturePolyhedron(poly, sites, options.density ?? 1, options.uvScale ?? 1);
}
