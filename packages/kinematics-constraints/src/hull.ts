import { rangeError, typeError } from '../../shared/errors.js';
import type { ConstraintVolume, MutableVec3View, Vec3View } from './types.js';
import {
  readVector,
  validateDistinctOutputs,
  validateNonNegative,
  validateOutputVector,
  validateVector,
  writeVector,
} from './types.js';

/** A convex hull collider: its corner points in local space and the transform that places them. */
export interface ConvexHullVolumeOptions {
  /**
   * Flat `x, y, z` corner positions in the hull's local space, for example the positions of `convexGeometry`.
   * Exact duplicates are dropped. One point, a line and a flat polygon are all valid hulls.
   */
  points: ArrayLike<number>;
  /** Column-major affine local-to-world matrix, 16 values. Defaults to the identity. */
  matrix?: ArrayLike<number>;
  /** Most distinct points accepted; a query costs one dot product per point per GJK step. Defaults to 64. */
  maxPoints?: number;
}

// The query kernel below is GJK (Gilbert, Johnson and Keerthi, 1988) for the distance between two convex point sets,
// and an expanding polytope (van den Bergen, 2001) on their Minkowski difference once they overlap. A point and a
// segment are point sets too, so one kernel serves every query.
//
// Allocation: a double passed to or returned from a function V8 did not inline is boxed, and a double kept in a module
// `let` is boxed on every write. So the helpers take only integers (small, never boxed) and exchange every double
// through these typed arrays. The kernel never calls out, so one set of scratch arrays is safe.
interface PointSet {
  points: Float64Array;
  count: number;
  /** Rows of the upper 3x4 by column: 0..2, 3..5 and 6..8 are the axes, 9..11 the translation. */
  matrix: Float64Array;
  /** Local centroid; the first search direction runs between the two centroids. */
  center: Float64Array;
}

const FLOAT32_MAX = 3.4028234663852886e38;
const GJK_STEPS = 128;
const MAX_VERTICES = 128;
const MAX_FACES = 256;
// Below this fraction of the Minkowski difference's size, a length counts as zero.
const FLAT = 1e-10;
// The polytope stops growing when a step gains less than this fraction of that size. A point query is exact enough for
// projecting a target out; between shapes the depth only ranks poses, and rounded hulls would pay dearly for more.
const POINT_DEPTH_TOLERANCE = 1e-10;
const SHAPE_DEPTH_TOLERANCE = 1e-4;
// Rounded hulls have thousands of faces in their difference. A deep overlap settles for this share of the depth.
const SHAPE_DEPTH_SHARE = 0.02;

/** Direction of the next support query. */
const direction = /* @__PURE__ */ new Float64Array(3);
/** Output of `support`. */
const supported = /* @__PURE__ */ new Float64Array(3);
/** World centroids of the two sets, in that order. */
const centers = /* @__PURE__ */ new Float64Array(6);
/** Up to four vertices of the difference, the GJK simplex. */
const simplex = /* @__PURE__ */ new Float64Array(12);
/** The simplex's closest point to the origin. */
const vector = /* @__PURE__ */ new Float64Array(3);
/** The closest point found so far by `closerEdge` and `closerFace`, then its squared length. */
const best = /* @__PURE__ */ new Float64Array(4);
/** Largest coordinate of the difference seen so far in this query. */
const size = /* @__PURE__ */ new Float64Array(1);
/** The query's answer: signed distance (negative when overlapping), then the unit direction moving B away from A. */
const answer = /* @__PURE__ */ new Float64Array(4);
/** The polytope: vertices, faces as vertex indices, faces' normal and offset, then the horizon's edges. */
const polyVertices = /* @__PURE__ */ new Float64Array(MAX_VERTICES * 3);
const polyFaces = /* @__PURE__ */ new Int32Array(MAX_FACES * 3);
const polyPlanes = /* @__PURE__ */ new Float64Array(MAX_FACES * 4);
const polyEdges = /* @__PURE__ */ new Int32Array(MAX_FACES * 6);
/** The current query's fraction, as above. */
const depthTolerance = /* @__PURE__ */ new Float64Array(1);
/** A point inside the polytope, which orients every face outward. */
const inner = /* @__PURE__ */ new Float64Array(3);

