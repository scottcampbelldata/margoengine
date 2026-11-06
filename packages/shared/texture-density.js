// How much of a texture a surface shows: the numbers behind streaming a texture by its size on screen.
const SAMPLE = 4096;

/**
 * Bounds and UV spans of a packed primitive (20 floats a vertex: position at 0, UV sets 0 and 1 at 12 and 14; sets 2 and 3
 * in `uvs`, 4 floats a vertex), from at most 4096 of its triangles. A span is the square root of surface area over UV area:
 * on a surface mapped evenly it is the local length one 0 to 1 texture covers, so tiling and atlases need no special case. A
 * set with no UV area (a placeholder box, or a set the file lacks) spans the bounding sphere.
 */
export function measureSurface(vertices, indices, uvs) {
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let o = 0; o < vertices.length; o += 20)
    for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a], vertices[o + a]);
      high[a] = Math.max(high[a], vertices[o + a]);
    }
  const centre = [0, 1, 2].map((a) => (low[a] + high[a]) / 2 || 0),
    radius = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) / 2 || 0,
    count = Math.floor(indices.length / 3),
    step = Math.max(1, Math.floor(count / SAMPLE)),
    uvArea = [0, 0, 0, 0];
  let area = 0;
  const uv = (vertex, set, axis) =>
    set < 2 ? vertices[vertex * 20 + 12 + set * 2 + axis] : (uvs?.[vertex * 4 + (set - 2) * 2 + axis] ?? 0);
  for (let t = 0; t < count; t += step) {
    const a = indices[t * 3],
      b = indices[t * 3 + 1],
      c = indices[t * 3 + 2],
      p = a * 20,
      q = b * 20,
      r = c * 20,
      ux = vertices[q] - vertices[p],
      uy = vertices[q + 1] - vertices[p + 1],
      uz = vertices[q + 2] - vertices[p + 2],
      vx = vertices[r] - vertices[p],
      vy = vertices[r + 1] - vertices[p + 1],
      vz = vertices[r + 2] - vertices[p + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    for (let set = 0; set < 4; set++) {
      const s = uv(a, set, 0),
        w = uv(a, set, 1);
      uvArea[set] += Math.abs((uv(b, set, 0) - s) * (uv(c, set, 1) - w) - (uv(c, set, 0) - s) * (uv(b, set, 1) - w)) / 2;
    }
  }
  return { centre, radius, spans: uvArea.map((u) => (u > 0 && area > 0 ? Math.sqrt(area / u) : radius * 2)) };
}

/** Largest column length of the 4x4 matrix at `o`: the most it scales a length. */
export function scaleOf(m, o = 0) {
  return Math.max(
    Math.hypot(m[o], m[o + 1], m[o + 2]),
    Math.hypot(m[o + 4], m[o + 5], m[o + 6]),
    Math.hypot(m[o + 8], m[o + 9], m[o + 10]),
  );
}
