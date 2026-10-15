// Recorded GPU work for particle configurations. `node packages/vfx/test/traces.js <dist>` rewrites
// fixtures/traces.json from a build. First recorded before the entry split (1970fda); re-recorded when the particle
// layout, culling and one-triangle billboards changed the GPU work (examples/package-benchmarks/vfx-gpu.mjs proves the pixels).
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const obstacles = () => [
  { kind: 'sphere', center: [0, 1, 0], radius: 0.5 },
  { kind: 'box', center: [2, 0, 0], halfSize: [1, 2, 3] },
];
const texture = () => ({
  width: 2,
  height: 2,
  data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 255, 255, 255, 255]),
});
/** Options (fresh per run) and the feature entries each needs. */
export const configs = {
  'night-citadel': {
    features: [],
    options: () => ({
      capacity: 2048,
      initialCount: 2048,
      rate: 2048 / 30,
      position: [0, 12, 0],
      emissionExtent: [28, 20, 25],
      velocity: [0, 0.04, 0],
      gravity: [0, 0, 0],
      spread: 0.06,
      lifetime: [25, 45],
      size: 0.035,
      ground: -26,
      turbulence: 0.05,
      frequency: 0.18,
      color: [1, 0.65, 0.22, 0.65],
      intensity: 4,
    }),
  },
  afterlight: {
    features: [],
    options: () => ({
      capacity: 100000,
      initialCount: 100000,
      rate: 5000,
      position: [0, 4, 0],
      emissionExtent: [80, 3, 80],
      velocity: [0, 0.03, 0],
      gravity: [0, 0, 0],
      spread: 0.08,
      lifetime: [25, 45],
      size: 0.01,
      ground: 0.35,
      turbulence: 0.035,
      frequency: 0.22,
      color: [1, 0.85, 0.4, 0.5],
      intensity: 5,
    }),
  },
  obstacles: { features: ['obstacles'], options: () => ({ capacity: 300, initialCount: 100, obstacles: obstacles() }) },
  wrap: {
    features: ['wrap'],
    options: () => ({ capacity: 300, initialCount: 300, rate: 0, emissionExtent: [3, 3, 3], wrap: true }),
  },
  sort: { features: ['sort'], options: () => ({ capacity: 300, initialCount: 300, sort: true }) },
  texture: { features: ['texture'], options: () => ({ capacity: 64, texture: texture() }) },
  'leaf-field': {
    features: ['obstacles', 'wrap', 'sort', 'texture'],
    options: () => ({
      capacity: 5000,
      initialCount: 5000,
      rate: 0,
      position: [0, 0, 0],
      emissionExtent: [3, 3, 3],
      wrap: true,
      velocity: [0, 0, 0],
      spread: 0,
      gravity: [0.4, -0.5, 0],
      turbulence: 0.2,
      size: 0.07,
      lifetime: [1e6, 1e6],
      ground: -1e30,
      bounce: 0.5,
      angularVelocity: 1,
      color: [0.93, 0.53, 0.17, 0.85],
      obstacles: obstacles(),
      sort: true,
      texture: texture(),
    }),
  },
};

/** Attach, three frames (with a burst), restoration, one frame, disposal. */
export function trace(VFX, name, features) {
  const config = configs[name],
    h = tracedGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new VFX(config.options(), features) : new VFX(config.options());
  h.engine.use(effect);
  h.frame();
  effect.burst(7);
  h.frame();
  h.frame();
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.dispose();
  return h;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { VFX } = await import(pathToFileURL(resolve(process.argv[2] ?? 'packages/vfx/dist', 'index.js')).href),
    result = {};
  for (const name of Object.keys(configs)) {
    const h = trace(VFX, name);
    result[name] = { digest: h.digest(), created: h.created.length, commands: h.commands().length };
  }
  await writeFile(new URL('./fixtures/traces.json', import.meta.url), JSON.stringify(result, null, 1) + '\n');
  console.log(result);
}