function support(set: PointSet, sign: number): void {
  const m = set.matrix,
    points = set.points,
    count = set.count;
  const dx = direction[0],
    dy = direction[1],
    dz = direction[2];
  // A linear map's support along d is the map of the local support along its transpose times d, whatever its scale.
  const lx = sign * (m[0] * dx + m[1] * dy + m[2] * dz),
    ly = sign * (m[3] * dx + m[4] * dy + m[5] * dz),
    lz = sign * (m[6] * dx + m[7] * dy + m[8] * dz);
  let found = 0,
    high = -Infinity;
  for (let i = 0; i < count; i++) {
    const at = i * 3,
      dot = points[at] * lx + points[at + 1] * ly + points[at + 2] * lz;
    if (dot > high) {
      high = dot;
      found = at;
    }
  }
  const px = points[found],
    py = points[found + 1],
    pz = points[found + 2];
  supported[0] = m[0] * px + m[3] * py + m[6] * pz + m[9];
  supported[1] = m[1] * px + m[4] * py + m[7] * pz + m[10];
  supported[2] = m[2] * px + m[5] * py + m[8] * pz + m[11];
}

/** Writes the difference's support along `direction` to `out` at element `at`. */
function supportDifference(a: PointSet, b: PointSet, out: Float64Array, at: number): void {
  support(a, 1);
  const x = supported[0],
    y = supported[1],
    z = supported[2];
  support(b, -1);
  const wx = x - supported[0],
    wy = y - supported[1],
    wz = z - supported[2];
  out[at] = wx;
  out[at + 1] = wy;
  out[at + 2] = wz;
  const ax = wx < 0 ? -wx : wx,
    ay = wy < 0 ? -wy : wy,
    az = wz < 0 ? -wz : wz;
  if (ax > size[0]) size[0] = ax;
  if (ay > size[0]) size[0] = ay;
  if (az > size[0]) size[0] = az;
}

function centerOf(set: PointSet, at: number): void {
  const m = set.matrix,
    c = set.center;
  centers[at] = m[0] * c[0] + m[3] * c[1] + m[6] * c[2] + m[9];
  centers[at + 1] = m[1] * c[0] + m[4] * c[1] + m[7] * c[2] + m[10];
  centers[at + 2] = m[2] * c[0] + m[5] * c[1] + m[8] * c[2] + m[11];
}

/** Keeps the closest point of simplex edge i-j to the origin if it beats `best`; returns the vertices it uses. */
function closerEdge(i: number, j: number, mask: number): number {
  const ax = simplex[i * 3],
    ay = simplex[i * 3 + 1],
    az = simplex[i * 3 + 2];
  const ex = simplex[j * 3] - ax,
    ey = simplex[j * 3 + 1] - ay,
    ez = simplex[j * 3 + 2] - az;
  const squared = ex * ex + ey * ey + ez * ez;
  let t = 0;
  if (squared > 0) t = -(ax * ex + ay * ey + az * ez) / squared;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = ax + ex * t,
    py = ay + ey * t,
    pz = az + ez * t,
    distance = px * px + py * py + pz * pz;
  if (distance >= best[3]) return mask;
  best[0] = px;
  best[1] = py;
  best[2] = pz;
  best[3] = distance;
  return t <= 0 ? 1 << i : t >= 1 ? 1 << j : (1 << i) | (1 << j);
}

/** As closerEdge for simplex triangle i-j-k, inner region or edges. */
function closerFace(i: number, j: number, k: number, mask: number): number {
  const ax = simplex[i * 3],
    ay = simplex[i * 3 + 1],
    az = simplex[i * 3 + 2];
  const bx = simplex[j * 3] - ax,
    by = simplex[j * 3 + 1] - ay,
    bz = simplex[j * 3 + 2] - az;
  const cx = simplex[k * 3] - ax,
    cy = simplex[k * 3 + 1] - ay,
    cz = simplex[k * 3 + 2] - az;
  // Barycentric solve of the origin's projection, by the normal equations.
  const bb = bx * bx + by * by + bz * bz,
    bc = bx * cx + by * cy + bz * cz,
    cc = cx * cx + cy * cy + cz * cz;
  const ab = -(ax * bx + ay * by + az * bz),
    ac = -(ax * cx + ay * cy + az * cz);
  const determinant = bb * cc - bc * bc,
    v = cc * ab - bc * ac,
    w = bb * ac - bc * ab;
  if (determinant > 0 && v > 0 && w > 0 && v + w < determinant) {
    const s = v / determinant,
      t = w / determinant;
    const px = ax + bx * s + cx * t,
      py = ay + by * s + cy * t,
      pz = az + bz * s + cz * t,
      distance = px * px + py * py + pz * pz;
    if (distance >= best[3]) return mask;
    best[0] = px;
    best[1] = py;
    best[2] = pz;
    best[3] = distance;
    return (1 << i) | (1 << j) | (1 << k);
  }
  return closerEdge(j, k, closerEdge(i, k, closerEdge(i, j, mask)));
}

