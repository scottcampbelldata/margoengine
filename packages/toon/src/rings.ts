// Seam-free outlines: vertices that share a position (a hard edge or a UV seam split them) are linked in a ring, so the
// hull's vertex shader can average the normals of every copy and push all of them out the same way.

/**
 * For each vertex of `vertices` (`stride` floats a vertex, position first), the next vertex at exactly the same
 * position, round to itself: a vertex alone at its position points at itself. Positions match bit for bit, with -0
 * the same as 0.
 */
export function positionRings(vertices: Float32Array, stride = 20): Uint32Array {
  const count = Math.floor(vertices.length / stride),
    ring = new Uint32Array(count),
    last = new Map<string, number>(),
    first = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const o = i * stride,
      key = (vertices[o] || 0) + ',' + (vertices[o + 1] || 0) + ',' + (vertices[o + 2] || 0),
      before = last.get(key);
    if (before === undefined) first.set(key, i);
    else ring[before] = i;
    ring[i] = first.get(key)!;
    last.set(key, i);
  }
  return ring;
}
