// Value-only procedural oracle: Worley F1 against an exhaustive 125-cell definition, and Poisson-disk spacing
// (Bridson 2007's separation property) on the Wasm sampler. No timings.
import { Noise } from '../packages/procedural/dist/noise.js';
import { createPoissonSampler } from '../packages/procedural/dist/poisson.js';

const hash = (x, y, z, seed) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};
// Worley (1996) F1 with one feature per cell, written from the documented definition: every cell within two.
const exhaustive = (seed, x, y, z) => {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  let best = Infinity;
  for (let a = -2; a <= 2; a++)
    for (let b = -2; b <= 2; b++)
      for (let c = -2; c <= 2; c++) {
        const cx = ix + a,
          cy = iy + b,
          cz = iz + c,
          dx = cx + hash(cx, cy, cz, seed) / 4294967296 - x,
          dy = cy + hash(cx, cy, cz, seed ^ 0x9e3779b9) / 4294967296 - y,
          dz = cz + hash(cx, cy, cz, seed ^ 0x85ebca6b) / 4294967296 - z;
        best = Math.min(best, dx * dx + dy * dy + dz * dz);
      }
  return Math.sqrt(best);
};
let state = 12345,
  mismatches = 0;
const random = () => ((state = Math.imul(state ^ (state >>> 15), 2246822519) + 1) >>> 0) / 4294967296;
const noise = new Noise(42);
for (let i = 0; i < 100000; i++) {
  const x = (random() - 0.5) * 2000,
    y = (random() - 0.5) * 2000,
    z = (random() - 0.5) * 2000;
  if (!Object.is(noise.worley(x, y, z), exhaustive(42, x, y, z))) mismatches++;
}
console.log(JSON.stringify({ case: 'worley-vs-exhaustive', samples: 100000, mismatches }));
using sampler = await createPoissonSampler();
for (const radius of [0.5, 1, 2]) {
  const { positions, attempts } = sampler.rectangle([0, 0, 40, 40], { radius, seed: 9, limit: 65536 });
  let min = Infinity;
  for (let i = 0; i < positions.length; i += 2)
    for (let j = i + 2; j < positions.length; j += 2)
      min = Math.min(min, Math.hypot(positions[i] - positions[j], positions[i + 1] - positions[j + 1]));
  console.log(JSON.stringify({ case: `poisson-r${radius}`, points: positions.length / 2, attempts, minSpacing: min, radius }));
}
