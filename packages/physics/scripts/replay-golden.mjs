// Writes tests/fixtures/replay-hash.json from a run in Node, after a change to the kernel: build first. The file names the
// kernel sources it came from, so a stale one fails; the native test and every browser must then match it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { kernelSourceHash } from './build-kernel.mjs';
import { KernelWorld, Physics } from '../dist/index.js';
import { REPLAY_ADAPTIVE_STEPS, REPLAY_EVERY, REPLAY_STEPS, kernelScene, physicsScene } from '../tests/replay-scene.js';

await Physics.load();
const folder = new URL('../tests/fixtures/', import.meta.url);
mkdirSync(folder, { recursive: true });
const [kernelArena, kernelBlockArena, physicsArena, physicsAdaptiveArena] = [[], [], [], []];
// The state hashes (`kernel`, `kernelBlock`, `physics`) leave out the order a step solved in; the arena hashes see every word
// of the world, so they move when that order does. A change that only reorders independent work moves the arena lists and
// leaves the state ones as they were.
const kernel = kernelScene(KernelWorld, undefined, undefined, undefined, kernelArena);
const kernelBlock = kernelScene(KernelWorld, undefined, undefined, { blockSolver: true }, kernelBlockArena);
const physics = physicsScene(Physics, undefined, physicsArena);
const physicsAdaptive = physicsScene(Physics, REPLAY_ADAPTIVE_STEPS, physicsAdaptiveArena, true);
writeFileSync(
  new URL('replay-hash.json', folder),
  `${JSON.stringify(
    {
      kernelSource: kernelSourceHash(),
      steps: REPLAY_STEPS,
      every: REPLAY_EVERY,
      kernel,
      kernelBlock,
      physics,
      physicsAdaptive,
      kernelArena,
      kernelBlockArena,
      physicsArena,
      physicsAdaptiveArena,
    },
    null,
    1,
  )}\n`,
);
console.log('replay hashes written');
