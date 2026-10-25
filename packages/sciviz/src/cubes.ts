// The marching cubes case table, derived here from the cube's geometry instead of being copied: the idea of
// W. E. Lorensen and H. E. Cline, "Marching cubes: a high resolution 3D surface construction algorithm", SIGGRAPH 1987,
// with every face's ambiguity resolved by one rule that both cubes sharing the face apply alike, so surfaces are closed
// (no cracks between cells; the face-consistency requirement of G. M. Nielson and B. Hamann, "The asymptotic decider",
// IEEE Visualization 1991, met with a fixed choice).
//
// For a case (which of the 8 corners are inside, i.e. above the iso level), each face contributes segments that cut
// off its runs of inside corners, directed from where the walk around the face (counter-clockwise seen from outside)
// leaves the inside to where it enters it. On a face whose corners alternate, the inside corners are cut off one by one
// (the outside connects across the face). Every crossed edge lies on two faces, which walk it in opposite directions,
// so it starts a segment on one face and ends one on the other: the segments chain into closed loops, one polygon per
// loop, fanned into triangles whose winding faces the outside (toward lower values).

/** Corner c of the unit cube sits at (c & 1, c >> 1 & 1, c >> 2 & 1). */
export const CORNERS: readonly (readonly [number, number, number])[] = Array.from({ length: 8 }, (_, c) => [
  c & 1,
  (c >> 1) & 1,
  (c >> 2) & 1,
]);

/** The 12 edges as corner pairs (a < b, differing in one coordinate), x edges first, then y, then z. */
export const EDGES: readonly (readonly [number, number])[] = [1, 2, 4].flatMap((bit) =>
  Array.from({ length: 8 }, (_, c) => c)
    .filter((c) => !(c & bit))
    .map((c) => [c, c | bit] as const),
);

const edgeOf = (a: number, b: number) => EDGES.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));

// The 6 faces as corner cycles, counter-clockwise seen from outside the cube.
const FACES: number[][] = [];
for (let axis = 0; axis < 3; axis++) {
  const u = (axis + 1) % 3,
    v = (axis + 2) % 3;
  for (const side of [0, 1]) {
    const cycle = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([a, b]) => (side << axis) | (a << u) | (b << v));
    // (u, v, axis) is right-handed, so this cycle runs counter-clockwise around +axis; reverse it for the -axis face.
    FACES.push(side ? cycle : cycle.reverse());
  }
}

/** Triangles (edge triples) of one case, wound to face the outside. */
export function caseTriangles(mask: number): number[][] {
  const inside = (c: number) => (mask >> c) & 1;
  const next = new Map<number, number>();
  for (const face of FACES)
    for (let i = 0; i < 4; i++) {
      // A run of inside corners starts after an outside corner; follow it to where it ends.
      if (inside(face[i]) || !inside(face[(i + 1) % 4])) continue;
      const enter = edgeOf(face[i], face[(i + 1) % 4]);
      let j = (i + 1) % 4;
      // On a face whose corners alternate, an inside corner's neighbours are outside, so each is its own run.
      while (inside(face[(j + 1) % 4])) j = (j + 1) % 4;
      const leave = edgeOf(face[j], face[(j + 1) % 4]);
      next.set(leave, enter);
    }
  const triangles: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    for (let e = start; !seen.has(e); e = next.get(e)!) {
      seen.add(e);
      loop.push(e);
    }
    for (let k = 1; k + 1 < loop.length; k++) triangles.push([loop[0], loop[k + 1], loop[k]]);
  }
  return triangles;
}

/** Most triangles any case has. */
export const MAX_TRIANGLES = Math.max(...Array.from({ length: 256 }, (_, m) => caseTriangles(m).length));

/**
 * The table as the GPU kernel reads it: `counts[case]` triangles, and `edges[case * stride + k]` their edge indices
 * (three per triangle), with `stride = 3 * MAX_TRIANGLES`.
 */
export function cubeTables(): { counts: Uint32Array; edges: Uint32Array; stride: number } {
  const stride = 3 * MAX_TRIANGLES,
    counts = new Uint32Array(256),
    edges = new Uint32Array(256 * stride);
  for (let m = 0; m < 256; m++) {
    const tris = caseTriangles(m);
    counts[m] = tris.length;
    tris.flat().forEach((e, k) => (edges[m * stride + k] = e));
  }
  return { counts, edges, stride };
}
