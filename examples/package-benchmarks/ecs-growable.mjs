// Cost of a GrowableWorld's resizable arrays against a fixed World's plain ones: one system's loop over 100,000 rows.
// Run after a build: node examples/package-benchmarks/ecs-growable.mjs
// Same work on both sides, in alternating rounds. Published in docs/limits.md and docs/whitepaper/perf-history.md.
import { World } from '../../packages/ecs/dist/index.js';
import { GrowableWorld } from '../../packages/ecs/dist/growable.js';

const count = 100_000,
  rounds = 8,
  passes = 500;
function scene(world) {
  const position = world.component({ x: Float32Array }),
    velocity = world.component({ x: Float32Array });
  for (let i = 0; i < count; i++) {
    const entity = world.create();
    position.add(entity, { x: i });
    velocity.add(entity, { x: 1 });
  }
  return { position, velocity };
}
function run({ position, velocity }) {
  const x = position.fields.x,
    v = velocity.fields.x,
    start = performance.now();
  for (let pass = 0; pass < passes; pass++) for (let i = 0; i < count; i++) x[i] += v[i] * 0.016;
  return (performance.now() - start) / passes;
}
const sides = { fixed: scene(new World(131072)), growable: scene(new GrowableWorld({ capacity: 1024 })) },
  times = { fixed: [], growable: [] };
for (const side of Object.keys(sides)) run(sides[side]);
for (let round = 0; round < rounds; round++) for (const side of Object.keys(sides)) times[side].push(run(sides[side]));
const median = (list) => [...list].sort((a, b) => a - b)[list.length >> 1];
const fixed = median(times.fixed),
  growable = median(times.growable);
console.log(`fixed ${fixed.toFixed(3)} ms, growable ${growable.toFixed(3)} ms, ratio ${(growable / fixed).toFixed(2)}`);
