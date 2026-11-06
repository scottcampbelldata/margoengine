// Browser side of shadows-cull-check.mjs: casters spread far past the near cascades, on a floor that receives their shadows.
// Engines A and C cull casters per cascade (CascadeParts, CascadeInstances); B and D draw every caster in every cascade.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { Shadows } from '../../../shadows/dist/index.js';
import { CulledParts } from '../../dist/parts.js';
import { DynamicInstances } from '../../dist/dynamic.js';
import { CascadeInstances, CascadeParts } from '../../dist/shadows.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 300, position: [4, 7, 14], target: [0, 0, 0] },
  cube = box(1, 2, 1),
  color = new PbrMaterial({ color: '#d8703a', roughness: 0.6, doubleSided: false }),
  floorColor = new PbrMaterial({ color: '#c8c8c8', roughness: 0.9, doubleSided: false }),
  side = 40,
  count = side * side,
  spot = (n) => [((n % side) - side / 2) * 4, 1, (Math.floor(n / side) - side / 2) * 4];
const matrix = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
let a, b, c, d, cascadeParts, plainParts, cascadeRows, plainRows;
const engines = () => [a, b, c, d];
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
  for (let n = 0; n < count; n++) transforms.set(matrix(spot(n)), n * 16);
  return [{ geometry: cube, material: color, transforms }];
};
async function setup() {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera });
  c = await Engine.create(document.getElementById('c'), { camera });
  d = await Engine.create(document.getElementById('d'), { camera });
  for (const e of engines()) {
    e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
    e.createMesh().setGeometry(box(400, 0.25, 400)).setMaterial(floorColor).setPosition([0, -0.125, 0]);
  }
  cascadeParts = CascadeParts.attach(a, batches());
  plainParts = CulledParts.attach(b, batches());
  cascadeRows = CascadeInstances.attach(c, { geometry: cube, material: color, capacity: count });
  plainRows = DynamicInstances.attach(d, { geometry: cube, material: color, capacity: count });
  for (let n = 0; n < count; n++) {
    const m = matrix(spot(n));
    for (const rows of [cascadeRows, plainRows]) rows.addInstance(m);
  }
  const options = { resolution: 1024, filter: 'hard', distance: 60, cascades: 3 };
  [
    [a, cascadeParts],
    [b, plainParts],
    [c, cascadeRows],
    [d, plainRows],
  ].forEach(([e, caster]) => Shadows.attach(e, options).add(caster));
  await draw();
  await draw();
}
const steps = [
  ['overview', () => {}],
  ['close', () => look([1, 2, 6], [0, 1, 0])],
  ['far side', () => look([40, 14, 40], [20, 0, 20])],
  [
    'hide every 3rd',
    () => {
      for (let n = 0; n < count; n += 3) {
        cascadeParts.setVisible(0, n, false);
        plainParts.setVisible(0, n, false);
        cascadeRows.setVisibleAt(n, false);
        plainRows.setVisibleAt(n, false);
      }
    },
  ],
  [
    'moved in',
    () => {
      const m = matrix([38, 1, 38]);
      for (const parts of [cascadeParts, plainParts]) parts.setTransform(0, 1, m);
      for (const rows of [cascadeRows, plainRows]) rows.setMatrixAt(1, m);
    },
  ],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  await draw();
  return { label, parts: await cascadeParts.readCascades(), rows: await cascadeRows.readCascades(), count };
}
window.check = { setup, step, steps: steps.length, errors };
window.ready = true;
