// World bounding spheres for CPU culls: clustered LocalShadows' per-map caster cull, the LOD imposter cull and
// gltf-pro's progressive load order.

/**
 * Radius of a local sphere of radius `radius` moved by the column-major 4x4 at `m[o]`. The largest stretch of the
 * upper 3x3 M is the square root of the largest eigenvalue of G = M^T M, bounded by G's largest absolute row sum
 * (Gershgorin). Exact for rotation and scale (G is diagonal: the longest column), and still an upper bound under the
 * shear a rotated child of a non-uniformly scaled parent gets, where the longest column alone is short. Padded by 1e-5
 * of the world centre's (`cx`, `cy`, `cz`) distance from the origin plus the radius, for float32 positions and planes.
 */
export function worldRadius(m, o, radius, cx = 0, cy = 0, cz = 0) {
  const ax = m[o],
    ay = m[o + 1],
    az = m[o + 2],
    bx = m[o + 4],
    by = m[o + 5],
    bz = m[o + 6],
    cxx = m[o + 8],
    cyy = m[o + 9],
    czz = m[o + 10],
    aa = ax * ax + ay * ay + az * az,
    bb = bx * bx + by * by + bz * bz,
    cc = cxx * cxx + cyy * cyy + czz * czz,
    ab = Math.abs(ax * bx + ay * by + az * bz),
    ac = Math.abs(ax * cxx + ay * cyy + az * czz),
    bc = Math.abs(bx * cxx + by * cyy + bz * czz),
    r = radius * Math.sqrt(Math.max(aa + ab + ac, bb + ab + bc, cc + ac + bc));
  return r + 1e-5 * (Math.hypot(cx, cy, cz) + r);
}
