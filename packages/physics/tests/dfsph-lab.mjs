import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DfsphSolver } from '../dist/dfsph.js';
import { PhysicsWorld } from '../dist/world.js';

// Table 2 plane rectangular section, a = 2¼ in, H = 2a, tank thickness a.
// Use the same experiment columns at Z = 1.44, 2.33 and 3.00; subtract their individual time origins.
const measured = [
  [0.71, 1.14],
  [1.19, 1.67],
];
const target = [1.44, 2.33, 3.0];

export async function measureSurge({ profile, resolution, capillarity }) {
  const a = 0.05715;
  const g = 9.81;
  const clock = 480;
  const spacing = a / resolution;
  const particles = [];
  for (let x = 0; x < resolution; x++)
    for (let y = 0; y < 2 * resolution; y++)
      for (let z = 0; z < resolution; z++)
        particles.push({ position: [(x + 0.5) * spacing, (y + 0.5) * spacing, (z + 0.5) * spacing] });

  const world = new PhysicsWorld({ rate: { num: clock, den: 1 }, gravity: [0, -g, 0] });
  const liquid = await DfsphSolver.load(world.memory, { rate: 3 });
  world.add(liquid, {
    friction: 0,
    spacing,
    profile,
    viscosity: 1e-6,
    surfaceTension: capillarity ? 0.07274 : 0,
    bounds: [
      [0, 0, 0],
      [8 * a, 3 * a, a],
    ],
    particles,
  });

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
  assert.ok(Math.abs(liquid.mass - 1000 * a * (2 * a) * a) <= 32 * Number.EPSILON);
  return measured.map(([minimum, maximum], slot) => {
    // Two simulated brackets, two rounded table entries, and half of a 300 fps frame per
    // experimental crossing (section 3, each trial timed from an oscillator on the film).
    const error = 2 * dt + 0.01 + rateScale / 300;
    const elapsed = captured[slot + 1] - captured[0];
    return {
      profile,
      resolution,
      station: target[slot + 1],
      elapsed,
      minimum,
      maximum,
      error,
      matches: elapsed >= minimum - error && elapsed <= maximum + error,
    };
  });
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refined = process.argv.includes('--refined');
  const onlyInteractive = process.argv.includes('--interactive');
  const profiles = onlyInteractive ? ['interactive'] : refined ? ['accurate'] : ['interactive', 'accurate'];
  const trials = [];
  for (const profile of profiles)
    trials.push(
      ...(await measureSurge({
        profile,
        resolution: refined ? 18 : 12,
        capillarity: refined || process.argv.includes('--capillary'),
      })),
    );
  console.log(JSON.stringify(trials, null, 2));
  if (trials.some(({ matches }) => !matches)) process.exitCode = 1;
}
