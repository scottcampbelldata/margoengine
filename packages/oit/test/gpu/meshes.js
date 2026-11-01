// Browser side of meshes-check.mjs.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { OIT } from '../../dist/index.js';
import { addMesh } from '../../dist/meshes.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const engine = await Engine.create(document.querySelector('canvas'), {
  backend: 'webgpu',
  preserveDrawingBuffer: true,
});
engine.camera.fov = 50;
engine.camera.position = [0, 0, 8];
engine.camera.target = [0, 0, 0];
const made = (color, position, size) =>
  engine
    .createMesh()
    .setGeometry(box(size, size, 0.2))
    .setMaterial(new PbrMaterial({ color, roughness: 0.6, metalness: 0 }))
    .setPosition(position);
made('#808080', [0, 0, -2], 6);
const red = made('#e01010', [0, 0, 0], 2),
  blue = made('#1010e0', [0, 0, 1], 2);
const oit = OIT.attach(engine);
let removers = [];
const draw = async () => {
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
};
window.check = {
  errors,
  draw,
  see: async (first) => {
    for (const mesh of first === 'red' ? [red, blue] : [blue, red])
      removers.push(addMesh(oit, engine, mesh, { opacity: 0.5 }));
    await draw();
  },
  move: async (x) => {
    red.setPosition([x, 0, 0]);
    blue.setPosition([x, 0, 1]);
    await draw();
  },
  remove: async () => {
    for (const remove of removers) remove();
    removers = [];
    await draw();
  },
};
await draw();
window.ready = true;
