// Browser side of bounds-check.mjs: rods just under a plate. Engine A culls with bounds: 'box', C with spheres, and B draws
// The view is straight down: a flat occluder under a slanted view has a depth range as long as the rod and hides nothing.
// the same scene as core meshes. A and B must match; A must drop rods C keeps.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { CulledParts } from '../../dist/parts.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 200, position: [0.1, 40, 0.2], target: [0, 0, 0] },
  plate = box(90, 0.05, 90),
  rod = box(6, 0.1, 0.1),
  plateColor = new PbrMaterial({ color: '#8d99a6', roughness: 0.7, doubleSided: false }),
  rodColor = new PbrMaterial({ color: '#e6331a', roughness: 0.4, doubleSided: false }),
  count = 900;
let a, b, c, boxes, spheres, meshes;
const engines = () => [a, b, c];
const draw = async () => {
  for (const e of engines()) e.render({ culling: false });
  await Promise.all(engines().map((e) => e.gpu.queue.onSubmittedWorkDone()));
};
const look = (position, target = [0, 0, 0]) => {
  for (const e of engines()) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const batches = () => {
  const transforms = new Float32Array(count * 16);
  // Core's own matrices, so both sides hold the same floats.
  for (let n = 0; n < count; n++) transforms.set(meshes[n].matrix, n * 16);
  return [
    { geometry: plate, material: plateColor, transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    { geometry: rod, material: rodColor, transforms },
  ];
};
async function setup() {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera, capacity: 2048 });
  c = await Engine.create(document.getElementById('c'), { camera });
  for (const e of engines()) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  b.createMesh().setGeometry(plate).setMaterial(plateColor);
  meshes = [];
  // Rotated rods, so their boxes are oriented; each sits 0.3 under the plate.
  for (let n = 0; n < count; n++) {
    const mesh = b.createMesh().setGeometry(rod).setMaterial(rodColor);
    mesh.setPosition([(n % 30) - 15, -0.3, Math.floor(n / 30) - 15]);
    mesh.setRotation([0, (n % 8) * 0.39, 0]);
    meshes.push(mesh);
  }
  b.render({ culling: false });
  boxes = CulledParts.attach(a, batches(), { culling: 'occlusion', bounds: 'box' });
  spheres = CulledParts.attach(c, batches(), { culling: 'occlusion' });
  await draw();
  await draw();
}
const steps = [
  ['above the plate', () => {}],
  ['still', () => {}],
  ['low over the plate', () => look([0, 1, 30])],
  ['under the plate: every rod shows', () => look([0, -8, 20])],
  ['frustum edge: the view skims the rods', () => look([0, -2, -30], [40, -2, -30])],
  ['moved parts', () => {
    meshes[3].setPosition([-12, 2, -15]);
    b.render({ culling: false });
    boxes.setTransform(1, 3, meshes[3].matrix);
    spheres.setTransform(1, 3, meshes[3].matrix);
    look([0.1, 40, 0.2]);
  }],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  await draw();
  const [x, y] = [await boxes.readCounts(), await spheres.readCounts()];
  return { label, box: x[1], sphere: y[1] };
}
window.check = { setup, step, steps: steps.length, errors };
window.ready = true;
