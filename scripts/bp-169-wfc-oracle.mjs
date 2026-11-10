// Value-only WFC oracle: every solved grid is checked against every adjacency rule (constraint satisfaction), for the
// TypeScript heap, the SIMD heap and the legacy solver. No timings.
import { WFC } from '../packages/wfc/dist/index.js';
import { HeapWFC } from '../packages/wfc/dist/chunks.js';

const all = (n) => Array.from({ length: n }, (_, i) => i);
const band = (n, weight) =>
  Array.from({ length: n }, (_, t) => ({
    weight: weight(t),
    neighbors: Array.from({ length: 6 }, (_, d) => (d < 2 ? all(n).filter((u) => Math.abs(u - t) <= 1) : all(n))),
  }));
const step = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function violations(out, [w, h, d], tiles) {
  let bad = 0;
  for (let z = 0; z < d; z++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        step.forEach(([dx, dy, dz], dir) => {
          const X = x + dx, Y = y + dy, Z = z + dz;
          if (X < 0 || Y < 0 || Z < 0 || X >= w || Y >= h || Z >= d) return;
          if (!tiles[out[x + w * (y + h * z)]].neighbors[dir].includes(out[X + w * (Y + h * Z)])) bad++;
        });
  return bad;
}
for (const [name, dims, tiles] of [
  ['band-8-weighted', [32, 32, 1], band(8, (t) => 1 + (t % 3))],
  ['band-8-unit', [32, 32, 1], band(8, () => 1)],
  ['band-40-weighted', [12, 12, 4], band(40, (t) => 1 + (t % 5))],
]) {
  const solvers = [['heap-typescript', await HeapWFC.create(dims, tiles, { backend: 'typescript' })]];
  if (tiles.every((t) => t.weight === 1)) solvers.push(['heap-wasm', await HeapWFC.create(dims, tiles, { backend: 'wasm' })]);
  if (tiles.length <= 32) solvers.push(['legacy', new WFC(dims, tiles)]);
  for (const [solver, model] of solvers) {
    let solved = 0, bad = 0;
    for (let seed = 1; seed <= 20; seed++) {
      try {
        const out = solver === 'legacy' ? model.solve(seed, [], 4) : model.solve({ seed, attempts: 4 });
        solved++;
        bad += violations(out, dims, tiles);
      } catch {}
    }
    console.log(JSON.stringify({ case: name, solver, seeds: 20, solved, violations: bad }));
  }
}