/** True when the origin is on the far side of face i-j-k from vertex l, or the tetrahedron has no volume. */
function outside(i: number, j: number, k: number, l: number): boolean {
  const ax = simplex[i * 3],
    ay = simplex[i * 3 + 1],
    az = simplex[i * 3 + 2];
  const bx = simplex[j * 3] - ax,
    by = simplex[j * 3 + 1] - ay,
    bz = simplex[j * 3 + 2] - az;
  const cx = simplex[k * 3] - ax,
    cy = simplex[k * 3 + 1] - ay,
    cz = simplex[k * 3 + 2] - az;
  const nx = by * cz - bz * cy,
    ny = bz * cx - bx * cz,
    nz = bx * cy - by * cx;
  const opposite = nx * (simplex[l * 3] - ax) + ny * (simplex[l * 3 + 1] - ay) + nz * (simplex[l * 3 + 2] - az),
    origin = -(nx * ax + ny * ay + nz * az),
    limit = FLAT * size[0];
  if (opposite <= limit * limit * limit && -opposite <= limit * limit * limit) return true;
  return opposite > 0 ? origin < 0 : origin > 0;
}

/**
 * Reduces the simplex to the vertices of its closest point to the origin and writes that point to `vector`.
 * Returns the vertices left; 4 means the origin is inside the tetrahedron.
 */
function reduceSimplex(count: number): number {
  best[3] = Infinity;
  let mask = 0;
  if (count === 2) mask = closerEdge(0, 1, 0);
  else if (count === 3) mask = closerFace(0, 1, 2, 0);
  else {
    if (outside(0, 1, 2, 3)) mask = closerFace(0, 1, 2, mask);
    if (outside(0, 1, 3, 2)) mask = closerFace(0, 1, 3, mask);
    if (outside(0, 2, 3, 1)) mask = closerFace(0, 2, 3, mask);
    if (outside(1, 2, 3, 0)) mask = closerFace(1, 2, 3, mask);
    if (mask === 0) return 4;
  }
  let kept = 0;
  for (let i = 0; i < count; i++) {
    if ((mask & (1 << i)) === 0) continue;
    if (i !== kept) {
      simplex[kept * 3] = simplex[i * 3];
      simplex[kept * 3 + 1] = simplex[i * 3 + 1];
      simplex[kept * 3 + 2] = simplex[i * 3 + 2];
    }
    kept++;
  }
  vector[0] = best[0];
  vector[1] = best[1];
  vector[2] = best[2];
  return kept;
}

/** Writes the signed distance between the sets and the direction moving B away from A to `answer`. */
function query(a: PointSet, b: PointSet): void {
  centerOf(a, 0);
  centerOf(b, 3);
  direction[0] = centers[3] - centers[0];
  direction[1] = centers[4] - centers[1];
  direction[2] = centers[5] - centers[2];
  if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) direction[0] = 1;
  size[0] = 0;
  supportDifference(a, b, simplex, 0);
  vector[0] = simplex[0];
  vector[1] = simplex[1];
  vector[2] = simplex[2];
  let count = 1;
  for (let step = 0; step < GJK_STEPS; step++) {
    const vx = vector[0],
      vy = vector[1],
      vz = vector[2],
      squared = vx * vx + vy * vy + vz * vz,
      noise = size[0] * size[0];
    if (squared <= FLAT * FLAT * noise) {
      overlap(a, b);
      return;
    }
    direction[0] = -vx;
    direction[1] = -vy;
    direction[2] = -vz;
    supportDifference(a, b, simplex, count * 3);
    const at = count * 3,
      gap = squared - (vx * simplex[at] + vy * simplex[at + 1] + vz * simplex[at + 2]);
    // The new vertex is no nearer the origin than `vector` is: its length is the distance. The second term is the
    // rounding of these products at this size.
    if (gap <= 1e-12 * squared + 4e-16 * size[0] * size[0]) break;
    count = reduceSimplex(count + 1);
    if (count === 4) {
      overlap(a, b);
      return;
    }
    if (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2] >= squared) {
      // Rounding only: a step that made no progress cannot make any later.
      vector[0] = vx;
      vector[1] = vy;
      vector[2] = vz;
      break;
    }
  }
  const distance = Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
  answer[0] = distance;
  // Subtracting from zero keeps a zero component positive.
  answer[1] = (0 - vector[0]) / distance;
  answer[2] = (0 - vector[1]) / distance;
  answer[3] = (0 - vector[2]) / distance;
}

