// Browser side of scale-check.mjs: one cloud at the per-cloud limit of 3,000,000 splats (no SH), and one at the most
// degree-3 SH splats a default 128 MiB storage binding holds (699,050), drawn and sorted every frame.
import { Engine } from '../../../core/dist/index.js';
import { Splats } from '../../dist/index.js';

const errors = [];
let engine, cloud;
function cloudOf(count, shCoefficients) {
  const positions = new Float32Array(count * 3),
    covariances = new Float32Array(count * 6),
    colors = new Float32Array(count * 4),
    sh = shCoefficients ? new Float32Array(count * shCoefficients * 3) : undefined;
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    positions.set([random() * 2 - 1, random() * 2 - 1, random() * 2 - 1], i * 3);
    covariances.set([1e-4, 0, 0, 1e-4, 0, 1e-4], i * 6);
    colors.set([0.2 + 0.8 * random(), 0.6, 0.3, 0.9], i * 4);
    if (sh) sh[i * shCoefficients * 3] = 1;
  }
  return sh ? { positions, covariances, colors, sphericalHarmonics: sh } : { positions, covariances, colors };
}
async function run(count, shCoefficients) {
  if (!engine) {
    engine = await Engine.create(document.getElementById('a'), {
      camera: { fov: 50, near: 0.05, far: 20, position: [0, 0, 3.2], target: [0, 0, 0] },
    });
    engine.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
    engine.stop();
  }
  cloud?.dispose();
  cloud = Splats.attach(engine, cloudOf(count, shCoefficients));
  for (let i = 0; i < 3; i++) {
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
  }
  const wall = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    wall.push(performance.now() - start);
  }
  wall.sort((x, y) => x - y);
  return { count: cloud.count, wallMs: wall[4] };
}
window.check = { run, errors };
window.ready = true;
