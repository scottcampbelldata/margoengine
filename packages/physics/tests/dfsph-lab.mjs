import assert from 'node:assert/strict';
import { DfsphSolver } from '../dist/dfsph.js';
import { PhysicsWorld } from '../dist/world.js';

async function solve(params, worldOptions, options) {
  const world = new PhysicsWorld(worldOptions);
  const liquid = await DfsphSolver.load(world.memory, options);
  world.add(liquid, { friction: 0, ...params });
  return { world, liquid };
}

// Table 2 plane rectangular section, a = 2¼ in, H = 2a, tank thickness a.
// Use the same experiment columns at Z = 1.44, 2.33 and 3.00; subtract their individual time origins.
const measured = [
  [0.71, 1.14],
  [1.19, 1.67],
];
const a = 0.05715;
const g = 9.81;
const n = 12;
const clock = 480;
const spacing = a / n;
const particles = [];
for (let x = 0; x < n; x++)
  for (let y = 0; y < 2 * n; y++)
    for (let z = 0; z < n; z++)
      particles.push({ position: [(x + 0.5) * spacing, (y + 0.5) * spacing, (z + 0.5) * spacing] });
const target = [1.44, 2.33, 3.0];
const trials = [];
const capillary = process.argv.includes('--capillary');
for (const profile of ['interactive', 'accurate']) {
  const { world, liquid } = await solve(
    {
      spacing,
      profile,
      viscosity: 1e-6,
      surfaceTension: capillary ? 0.07274 : 0,
      bounds: [
        [0, 0, 0],
        [8 * a, 3 * a, a],
      ],
      particles,
    },
    { rate: { num: clock, den: 1 }, gravity: [0, -g, 0] },
    { rate: 3 },
  );
  const captured = [];
  let previous = 1;
  const storage = new Float32Array(particles.length * 3);
  const rateScale = Math.sqrt((2 * g) / a);
  const dt = rateScale / clock;
  for (let frame = 1; frame <= 100 && captured.length < target.length; frame++) {
    world.advance(frame);
    liquid.positions(storage);
    let front = a;
    for (let i = 0; i < storage.length; i += 3)
      if (storage[i + 1] < 2 * spacing) front = Math.max(front, storage[i] + 0.5 * spacing);
    const normalized = front / a;
    while (normalized >= target[captured.length])
      captured.push((frame - 1 + (target[captured.length] - previous) / (normalized - previous)) * dt);
    previous = normalized;
  }
  assert.equal(captured.length, target.length);
  for (let slot = 0; slot < measured.length; slot++) {
    const [minimum, maximum] = measured[slot];
    // Two simulated brackets, two rounded table entries, and half of a 300 fps frame per
    // experimental crossing (section 3, each trial timed from an oscillator on the film).
    const error = 2 * dt + 0.01 + rateScale / 300;
    const elapsed = captured[slot + 1] - captured[0];
    trials.push({
      profile,
      station: target[slot + 1],
      elapsed,
      minimum,
      maximum,
      error,
      matches: elapsed >= minimum - error && elapsed <= maximum + error,
    });
  }
  assert.ok(Math.abs(liquid.mass - 1000 * a * (2 * a) * a) <= 32 * Number.EPSILON);
}

console.log(JSON.stringify(trials, null, 2));
if (trials.some(({ matches }) => !matches)) process.exitCode = 1;
