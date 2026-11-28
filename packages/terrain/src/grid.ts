/**
 * The fixed clipmap grid `Terrain` draws: `(resolution + 1)²` XZ corner vertices centred on the origin (one unit apart),
 * then one vertex at the centre of every cell (`resolution²` more, at half-unit offsets), and two triangle index lists:
 * `center`, every cell (the finest level), and `ring`, the cells outside the middle half-by-half block (three quarters
 * of the grid, drawn by every coarser level). Each cell is a fan of four triangles around its centre vertex, counter-
 * clockwise seen from above like the cell's two triangles were; the vertex shader puts the centre on the midpoint of the
 * diagonal that follows the ground (`terrainVertex`), so the four draw the cell split along that diagonal.
 * @throws RangeError unless `resolution` is a multiple of 4 from 8 to 256.
 */
export function clipmapGrid(resolution: number): { vertices: Float32Array; center: Uint32Array; ring: Uint32Array } {
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 256 || resolution % 4)
    throw new RangeError('Clipmap resolution must be a multiple of four in 8..256');
  // The ring is every cell outside the middle half-by-half block, three quarters of the grid, so both index lists have known sizes.
  const side = resolution + 1,
    corners = side ** 2,
    vertices = new Float32Array((corners + resolution ** 2) * 2),
    center = new Uint32Array(resolution ** 2 * 12),
    ring = new Uint32Array(resolution ** 2 * 9);
  for (let z = 0, v = 0; z <= resolution; z++)
    for (let x = 0; x <= resolution; x++) {
      vertices[v++] = x - resolution / 2;
      vertices[v++] = z - resolution / 2;
    }
  for (let z = 0, v = corners * 2; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      vertices[v++] = x + 0.5 - resolution / 2;
      vertices[v++] = z + 0.5 - resolution / 2;
    }
  for (let z = 0, i = 0, r = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      const a = z * side + x,
        b = a + 1,
        c = a + side,
        d = c + 1,
        e = corners + z * resolution + x,
        fan = [a, c, e, c, d, e, d, b, e, b, a, e];
      center.set(fan, i);
      i += 12;
      if (x < resolution / 4 || x >= (resolution * 3) / 4 || z < resolution / 4 || z >= (resolution * 3) / 4) {
        ring.set(fan, r);
        r += 12;
      }
    }
  return { vertices, center, ring };
}
