// Browser side of scale-check.mjs: one cloud at the most positions a default 128 MiB storage binding holds
// (11,184,810 at 12 B, byte colours), and one at the float-colour bound (8,388,608 at 16 B), with the default
// pointBudget of 1,000,000 and with every point drawn.
import { Engine } from '../../core/dist/index.js';
import { PointsPlugin, PointCloud } from '../dist/index.js';

const errors = [];
let engine, plugin, cloud;
async function run(count, floatColors, pointBudget) {
  if (!engine) {
    engine = await Engine.create(document.getElementById('a'), {
      camera: { fov: 50, near: 0.05, far: 20, position: [0, 0, 3.2], target: [0, 0, 0] },
    });
    engine.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
    engine.stop();
  }
  if (!plugin) engine.use((plugin = new PointsPlugin({ pointBudget })));
  if (cloud) {
    plugin.remove(cloud);
    cloud.dispose();
  }
  plugin.pointBudget = pointBudget;
  const positions = new Float32Array(count * 3),
    colors = floatColors ? new Float32Array(count * 4) : new Uint8Array(count * 3);
  let seed = 777;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = random() * 2 - 1;
    positions[i * 3 + 1] = random() * 2 - 1;
    positions[i * 3 + 2] = random() * 2 - 1;
    if (floatColors) colors.set([0.3, 0.9, 0.4, 1], i * 4);
    else colors.set([80, 230, 100], i * 3);
  }
  cloud = plugin.add(new PointCloud({ positions, colors, material: { size: 2 } }));
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
  return { count: cloud.positions.length / 3, wallMs: wall[4], drawn: plugin.stats?.pointsDrawn };
}
window.check = { run, errors };
window.ready = true;
