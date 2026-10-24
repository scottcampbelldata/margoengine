import { sequentialIndices, type GeometryData } from './data.js';
import { finiteNumber } from './math.js';

// Golden ratio and its inverse: the coordinates of the icosahedron and dodecahedron are built from them.
const PHI = (1 + Math.sqrt(5)) / 2,
  INV = 1 / PHI;

// Seam heuristics for the spherical UV map (own choice): a triangle with one corner above HIGH and one below LOW
// straddles the u = 0 / 1 seam, and its corners below SHIFT move up by one so u stays continuous (u then ends below 1.2).
const LOW = 0.1,
  HIGH = 0.9,
  SHIFT = 0.2;

const TETRA_VERTICES = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1];
const TETRA_FACES = [0, 1, 3, 0, 2, 1, 0, 3, 2, 1, 2, 3];
const OCTA_VERTICES = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
const OCTA_FACES = [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 4, 2, 1, 3, 4, 1, 5, 3, 1, 2, 5];
// Cyclic permutations of (0, ±1, ±PHI): the (±1, ±PHI, 0) rectangle, then (0, ±1, ±PHI), then (±PHI, 0, ±1).
const ICOSA_VERTICES = [
  -1,
  PHI,
  0,
  1,
  PHI,
  0,
  -1,
  -PHI,
  0,
  1,
  -PHI,
  0,
  0,
  -1,
  PHI,
  0,
  1,
  PHI,
  0,
  -1,
  -PHI,
  0,
  1,
  -PHI,
  PHI,
  0,
  -1,
  PHI,
  0,
  1,
  -PHI,
  0,
  -1,
  -PHI,
  0,
  1,
];
const ICOSA_FACES = [
  0, 5, 1, 0, 1, 7, 0, 11, 5, 0, 7, 10, 0, 10, 11, 1, 5, 9, 1, 8, 7, 1, 9, 8, 2, 3, 4, 2, 6, 3, 2, 4, 11, 2, 10, 6, 2,
  11, 10, 3, 9, 4, 3, 6, 8, 3, 8, 9, 4, 9, 5, 4, 5, 11, 6, 7, 8, 6, 10, 7,
];
// The cube corners (±1, ±1, ±1) and the cyclic permutations of (0, ±1/PHI, ±PHI); each pentagon is a fan of three.
const DODECA_VERTICES = [
  -1,
  -1,
  -1,
  -1,
  -1,
  1,
  -1,
  1,
  -1,
  -1,
  1,
  1,
  1,
  -1,
  -1,
  1,
  -1,
  1,
  1,
  1,
  -1,
  1,
  1,
  1,
  0,
  -INV,
  -PHI,
  0,
  -INV,
  PHI,
  0,
  INV,
  -PHI,
  0,
  INV,
  PHI,
  -INV,
  -PHI,
  0,
  -INV,
  PHI,
  0,
  INV,
  -PHI,
  0,
  INV,
  PHI,
  0,
  -PHI,
  0,
  -INV,
  -PHI,
  0,
  INV,
  PHI,
  0,
  -INV,
  PHI,
  0,
  INV,
];
const DODECA_FACES = [
  14, 12, 0, 14, 0, 8, 14, 8, 4, 17, 16, 0, 17, 0, 12, 17, 12, 1, 10, 8, 0, 10, 0, 16, 10, 16, 2, 5, 9, 1, 5, 1, 12, 5,
  12, 14, 3, 13, 2, 3, 2, 16, 3, 16, 17, 6, 18, 4, 6, 4, 8, 6, 8, 10, 6, 10, 2, 6, 2, 13, 6, 13, 15, 5, 14, 4, 5, 4, 18,
  5, 18, 19, 3, 17, 1, 3, 1, 9, 3, 9, 11, 15, 13, 3, 15, 3, 11, 15, 11, 7, 19, 18, 6, 19, 6, 15, 19, 15, 7, 11, 9, 5,
  11, 5, 19, 11, 19, 7,
];

type V3 = [number, number, number];

const unit = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z) || 1;
  // `+ 0` turns -0 into 0 so the seam test below sees one sign.
  return [x / l + 0, y / l + 0, z / l + 0];
};
const azimuth = (x: number, z: number): number => 0.5 + Math.atan2(z, -x) / (2 * Math.PI);

/**
 * A convex polyhedron projected onto a sphere of `radius`. `vertices` is flat xyz and `indices` lists triangles into
 * it; a face whose winding points toward the origin is flipped, so the output always faces outward. Each face is cut
 * into `(detail + 1)^2` congruent triangles by dividing its edges into `detail + 1` equal parts, and every vertex is
 * pushed out to the sphere (detail 1 and up gives a geodesic sphere).
 *
 * The result is non-indexed: three vertices per triangle and sequential `indices`. Normals are flat per triangle when
 * `smooth` is false and radial when it is true; by default they are flat at detail 0 and radial above. UVs are a
 * spherical map (u around the y axis starting on -x, v = 1 at +y), with pole corners and seam-crossing triangles fixed
 * up so each triangle samples a continuous patch (u may run slightly past 1 there). No groups.
 */
