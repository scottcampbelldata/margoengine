// Browser side of sort-scale-check.mjs: 1,200,000 instances of one box, past 1,048,574, where core's instance buffer
// doubles to 2,097,150 slots (201 MB). The device's storage binding is held to WebGPU's default 128 MiB (as an adapter
// offering no more, or the WebGL2 layer), so the doubled buffer is past one binding. Engine A orders them with
// FrontToBack, engine B draws them with no plugin; the frames must match. Before the fix FrontToBack bound core's whole
// instance buffer, a validation error on every frame.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { FrontToBack } from '../../dist/sort.js';

const binding = 128 * 1024 * 1024,
  request = GPUAdapter.prototype.requestDevice;
GPUAdapter.prototype.requestDevice = function (descriptor = {}) {
  const limits = { ...descriptor.requiredLimits };
  if (!(limits.maxStorageBufferBindingSize <= binding)) limits.maxStorageBufferBindingSize = binding;
  return request.call(this, { ...descriptor, requiredLimits: limits });
};
const errors = [],
  count = 1_200_000,
  side = Math.ceil(Math.sqrt(count)),
  camera = { fov: 50, near: 0.1, far: 4000, position: [0, 300, 900], target: [0, 0, 0] };
let a, b;
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
  a.use(new FrontToBack());
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
  wall.sort((x, y) => x - y);
  return { total: count, wallMs: wall[2] };
}
window.check = { setup, step, errors };
window.ready = true;