/** The sets touch with no interior to measure into: distance zero, and this unit direction, sign made repeatable. */
function touching(x: number, y: number, z: number): void {
  const ax = x < 0 ? -x : x,
    ay = y < 0 ? -y : y,
    az = z < 0 ? -z : z,
    negative = ax >= ay && ax >= az ? x < 0 : ay >= az ? y < 0 : z < 0,
    sign = negative ? -1 : 1;
  answer[0] = 0;
  answer[1] = x * sign + 0;
  answer[2] = y * sign + 0;
  answer[3] = z * sign + 0;
}

function addFace(faces: number, i: number, j: number, k: number): number {
  const ax = polyVertices[i * 3],
    ay = polyVertices[i * 3 + 1],
    az = polyVertices[i * 3 + 2];
  const bx = polyVertices[j * 3] - ax,
    by = polyVertices[j * 3 + 1] - ay,
    bz = polyVertices[j * 3 + 2] - az;
  const cx = polyVertices[k * 3] - ax,
    cy = polyVertices[k * 3 + 1] - ay,
    cz = polyVertices[k * 3 + 2] - az;
  let nx = by * cz - bz * cy,
    ny = bz * cx - bx * cz,
    nz = bx * cy - by * cx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz),
    limit = FLAT * size[0];
  let first = j,
    second = k,
    offset = Infinity;
  if (length > limit * limit) {
    nx /= length;
    ny /= length;
    nz /= length;
    if (nx * (ax - inner[0]) + ny * (ay - inner[1]) + nz * (az - inner[2]) < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      first = k;
      second = j;
    }
    offset = nx * ax + ny * ay + nz * az;
  } else {
    // A sliver has no direction: it stays in the mesh but is never chosen and never seen.
    nx = ny = nz = 0;
  }
  polyFaces[faces * 3] = i;
  polyFaces[faces * 3 + 1] = first;
  polyFaces[faces * 3 + 2] = second;
  polyPlanes[faces * 4] = nx;
  polyPlanes[faces * 4 + 1] = ny;
  polyPlanes[faces * 4 + 2] = nz;
  polyPlanes[faces * 4 + 3] = offset;
  return faces + 1;
}

