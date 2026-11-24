// A far tree in 14 triangles: what a forest draws beyond the distance at which it can afford real trees. Our own
// shape from the proportions of the full meshes (their measured hulls): an open three-sided trunk prism and an
// eight-triangle canopy solid, one mesh so one draw covers the whole tree. Every triangle winds counter-clockwise seen
// from outside, the front face of a single-sided material, so the stand-in shows the same faces from every side.

/** Canopy box of each full tree mesh: half widths in x and z, and the bottom, widest level and top of the crown. */
const CROWNS = {
  broadleaf: { x: 3.13, z: 3.48, low: 3.44, wide: 5.6, top: 7.48 },
  conifer: { x: 2.06, z: 2.43, low: 1.25, wide: 2.8, top: 7.4 },
  palm: { x: 3.1, z: 3.08, low: 7.6, wide: 8.0, top: 8.38 },
} as const;

/** The trunk prism's circumradius in metres: 0.28 m half width seen side on (0.28 * 2 / sqrt(3)). */
const TRUNK = 0.3233;

/**
 * A far tree of 14 triangles (`positions`, `normals`, `indices`; local origin at the root, +Y up, the height and crown
 * width of `generateTreeMesh` and `generatePalmMesh` at reference size). Draw it through `Scatter` where a tree is a
 * few pixels. Normals point out of the crown, so it lights as one volume, and every triangle faces out, so a
 * single-sided material shows it whole from any side.
 * @param kind `'broadleaf'`, `'conifer'` or `'palm'`.
 * @throws RangeError for another kind.
 */
export function generateTreeStandIn(kind: 'broadleaf' | 'conifer' | 'palm'): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
} {
  if (!Object.hasOwn(CROWNS, kind)) throw new RangeError("Invalid stand-in kind; pass 'broadleaf', 'conifer' or 'palm'.");
  const { x, z, low, wide, top } = CROWNS[kind],
    r = TRUNK,
    s = Math.sqrt(3) / 2,
    // prettier-ignore
    positions = new Float32Array([
      // Trunk prism up to the crown: corners at 90, 210 and 330 degrees about +Y, at the root, then at the crown.
      0, 0, r, -s * r, 0, -r / 2, s * r, 0, -r / 2,
      0, low, r, -s * r, low, -r / 2, s * r, low, -r / 2,
      // Canopy: the bottom, a ring of four and the top.
      0, low, 0, x, wide, 0, 0, wide, z, -x, wide, 0, 0, wide, -z, 0, top, 0,
    ]),
    // prettier-ignore
    normals = new Float32Array([
      0, 0, 1, -s, 0, -0.5, s, 0, -0.5,
      0, 0, 1, -s, 0, -0.5, s, 0, -0.5,
      0, -1, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1, 0, 1, 0,
    ]),
    // prettier-ignore
    indices = new Uint16Array([
      // Trunk sides: per pair of root corners (i, j), the triangles (j, i, i + 3) and (j, i + 3, j + 3).
      1, 0, 3, 1, 3, 4, 2, 1, 4, 2, 4, 5, 0, 2, 5, 0, 5, 3,
      // Canopy: four faces down to the bottom, four up to the top.
      6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 7, 11, 8, 7, 11, 9, 8, 11, 10, 9, 11, 7, 10,
    ]);
  return { positions, normals, indices };
}
