// Browser side of meshes-scale-check.mjs: 1,200,000 instances of one box, past 1,048,574, where core's instance buffer
// doubles to 2,097,150 slots (201 MB, more than one 128 MiB storage binding). Engine A culls them with CulledMeshes,
// engine B draws them with no plugin; the frames must match. Before the fix CulledMeshes bound core's whole instance
// buffer and sized its own lists to the next power of two (2,097,152 x 96 B), a validation error on every frame.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { CulledMeshes } from '../../dist/index.js';

const errors = [],
  count = 1_200_000,
  side = Math.ceil(Math.sqrt(count)),
  camera = { fov: 50, near: 0.1, far: 4000, position: [0, 300, 900], target: [0, 0, 0] };
let a, b, culled;
const cube = box(0.6, 0.6, 0.6),
  material = new PbrMaterial({ color: '#4dd966', roughness: 0.5 });
const fill = (e) => {
  for (let n = 0; n < count; n++)
    e.createMesh()
      .setGeometry(cube)
      .setMaterial(material)
      .setPosition([(n % side) - side / 2, 0, Math.floor(n / side) - side / 2]);
};
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
async function setup() {
  const options = { camera, capacity: count + 16 };
  a = await Engine.create(document.getElementById('a'), options);
  b = await Engine.create(document.getElementById('b'), options);
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  culled = CulledMeshes.attach(a);
  const start = performance.now();
  fill(a);
  fill(b);
  const fillMs = performance.now() - start;
  await draw();
  await draw();
  return { fillMs, binding: a.gpu.limits.maxStorageBufferBindingSize };
}
async function step(position, target) {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
  await draw();
  await draw();
  const wall = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    a.render({ culling: false });
    await a.gpu.queue.onSubmittedWorkDone();
    wall.push(performance.now() - start);
  }
  const counts = await culled.readCounts();
  wall.sort((x, y) => x - y);
  return { drawn: [...counts.values()].reduce((x, y) => x + y, 0), total: count, wallMs: wall[2] };
}
window.check = { setup, step, errors };
window.ready = true;