export function polyhedronGeometry(
  vertices: readonly number[],
  indices: readonly number[],
  radius = 1,
  detail = 0,
  smooth = detail >= 1,
): GeometryData {
  const n = Math.max(0, Math.floor(finiteNumber(detail))) + 1;
  if (typeof smooth !== 'boolean')
    throw new TypeError(`polyhedron smoothing must be a boolean; pass true, false or leave it out (got ${smooth})`);
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    corner = (k: number): V3 => [vertices[k * 3], vertices[k * 3 + 1], vertices[k * 3 + 2]];

  const triangle = (a: V3, b: V3, c: V3) => {
    const flat = smooth
      ? undefined
      : unit(
          (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
          (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        );
    const centre = azimuth(a[0] + b[0] + c[0], a[2] + b[2] + c[2]),
      u: number[] = [];
    for (const p of [a, b, c]) {
      let value = azimuth(p[0], p[2]);
      // A pole has no azimuth of its own: borrow the triangle's.
      if (Math.hypot(p[0], p[2]) < 1e-9) value = centre;
      // u = 1 exactly lies on the seam; a triangle on the low side wants it as 0.
      else if (value === 1 && centre < 0.5) value = 0;
      u.push(value);
    }
    if (Math.max(u[0], u[1], u[2]) > HIGH && Math.min(u[0], u[1], u[2]) < LOW)
      for (let k = 0; k < 3; k++) if (u[k] < SHIFT) u[k] += 1;
    [a, b, c].forEach((p, k) => {
      positions.push(p[0] * radius, p[1] * radius, p[2] * radius);
      const q = flat ?? p;
      normals.push(q[0], q[1], q[2]);
      uvs.push(u[k], 0.5 + Math.asin(Math.max(-1, Math.min(1, p[1]))) / Math.PI);
    });
  };

  for (let f = 0; f + 2 < indices.length; f += 3) {
    const A = corner(indices[f]);
    let B = corner(indices[f + 1]),
      C = corner(indices[f + 2]);
    // Outward test: the face normal against the centroid.
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]],
      e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]],
      facing =
        (e1[1] * e2[2] - e1[2] * e2[1]) * (A[0] + B[0] + C[0]) +
        (e1[2] * e2[0] - e1[0] * e2[2]) * (A[1] + B[1] + C[1]) +
        (e1[0] * e2[1] - e1[1] * e2[0]) * (A[2] + B[2] + C[2]);
    if (facing < 0) [B, C] = [C, B];
    // Barycentric lattice: point (i, j) weighs B by i/n and C by j/n; every lattice point goes onto the unit sphere.
    const at = (i: number, j: number): V3 => {
      const wa = n - i - j;
      return unit(
        (A[0] * wa + B[0] * i + C[0] * j) / n,
        (A[1] * wa + B[1] * i + C[1] * j) / n,
        (A[2] * wa + B[2] * i + C[2] * j) / n,
      );
    };
    for (let j = 0; j < n; j++)
      for (let i = 0; i + j < n; i++) {
        triangle(at(i, j), at(i + 1, j), at(i, j + 1));
        if (i + j + 1 < n) triangle(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: sequentialIndices(positions.length / 3),
  };
}

/**
 * Regular tetrahedron (four alternate cube corners) inscribed in a sphere of `radius`, subdivided by `detail`. Same
 * output rules as {@link polyhedronGeometry}: non-indexed, flat normals at detail 0, radial above unless `smooth` says
 * otherwise.
 */
export function tetrahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  return polyhedronGeometry(TETRA_VERTICES, TETRA_FACES, radius, detail, smooth);
}

/**
 * Regular octahedron (the six axis points) inscribed in a sphere of `radius`, subdivided by `detail`. Same output
 * rules as {@link polyhedronGeometry}: non-indexed, flat normals at detail 0, radial above unless `smooth` says
 * otherwise.
 */
export function octahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  return polyhedronGeometry(OCTA_VERTICES, OCTA_FACES, radius, detail, smooth);
}

/**
 * Regular icosahedron (golden-ratio rectangles) inscribed in a sphere of `radius`, subdivided by `detail` into a
 * geodesic sphere. Same output rules as {@link polyhedronGeometry}: non-indexed, flat normals at detail 0, radial above
 * unless `smooth` says otherwise.
 */
export function icosahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  return polyhedronGeometry(ICOSA_VERTICES, ICOSA_FACES, radius, detail, smooth);
}

/**
 * Regular dodecahedron inscribed in a sphere of `radius`; each pentagon is three triangles, each subdivided by
 * `detail`. Same output rules as {@link polyhedronGeometry}: non-indexed, flat normals at detail 0, radial above unless
 * `smooth` says otherwise.
 */
export function dodecahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  return polyhedronGeometry(DODECA_VERTICES, DODECA_FACES, radius, detail, smooth);
}