/** Seeds the polytope with four vertices of the difference; false when it has no volume (`answer` is then written). */
function seedTetrahedron(a: PointSet, b: PointSet): boolean {
  // First vertex, then the axis support farthest from it.
  direction[0] = 1;
  direction[1] = direction[2] = 0;
  supportDifference(a, b, polyVertices, 0);
  const ox = polyVertices[0],
    oy = polyVertices[1],
    oz = polyVertices[2];
  let far = -1;
  for (let probe = 0; probe < 6; probe++) {
    direction[0] = direction[1] = direction[2] = 0;
    direction[probe >> 1] = probe & 1 ? -1 : 1;
    supportDifference(a, b, polyVertices, 12);
    const x = polyVertices[12] - ox,
      y = polyVertices[13] - oy,
      z = polyVertices[14] - oz,
      distance = x * x + y * y + z * z;
    if (distance > far) {
      far = distance;
      polyVertices[3] = polyVertices[12];
      polyVertices[4] = polyVertices[13];
      polyVertices[5] = polyVertices[14];
    }
  }
  const limit = FLAT * size[0];
  if (far <= limit * limit) {
    touching(1, 0, 0);
    return false;
  }
  let ux = polyVertices[3] - ox,
    uy = polyVertices[4] - oy,
    uz = polyVertices[5] - oz;
  const uLength = Math.sqrt(far);
  ux /= uLength;
  uy /= uLength;
  uz /= uLength;
  // Two axes across the line; a point off the line projects off it on one of them.
  const ax = ux < 0 ? -ux : ux,
    ay = uy < 0 ? -uy : uy,
    az = uz < 0 ? -uz : uz;
  let px = 0,
    py = 0,
    pz = 0;
  if (ax <= ay && ax <= az) {
    py = uz;
    pz = -uy;
  } else if (ay <= az) {
    px = -uz;
    pz = ux;
  } else {
    px = uy;
    py = -ux;
  }
  const pLength = Math.sqrt(px * px + py * py + pz * pz);
  px /= pLength;
  py /= pLength;
  pz /= pLength;
  const qx = uy * pz - uz * py,
    qy = uz * px - ux * pz,
    qz = ux * py - uy * px;
  far = -1;
  for (let probe = 0; probe < 4; probe++) {
    const sign = probe & 1 ? -1 : 1;
    direction[0] = (probe < 2 ? px : qx) * sign;
    direction[1] = (probe < 2 ? py : qy) * sign;
    direction[2] = (probe < 2 ? pz : qz) * sign;
    supportDifference(a, b, polyVertices, 12);
    const x = polyVertices[12] - ox,
      y = polyVertices[13] - oy,
      z = polyVertices[14] - oz,
      along = x * ux + y * uy + z * uz,
      rx = x - ux * along,
      ry = y - uy * along,
      rz = z - uz * along,
      distance = rx * rx + ry * ry + rz * rz;
    if (distance > far) {
      far = distance;
      polyVertices[6] = polyVertices[12];
      polyVertices[7] = polyVertices[13];
      polyVertices[8] = polyVertices[14];
    }
  }
  if (far <= limit * limit) {
    touching(px, py, pz);
    return false;
  }
  const vx = polyVertices[6] - ox,
    vy = polyVertices[7] - oy,
    vz = polyVertices[8] - oz;
  let nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const nLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx /= nLength;
  ny /= nLength;
  nz /= nLength;
  direction[0] = nx;
  direction[1] = ny;
  direction[2] = nz;
  supportDifference(a, b, polyVertices, 9);
  const above = nx * (polyVertices[9] - ox) + ny * (polyVertices[10] - oy) + nz * (polyVertices[11] - oz);
  direction[0] = -nx;
  direction[1] = -ny;
  direction[2] = -nz;
  supportDifference(a, b, polyVertices, 12);
  const below = -(nx * (polyVertices[12] - ox) + ny * (polyVertices[13] - oy) + nz * (polyVertices[14] - oz));
  if (below > above) {
    polyVertices[9] = polyVertices[12];
    polyVertices[10] = polyVertices[13];
    polyVertices[11] = polyVertices[14];
  }
  if ((below > above ? below : above) <= limit) {
    touching(nx, ny, nz);
    return false;
  }
  return true;
}

/**
 * The origin is inside the difference (or on it). Grows a polytope toward the difference's surface until the nearest
 * face stops moving: that face gives the way out, and the difference's reach along it the depth. The seed tetrahedron need not hold the origin. A face
 * with the origin beyond it has a negative offset, is chosen first and must grow, because the difference holds the
 * origin.
 */
