// Writes tests/fixtures/replay-hash.json from a run in Node, after a change to the kernel: build first. The file names the
// kernel sources it came from, so a stale one fails; the native test and every browser must then match it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { kernelSourceHash } from './build-kernel.mjs';
import { KernelWorld, Physics } from '../dist/next.js';
import { REPLAY_EVERY, REPLAY_STEPS, kernelScene, physicsScene } from '../tests/replay-scene.js';

await Physics.load();
const folder = new URL('../tests/fixtures/', import.meta.url);
mkdirSync(folder, { recursive: true });
writeFileSync(
  new URL('replay-hash.json', folder),
  `${JSON.stringify(
    {
      kernelSource: kernelSourceHash(),
      steps: REPLAY_STEPS,
      every: REPLAY_EVERY,
      kernel: kernelScene(KernelWorld),
      physics: physicsScene(Physics),
    },
    null,
    1,
  )}\n`,
);
console.log('replay hashes written');
