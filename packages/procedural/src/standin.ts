// A far tree in 12 triangles: what a forest draws beyond the distance at which it can afford real trees. Our own
// shape from the proportions of the full meshes (their measured hulls): a two-quad trunk cross and an eight-triangle
// canopy solid, one mesh so one draw covers the whole tree.

/** Canopy box of each full tree mesh: half widths in x and z, and the bottom, widest level and top of the crown. */
const CROWNS = {
  broadleaf: { x: 3.13, z: 3.48, low: 3.44, wide: 5.6, top: 7.48 },
  conifer: { x: 2.06, z: 2.43, low: 1.25, wide: 2.8, top: 7.4 },
  palm: { x: 3.1, z: 3.08, low: 7.6, wide: 8.0, top: 8.38 },
} as const;

/** The trunk's half width in metres. */
const TRUNK = 0.28;

/**
 * A far tree of 12 triangles (`positions`, `normals`, `indices`; local origin at the root, +Y up, the height and crown
 * width of `generateTreeMesh` and `generatePalmMesh` at reference size). Draw it through `Scatter` where a tree is a
 * few pixels. Normals point out of the crown, so it lights as one volume.
 * @param kind `'broadleaf'`, `'conifer'` or `'palm'`.
 * @throws RangeError for another kind.
 */
export function generateTreeStandIn(kind: 'broadleaf' | 'conifer' | 'palm'): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
} {
  const crown = CROWNS[kind];
  if (!crown) throw new RangeError("Invalid stand-in kind; pass 'broadleaf', 'conifer' or 'palm'.");
  const { x, z, low, wide, top } = crown,
    t = TRUNK,
    // prettier-ignore
    positions = new Float32Array([
      // Trunk cross, up to the crown.
      -t,
      0,
      0,
      t,
      0,
      0,
      t,
      low,
      0,
      -t,
      low,
      0,
      0,
      0,
      -t,
      0,
      0,
      t,
      0,
      low,
      t,
      0,
      low,
      -t,
      // Canopy: the bottom, a ring of four and the top.
      0,
      low,
      0,
      x,
      wide,
      0,
      0,
      wide,
      z,
      -x,
      wide,
      0,
      0,
      wide,
      -z,
      0,
      top,
      0,
    ]),
    // prettier-ignore
    normals = new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0,
      0, -1, 0, 1, 0,
    ]),
    // prettier-ignore
    indices = new Uint16Array([
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 10, 9, 8, 11, 10, 8, 12, 11, 8, 9, 12, 13, 9, 10, 13, 10, 11, 13, 11, 12,
      13, 12, 9,
    ]);
  return { positions, normals, indices };
}