function overlap(a: PointSet, b: PointSet): void {
  if (!seedTetrahedron(a, b)) return;
  inner[0] = (polyVertices[0] + polyVertices[3] + polyVertices[6] + polyVertices[9]) / 4;
  inner[1] = (polyVertices[1] + polyVertices[4] + polyVertices[7] + polyVertices[10]) / 4;
  inner[2] = (polyVertices[2] + polyVertices[5] + polyVertices[8] + polyVertices[11]) / 4;
  let vertices = 4,
    faces = addFace(addFace(addFace(addFace(0, 0, 1, 2), 0, 1, 3), 0, 2, 3), 1, 2, 3);
  for (;;) {
    let nearest = 0;
    for (let f = 1; f < faces; f++) if (polyPlanes[f * 4 + 3] < polyPlanes[nearest * 4 + 3]) nearest = f;
    const nx = polyPlanes[nearest * 4],
      ny = polyPlanes[nearest * 4 + 1],
      nz = polyPlanes[nearest * 4 + 2];
    // Moving B by the support along n always separates the shapes, so this bound never reports too little overlap.
    answer[1] = nx;
    answer[2] = ny;
    answer[3] = nz;
    direction[0] = nx;
    direction[1] = ny;
    direction[2] = nz;
    supportDifference(a, b, polyVertices, vertices * 3);
    const wx = polyVertices[vertices * 3],
      wy = polyVertices[vertices * 3 + 1],
      wz = polyVertices[vertices * 3 + 2];
    const reach = nx * wx + ny * wy + nz * wz;
    answer[0] = reach > 0 ? -reach : 0;
    const left = reach - polyPlanes[nearest * 4 + 3];
    if (left <= depthTolerance[0] * size[0] || vertices === MAX_VERTICES - 1) return;
    if (depthTolerance[0] === SHAPE_DEPTH_TOLERANCE && left <= SHAPE_DEPTH_SHARE * reach) return;
    // Remove every face the new vertex sees; the edges used once among them are the hole's rim.
    let edges = 0;
    const seen = FLAT * 1e-2 * size[0];
    for (let f = 0; f < faces; ) {
      if (
        polyPlanes[f * 4] * wx + polyPlanes[f * 4 + 1] * wy + polyPlanes[f * 4 + 2] * wz - polyPlanes[f * 4 + 3] <=
        seen
      ) {
        f++;
        continue;
      }
      for (let side = 0; side < 3; side++) {
        const from = polyFaces[f * 3 + side],
          to = polyFaces[f * 3 + ((side + 1) % 3)];
        let twin = -1;
        for (let e = 0; e < edges; e++) {
          if (polyEdges[e * 2] === to && polyEdges[e * 2 + 1] === from) {
            twin = e;
            break;
          }
        }
        if (twin >= 0) {
          edges--;
          polyEdges[twin * 2] = polyEdges[edges * 2];
          polyEdges[twin * 2 + 1] = polyEdges[edges * 2 + 1];
        } else {
          polyEdges[edges * 2] = from;
          polyEdges[edges * 2 + 1] = to;
          edges++;
        }
      }
      faces--;
      polyFaces[f * 3] = polyFaces[faces * 3];
      polyFaces[f * 3 + 1] = polyFaces[faces * 3 + 1];
      polyFaces[f * 3 + 2] = polyFaces[faces * 3 + 2];
      polyPlanes[f * 4] = polyPlanes[faces * 4];
      polyPlanes[f * 4 + 1] = polyPlanes[faces * 4 + 1];
      polyPlanes[f * 4 + 2] = polyPlanes[faces * 4 + 2];
      polyPlanes[f * 4 + 3] = polyPlanes[faces * 4 + 3];
    }
    // Out of room: the bound above is still true.
    if (faces + edges > MAX_FACES) return;
    for (let e = 0; e < edges; e++) faces = addFace(faces, polyEdges[e * 2], polyEdges[e * 2 + 1], vertices);
    vertices++;
  }
}

function identity(): Float64Array {
  return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
}

/** The query shape of `evaluate` and `segmentClearance`: one or two points in world space. */
const segment: PointSet = /* @__PURE__ */ (() => ({
  points: new Float64Array(6),
  count: 2,
  matrix: identity(),
  center: new Float64Array(3),
}))();

function setSegment(start: Vec3View, end: Vec3View): void {
  const points = segment.points,
    center = segment.center;
  readVector(start, points, 0);
  readVector(end, points, 3);
  center[0] = (points[0] + points[3]) * 0.5;
  center[1] = (points[1] + points[4]) * 0.5;
  center[2] = (points[2] + points[5]) * 0.5;
}

function evaluateHull(
  shape: PointSet,
  point: Vec3View,
  outSurface: MutableVec3View,
  outNormal: MutableVec3View,
  outDistance: Float64Array,
): void {
  validateVector(point, 'query point');
  validateOutputVector(outSurface, 'surface output');
  validateOutputVector(outNormal, 'normal output');
  validateDistinctOutputs(outSurface, outNormal);
  setSegment(point, point);
  depthTolerance[0] = POINT_DEPTH_TOLERANCE;
  query(shape, segment);
  // Outside, the query point lies `distance` along the normal from the surface. Inside, the surface lies `depth`
  // along the normal from the point. Both read point - normal * signed distance.
  const signed = answer[0],
    x = segment.points[0] - answer[1] * signed,
    y = segment.points[1] - answer[2] * signed,
    z = segment.points[2] - answer[3] * signed;
  // Compared here, not in a call, so the three doubles stay unboxed.
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    (outSurface instanceof Float32Array &&
      (Math.abs(x) > FLOAT32_MAX || Math.abs(y) > FLOAT32_MAX || Math.abs(z) > FLOAT32_MAX))
  )
    throw new RangeError('Result exceeds output precision; scale the scene down or move it nearer the origin');
  supported[0] = x;
  supported[1] = y;
  supported[2] = z;
  writeVector(outSurface, supported, 0);
  writeVector(outNormal, answer, 1);
  outDistance[0] = signed;
}

function segmentHull(shape: PointSet, start: Vec3View, end: Vec3View, radius: number, outDistance: Float64Array): void {
  validateVector(start, 'segment start');
  validateVector(end, 'segment end');
  validateNonNegative(radius, 'segment radius');
  setSegment(start, end);
  depthTolerance[0] = SHAPE_DEPTH_TOLERANCE;
  query(shape, segment);
  outDistance[0] = answer[0] - radius;
}

