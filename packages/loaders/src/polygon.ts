// Triangles of one planar polygon given by point indices, for formats whose polygons may be concave.
import { triangulate } from '@margoengine/geometry/triangulate';

/**
 * Corner triples (0 based, into `corners`) of a polygon that is not convex, ear-clipped on the plane of its Newell
 * normal so each triple turns the way the polygon does; `null` when the polygon is convex or degenerate, where a fan
 * from corner 0 is right. Ear clipping: D. Eberly, Triangulation by Ear Clipping, 2002 (geometry/triangulate).
 *
 * @param points Coordinates, three per point.
 * @param corners Point indices of the polygon in order.
 */
export function concaveTriangles(points: ArrayLike<number>, corners: ArrayLike<number>): number[] | null {
  const n = corners.length;
  if (n < 4) return null;
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let c = 0, d = n - 1; c < n; d = c++) {
    const a = corners[d] * 3,
      b = corners[c] * 3;
    nx += (points[a + 1] - points[b + 1]) * (points[a + 2] + points[b + 2]);
    ny += (points[a + 2] - points[b + 2]) * (points[a] + points[b]);
    nz += (points[a] - points[b]) * (points[a + 1] + points[b + 1]);
  }
  const ax = Math.abs(nx),
    ay = Math.abs(ny),
    az = Math.abs(nz);
  if (!(ax + ay + az > 0)) return null;
  // Drop the normal's largest axis; swap the other two when the normal points down it, so the turn is kept.
  const [u, w] =
    az >= ax && az >= ay
      ? nz >= 0
        ? [0, 1]
        : [1, 0]
      : ax >= ay
        ? nx >= 0
          ? [1, 2]
          : [2, 1]
        : ny >= 0
          ? [2, 0]
          : [0, 2];
  const flat = new Array<number>(n * 2);
  for (let c = 0; c < n; c++) {
    flat[c * 2] = points[corners[c] * 3 + u];
    flat[c * 2 + 1] = points[corners[c] * 3 + w];
  }
  let convex = true;
  for (let c = 0; c < n && convex; c++) {
    const p = (c + n - 1) % n,
      q = (c + 1) % n,
      ex = flat[c * 2] - flat[p * 2],
      ey = flat[c * 2 + 1] - flat[p * 2 + 1],
      fx = flat[q * 2] - flat[c * 2],
      fy = flat[q * 2 + 1] - flat[c * 2 + 1];
    if (ex * fy - ey * fx < 0) convex = false;
  }
  return convex ? null : triangulate(flat, [], 2);
}
