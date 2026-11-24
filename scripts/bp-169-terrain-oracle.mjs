// Value-only terrain oracle: TerrainQuery against its source samples, and the geometry-clipmap triangulation error per
// level (Losasso and Hoppe 2004). No timings.
import { TerrainQuery } from '../packages/terrain/dist/query.js';
import { Noise, fbm } from '../packages/procedural/dist/noise.js';

const side = 257,
  noise = new Noise(3),
  field = fbm((x, y) => noise.simplex2(x, y), { octaves: 6 }),
  heights = new Float32Array(side * side);
for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) heights[j * side + i] = field(i / 64, j / 64);
const scale = 100,
  offset = -20,
  query = new TerrainQuery(heights, side, side, { size: [256, 256], heightScale: scale, heightOffset: offset });
let sampleError = 0;
for (let j = 0; j < side; j++)
  for (let i = 0; i < side; i++)
    sampleError = Math.max(sampleError, Math.abs(query.height(i, j) - (heights[j * side + i] * scale + offset)));
console.log(JSON.stringify({ case: 'samples', count: side * side, maxError: sampleError }));
// A level-L ring places vertices 2^L cells apart and draws two triangles per cell, split from (1, 0) to (0, 1) as
// clipmapGrid indexes them; vertex heights are the bilinear heightmap there. Error = drawn minus bilinear surface.
for (let level = 0; level <= 4; level++) {
  const s = 2 ** level;
  let max = 0,
    sum = 0,
    n = 0;
  for (let z0 = 0; z0 + s <= 256; z0 += s)
    for (let x0 = 0; x0 + s <= 256; x0 += s) {
      const h00 = query.height(x0, z0),
        h10 = query.height(x0 + s, z0),
        h01 = query.height(x0, z0 + s),
        h11 = query.height(x0 + s, z0 + s);
      for (let b = 0; b <= 8; b++)
        for (let a = 0; a <= 8; a++) {
          const u = a / 8,
            v = b / 8,
            drawn =
              u + v <= 1
                ? h00 + (h10 - h00) * u + (h01 - h00) * v
                : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v),
            e = Math.abs(drawn - query.height(x0 + u * s, z0 + v * s));
          max = Math.max(max, e);
          sum += e * e;
          n++;
        }
    }
  console.log(JSON.stringify({ case: `ring-level-${level}`, spacingCells: s, maxError: max, rmsError: Math.sqrt(sum / n), heightRange: scale }));
}