const publicDistance = /* @__PURE__ */ new Float64Array(1);
const incoming = /* @__PURE__ */ new Float64Array(16);

/**
 * A convex hull in a caller-selected coordinate frame, for a box corner, a torso or a head that a capsule fits badly.
 *
 * Move it with {@link ConvexHullVolume.setTransform}. Every query runs GJK against the hull's points with no
 * allocation, and an expanding polytope once the shapes overlap, so `evaluate` and `segmentClearance` give the signed
 * distance a solver needs: negative by the depth inside. A flat or line hull has no inside: it reports zero on its
 * surface, with a repeatable normal.
 *
 * @example
 * ```ts
 * import { ConvexHullVolume } from 'margoengine/kinematics-constraints';
 *
 * const box = new ConvexHullVolume({
 *   points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
 * });
 * const gap = box.segmentClearance([2, 0.5, 0.5], [3, 0.5, 0.5], 0.25); // 0.75
 * ```
 */
export class ConvexHullVolume implements ConstraintVolume {
  private readonly shape: PointSet;

  constructor(options: ConvexHullVolumeOptions) {
    const source = options?.points;
    if (!source || typeof source.length !== 'number' || source.length % 3 !== 0)
      throw typeError('ConvexHullVolume points must be flat x, y, z values', 'kinematics');
    const limit = options.maxPoints ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw rangeError('ConvexHullVolume maxPoints must be a positive integer', 'kinematics');
    const seen = new Set<string>(),
      kept: number[] = [];
    for (let i = 0; i < source.length; i += 3) {
      const x = source[i],
        y = source[i + 1],
        z = source[i + 2];
      validateVector([x, y, z], 'ConvexHullVolume point');
      const key = `${x},${y},${z}`;
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(x, y, z);
      }
    }
    const count = kept.length / 3;
    if (count === 0) throw rangeError('ConvexHullVolume needs at least one point', 'kinematics');
    if (count > limit)
      throw rangeError(
        'ConvexHullVolume has more points than maxPoints; pass hull corners only or raise it',
        'kinematics',
      );
    const center = new Float64Array(3);
    for (let i = 0; i < kept.length; i++) center[i % 3] += kept[i] / count;
    this.shape = { points: new Float64Array(kept), count, matrix: identity(), center };
    if (options.matrix !== undefined) this.setTransform(options.matrix);
  }

  /** Distinct points kept. */
  get pointCount(): number {
    return this.shape.count;
  }

  /**
   * Places the hull: `matrix` is a column-major affine local-to-world matrix of 16 values, such as a bone's world
   * matrix. Costs twelve copies, whatever the point count. Scale and shear are allowed.
   */
  setTransform(matrix: ArrayLike<number>): this {
    if (!matrix || matrix.length !== 16) throw typeError('ConvexHullVolume matrix must have 16 values', 'kinematics');
    // Copied first: reading an element from arrays of more than one type boxes each value, and callers mix them.
    incoming.set(matrix);
    for (let i = 0; i < 16; i++) {
      const value = incoming[i];
      if (!(value <= 1e100 && value >= -1e100))
        throw rangeError('ConvexHullVolume matrix has a non-finite value; check the bone', 'kinematics');
    }
    if (incoming[3] !== 0 || incoming[7] !== 0 || incoming[11] !== 0 || incoming[15] !== 1)
      throw rangeError('ConvexHullVolume matrix must be affine; its last row must be 0, 0, 0, 1', 'kinematics');
    const m = this.shape.matrix;
    m[0] = incoming[0];
    m[1] = incoming[1];
    m[2] = incoming[2];
    m[3] = incoming[4];
    m[4] = incoming[5];
    m[5] = incoming[6];
    m[6] = incoming[8];
    m[7] = incoming[9];
    m[8] = incoming[10];
    m[9] = incoming[12];
    m[10] = incoming[13];
    m[11] = incoming[14];
    return this;
  }

  /** Signed distance to the surface: negative inside. Writes the closest surface point and the outward unit normal. */
  evaluate(point: Vec3View, outSurface: MutableVec3View, outNormal: MutableVec3View): number {
    evaluateHull(this.shape, point, outSurface, outNormal, publicDistance);
    return publicDistance[0];
  }

  /** Signed gap to a segment swept by a sphere of `radius`: negative when they overlap, by the depth. */
  segmentClearance(start: Vec3View, end: Vec3View, radius: number): number {
    segmentHull(this.shape, start, end, radius, publicDistance);
    return publicDistance[0];
  }

  /** Signed gap to another hull at its current transform: negative when they overlap, by the depth. */
  hullClearance(hull: ConvexHullVolume): number {
    depthTolerance[0] = SHAPE_DEPTH_TOLERANCE;
    query(this.shape, hull.shape);
    return answer[0];
  }

  /** `evaluate` with the distance written to `outDistance[0]`: the solver's path, free of a boxed return value. */
  evaluateInto(
    point: Vec3View,
    outSurface: MutableVec3View,
    outNormal: MutableVec3View,
    outDistance: Float64Array,
  ): void {
    const method = this.evaluate;
    if (method === hullEvaluate) evaluateHull(this.shape, point, outSurface, outNormal, outDistance);
    else {
      const distance = method.call(this, point, outSurface, outNormal);
      outDistance[0] = Number.isFinite(distance) ? distance : NaN;
    }
  }

  /** `segmentClearance` with the gap written to `outDistance[0]`. */
  segmentClearanceInto(start: Vec3View, end: Vec3View, radius: number, outDistance: Float64Array): void {
    const method = this.segmentClearance;
    if (method === hullSegmentClearance) segmentHull(this.shape, start, end, radius, outDistance);
    else {
      const distance = method.call(this, start, end, radius);
      outDistance[0] = Number.isFinite(distance) ? distance : NaN;
    }
  }

  /** `hullClearance` with the gap written to `outDistance[0]`. */
  hullClearanceInto(hull: ConvexHullVolume, outDistance: Float64Array): void {
    depthTolerance[0] = SHAPE_DEPTH_TOLERANCE;
    query(this.shape, hull.shape);
    outDistance[0] = answer[0];
  }
}

