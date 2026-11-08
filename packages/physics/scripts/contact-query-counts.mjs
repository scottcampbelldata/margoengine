// `node packages/physics/scripts/contact-query-counts.mjs` after the package build. Deterministic work counts for
// touching and contactPoints at 5,000 cubes (the harness S9 layout), after 1 s and 10 s.
// Old walk: every pair row of the world (world_pair_rows) and the objects kernel.contacts() builds. New walk: the rows on
// the asking body's collider chains and their parts.
import { Physics } from '../dist/next.js';
await Physics.load();
const n = 5000, NONE = 0xffffffff, p = new Physics(null), side = Math.ceil(Math.cbrt(n)), bodies = [];
p.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [200, 0.5, 200], friction: 0.5 } });
for (let i = 0; i < n; i++)
  bodies.push(p.addBody(null, { position: [(i % side) * 1.1 - side / 2, 1 + Math.floor(i / (side * side)) * 1.1, (Math.floor(i / side) % side) * 1.1 - side / 2],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 1, friction: 0.5 } }));
const k = p.kernel, c = k.columns;
for (const steps of [60, 600]) {
  while (p.stepCount < steps) p.step();
  report(steps);
}
function report(steps) {
  const worldRows = k.api.world_pair_rows(), contacts = k.contacts();
  let oldObjects = 1;
  for (const m of contacts) oldObjects += 3 + 2 * m.points.length;
  let sum = 0, max = 0;
  for (const b of bodies) {
    let rows = 0;
    for (const col of b.colliders)
      for (let row = k.firstPair(col.handle); row !== NONE; row = k.nextPair(row, col.handle)) for (let q = row; q !== NONE; q = c.pairChild[q]) rows++;
    sum += rows; max = Math.max(max, rows);
  }
  console.log(`after ${steps} steps: old reads ${worldRows} pair rows and builds ${oldObjects} objects (${contacts.length} manifolds) per query; new reads ${(sum / n).toFixed(2)} rows mean, ${max} max, builds 0 (touching) or only the returned points (contactPoints)`);
}
