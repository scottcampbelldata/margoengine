// A capsule slides sideways over a large floor with a gap of a few millimetres: nothing touches, so a correct shape cast
// answers no hit. Runs the same scene on the own kernel and on Rapier 0.21 (the test oracle) for floors of several sizes,
// each in its own process under a hard time limit, and prints one JSON line a run. Usage:
//   node packages/physics/scripts/compare-rapier-floors.mjs [--limit=60] [--floors=40,200,800]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')),
);
if (args.child) {
  const { RapierPhysics } = await import('../tests/oracle.js');
  const { Physics } = await import('../dist/index.js');
  const warn = console.warn;
  console.warn = () => {};
  await Promise.all([Physics.load(), RapierPhysics.load()]);
  console.warn = warn;
  const World = args.child === 'own' ? Physics : RapierPhysics;
  const half = Number(args.half);
  const physics = new World(null, { gravity: [0, 0, 0] });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [half, 0.5, half] },
  });
  physics.step();
  const started = performance.now();
  const falseHits = {};
  for (const gap of [0.005, 0.02, 0.05]) {
    let hits = 0;
    for (let k = 0; k < 25; k++) {
      const x = (k - 12) * (half / 14);
      // A capsule lying along z, its lowest point `gap` above the floor, cast along x over the floor.
      const hit = physics.shapeCast(
        { shape: 'capsule', halfHeight: 0.4, radius: 0.3 },
        [x, 0.3 + gap, 0],
        [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        [1, 0, 0],
        { maxDistance: 5 },
      );
      if (hit) hits++;
    }
    falseHits[`${gap * 1000} mm`] = hits;
  }
  console.log(
    JSON.stringify({
      engine: args.child,
      floor: `${2 * half} m`,
      ms: Math.round(performance.now() - started),
      falseHitsOf25: falseHits,
    }),
  );
} else {
  const limit = Number(args.limit ?? 60) * 1000;
  for (const half of (args.floors ?? '20,100,400').split(',').map(Number))
    for (const engine of ['own', 'rapier']) {
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--child=${engine}`, `--half=${half}`], {
        encoding: 'utf8',
        timeout: limit,
        killSignal: 'SIGKILL',
      });
      console.log(
        run.error
          ? JSON.stringify({ engine, floor: `${2 * half} m`, result: `no answer in ${limit / 1000} s` })
          : run.stdout.trim() || run.stderr.trim().slice(0, 200),
      );
    }
}