// Captured once, as in volumes.ts: an override, however installed, keeps the public contract.
function originalEvaluate(): ConstraintVolume['evaluate'] {
  return ConvexHullVolume.prototype.evaluate;
}
function originalSegmentClearance(): ConstraintVolume['segmentClearance'] {
  return ConvexHullVolume.prototype.segmentClearance;
}
const hullEvaluate = /* @__PURE__ */ originalEvaluate();
const hullSegmentClearance = /* @__PURE__ */ originalSegmentClearance();

/** @internal The distinct points of a hull in its local space, flat. Read, do not write. */
export function hullPoints(hull: ConvexHullVolume): Float64Array {
  return hull['shape'].points;
}

/** @internal The distinct points of a hull in the world, flat. */
export function hullWorldPoints(hull: ConvexHullVolume): Float64Array {
  const { points, matrix: m } = hull['shape'],
    out = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i],
      y = points[i + 1],
      z = points[i + 2];
    for (let r = 0; r < 3; r++) out[i + r] = m[r] * x + m[3 + r] * y + m[6 + r] * z + m[9 + r];
  }
  return out;
}

/** @internal Writes the world box of a hull, min then max, into `out`. */
export function hullBoundsInto(hull: ConvexHullVolume, out: Float64Array): void {
  const { points, matrix: m } = hull['shape'];
  for (let k = 0; k < 3; k++) {
    out[k] = Infinity;
    out[k + 3] = -Infinity;
  }
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i],
      y = points[i + 1],
      z = points[i + 2];
    for (let k = 0; k < 3; k++) {
      const value = m[k] * x + m[3 + k] * y + m[6 + k] * z + m[9 + k];
      if (value < out[k]) out[k] = value;
      if (value > out[k + 3]) out[k + 3] = value;
    }
  }
}

/** @internal Writes one world point of a hull into `out`. */
export function hullCornerInto(hull: ConvexHullVolume, out: Float64Array): void {
  const { points, matrix: m } = hull['shape'];
  for (let k = 0; k < 3; k++) out[k] = m[k] * points[0] + m[3 + k] * points[1] + m[6 + k] * points[2] + m[9 + k];
}

/** @internal Makes a hull of three points the triangle a, b, c, without allocating. */
export function setHullTriangle(
  hull: ConvexHullVolume,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  c: ArrayLike<number>,
): void {
  const { points, center } = hull['shape'];
  for (let k = 0; k < 3; k++) {
    points[k] = a[k];
    points[3 + k] = b[k];
    points[6 + k] = c[k];
    center[k] = (a[k] + b[k] + c[k]) / 3;
  }
}
