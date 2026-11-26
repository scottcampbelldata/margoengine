// Lobovsky, Botia-Vera, Castellana, Mas-Soler and Souto-Iglesias's dam break (J. Fluids Struct. 48, 2014, 407-434;
// arXiv 1308.0115), in three dimensions: a tank 1.61 m long, 0.6 m high and 0.15 m wide, water 0.3 m deep behind a gate
// 0.6 m from the end wall, the gate gone at once (theirs lifts in 0.06 to 0.1 s). Measures the front's mean speed along
// the dry bed after t* = t sqrt(g / H) = 1, against their 1.56 sqrt(g H) (Table 1), and the peak pressure on the far
// wall's centre line at 3, 15, 30 and 80 mm, against their medians over 100 runs, 91.44, 57.49, 43.76 and 30.15 mbar
// (2.5 to 97.5 percent: 75.06 to 130.98, 53.26 to 63.31, 39.79 to 49.62, 24.18 to 36.32; Table 2).
// Usage (after npm run build): node scripts/check-dambreak3d.mjs [cell size, m] [frames a second]
import { FlipSolver } from '../dist/flip.js';
import { PhysicsWorld } from '../dist/world.js';

const G = 9.81,
  H = 0.3,
  h = Number(process.argv[2] ?? 0.01),
  fps = Number(process.argv[3] ?? 240),
  L = 1.61,
  liquid = new FlipSolver(),
  world = new PhysicsWorld({ rate: { num: fps, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
    cells: [Math.round(L / h), Math.round(0.6 / h), Math.round(0.15 / h)],
    cellSize: h,
    rate: Math.round(Math.log2(fps / 60)),
    maxSubsteps: 256,
    initial: (x, y) => x < 0.6 && y < H,
  }),
  sensors = [0.003, 0.015, 0.03, 0.08],
  peak = sensors.map(() => 0),
  front = [],
  start = performance.now();
for (let f = 1; f <= Math.round(0.9 * fps); f++) {
  world.advance(f);
  const t = f / fps,
    p = liquid.positions();
  let x = 0;
  for (let q = 0; q < p.length; q += 3) if (p[q + 1] < 0.05) x = Math.max(x, p[q]);
  front.push([t, x]);
  sensors.forEach((z, s) => {
    // The pressure in the cells against the far wall (the box is a whole number of cells, at most L long).
    peak[s] = Math.max(peak[s], liquid.pressureAt(Math.round(L / h) * h - h / 2, z, 0.075));
  });
}
// The front's mean speed from t* = 1 until it is within 5 cm of the far wall.
const tStar = (t) => t * Math.sqrt(G / H),
  run = front.filter(([t, x]) => tStar(t) >= 1 && x < Math.round(L / h) * h - 0.05),
  n = run.length,
  mt = run.reduce((a, r) => a + r[0], 0) / n,
  mx = run.reduce((a, r) => a + r[1], 0) / n,
  v = run.reduce((a, r) => a + (r[0] - mt) * (r[1] - mx), 0) / run.reduce((a, r) => a + (r[0] - mt) * (r[0] - mt), 0);
console.log(`cells ${h * 100} cm, ${fps} frames a second, ${((performance.now() - start) / 1000).toFixed(0)} s`);
console.log(`front ${(v / Math.sqrt(G * H)).toFixed(3)} sqrt(g H) after t* = 1 (theirs 1.56)`);
const theirs = [91.44, 57.49, 43.76, 30.15];
sensors.forEach((z, s) =>
  console.log(`peak at ${z * 1000} mm: ${(peak[s] / 100).toFixed(2)} mbar (median ${theirs[s]})`),
);
