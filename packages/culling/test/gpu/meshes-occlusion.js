// Browser side of meshes-occlusion-check.mjs: engine A culls core meshes with CulledMeshes and occlusion, engine B draws
// the same scene with no plugin. A wall of large boxes hides a crowd of small ones, whose two geometries each hold many
// instances. Frames must match while the camera moves around and past the wall.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { CulledMeshes } from '../../dist/index.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 300, position: [0, 3, 40], target: [0, 2, 0] };
let a, b, plain, culled;
const wall = box(4, 12, 1),
  small = box(0.6, 0.6, 0.6),
  round = box(0.4, 1.2, 0.4),
  colors = ['#e6331a', '#1a99e6', '#f2cc33', '#4dd966'].map(
    (color) => new PbrMaterial({ color, roughness: 0.5, doubleSided: false }),
  ),
  slab = new PbrMaterial({ color: '#c8c8c8', roughness: 0.8, doubleSided: true });
const fill = (e) => {
  const list = [];
  for (let i = 0; i < 9; i++) {
    const mesh = e.createMesh().setGeometry(wall).setMaterial(slab);
    mesh.setPosition([(i - 4) * 4, 3, 10]);
    list.push(mesh);
  }
  for (let n = 0; n < 1500; n++) {
    const mesh = e.createMesh().setGeometry(n % 3 ? small : round).setMaterial(colors[n % 4]);
    mesh.setPosition([((n % 30) - 15) * 1, ((n * 7) % 5) * 1, -Math.floor(n / 30)]);
    list.push(mesh);
  }
  return list;
};
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
const look = (position, target = [0, 2, 0]) => {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
async function setup() {
  a = await Engine.create(document.getElementById('a'), { camera, capacity: 4096 });
  b = await Engine.create(document.getElementById('b'), { camera, capacity: 4096 });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  culled = CulledMeshes.attach(a, { occlusion: true });
  plain = fill(a);
  const other = fill(b);
  steps[3][1] = () => {
    for (const list of [plain, other]) for (let i = 0; i < 9; i += 2) list[i].visible = false;
  };
  steps[4][1] = () => {
    for (const list of [plain, other]) for (let i = 0; i < 9; i += 2) list[i].visible = true;
    for (const list of [plain, other]) for (let n = 9; n < 60; n++) list[n].setPosition([(n % 30) - 15, 9.5, 12]);
  };
  await draw();
  await draw();
}
const steps = [
  ['behind the wall', () => {}],
  ['still, second frame', () => {}],
  ['side step: the crowd comes into view at once', () => look([34, 6, 26], [0, 2, -10])],
  ['back; every other wall box hidden', null],
  ['walls back, some small boxes in front of them', null],
  ['from above', () => look([0, 40, 12], [0, 0, -5])],
  ['inside the crowd', () => look([0.3, 2.3, -20.5], [0, 2, 0])],
  ['back behind the wall', () => look([0, 3, 40])],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  await draw();
  const counts = await culled.readCounts();
  return { label, drawn: [...counts.values()].reduce((x, y) => x + y, 0), total: 1509 };
}
window.check = { setup, step, steps: steps.length, errors };
window.ready = true;
