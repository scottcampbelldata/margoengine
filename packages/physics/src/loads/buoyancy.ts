import { type HullMesh, type Quat, type Vec3, type WettedLoads, wettedLoads } from '../seakeeping/wetted.js';

export function boxSurface([x, y, z]: Vec3): HullMesh {
  return {
    vertices: [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    ],
  };
}

/** The unit-weight hydrostatic wrench of a closed mesh in a locally horizontal water plane. */
export function meshHydrostatics(mesh: HullMesh, rotation: Quat, depth: number, about: Vec3, out: WettedLoads): void {
  // Use body-centred coordinates and unit specific weight. The vertical force is then the
  // displaced volume, including in a zero-gravity world, by the divergence theorem.
  wettedLoads(
    mesh,
    { position: [0, 0, 0], rotation },
    { elevation: () => depth, pressure: (_x, y) => Math.max(0, depth - y) },
    0,
    about,
    out,
  );
}

/** Displaced fraction and centroid offset of an ellipsoid cut by a horizontal level. */
export function ellipsoidHydrostatics(
  axes: Vec3,
  frame: readonly [Vec3, Vec3, Vec3],
  halfHeight: number,
  depth: number,
  offset: [number, number, number],
): number {
  offset[0] = offset[1] = offset[2] = 0;
  if (depth <= -halfHeight) return 0;
  if (depth >= halfHeight) return 1;
  const cap = 1 + depth / halfHeight;
  // Integrate the unit sphere's horizontal discs, then apply the ellipsoid's linear map.
  const dryHeight = 2 - cap;
  const unitOffset = (-3 * dryHeight * dryHeight) / (4 * (3 - cap));
  for (let axis = 0; axis < 3; axis++) {
    const row = frame[axis]!;
    const projection = (axes[axis]! * row[1]) / halfHeight;
    const component = unitOffset * projection * axes[axis]!;
    offset[0] += component * row[0];
    offset[1] += component * row[1];
    offset[2] += component * row[2];
  }
  return (cap * cap * (3 - cap)) / 4;
}
