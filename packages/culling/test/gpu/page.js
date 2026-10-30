// Browser side of dynamic-check.mjs: engine A draws boxes through @margoengine/culling's DynamicInstances (GPU matrices,
// frustum culling and indirect draws through core's batch redirect), engine B draws the same boxes as plain core meshes
// with no culling. Same edits on both (moves, hides, deletes, adds, camera moves, shadows); picks are compared too.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { DynamicInstances } from '../../dist/dynamic.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 200, position: [14, 10, 18], target: [0, 0, 0] },
  side = 24,
  count = side * side,
  palette = [
    [0.9, 0.2, 0.1],
    [0.1, 0.6, 0.9],
    [0.95, 0.8, 0.2],
    [0.3, 0.85, 0.4],
  ];
let a, b, crowd, casters;
const meshes = [],
  ids = [];
const geometry = box(1, 1, 1);
// Core meshes take one material per colour; DynamicInstances one white material tinted per instance, so both shade
// with the same colour floats (1 times the tint).
const materials = palette.map((rgb) => {
  const m = new PbrMaterial({ color: '#ffffff', roughness: 0.5, metalness: 0.1, doubleSided: false });
  m.data.set(rgb, 0);
  return m;
});
const white = new PbrMaterial({ color: '#ffffff', roughness: 0.5, metalness: 0.1, doubleSided: false });
function place(mesh, i, t = 0) {
  const k = 0.4 + 0.2 * ((i * 7) % 3);
  mesh.setPosition([(i % side) - side / 2, 0.5 + 0.3 * Math.sin(i + t), Math.floor(i / side) - side / 2]);
  mesh.setRotation([0, i * 0.37 + t, 0]);
  mesh.setScale([k, k, k]);
}
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
// Each instance's matrix is read back from the core mesh after B's kernel computed it, so both draw the same floats.
const settle = () => b.render({ culling: false });
const add = (i, material, t) => {
  const mesh = b.createMesh().setGeometry(geometry).setMaterial(materials[material]);
  place(mesh, i, t);
  casters?.add(mesh);
  return mesh;
};
async function setup(withShadows) {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera, capacity: 2048 });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  crowd = DynamicInstances.attach(a, { geometry, material: white, capacity: count + 64 });
  for (let i = 0; i < count; i++) meshes.push(add(i, i % 4, 0));
  settle();
  for (let i = 0; i < count; i++) {
    ids.push(crowd.addInstance(meshes[i].matrix));
    crowd.setColorAt(ids[i], palette[i % 4]);
  }
  if (withShadows) {
    const { Shadows } = await import('../../../shadows/dist/index.js');
    const sa = Shadows.attach(a, { resolution: 1024, filter: 'hard', distance: 60 }),
      sb = Shadows.attach(b, { resolution: 1024, filter: 'hard', distance: 60 });
    sa.add(crowd);
    for (const mesh of meshes) sb.add(mesh);
    casters = sb;
  }
  await draw();
  return { count };
}
const look = (position, target = [0, 0, 0]) => {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const steps = [
  ['overview', () => {}],
  ['close view (most boxes outside the frustum)', () => look([2, 1.5, 3], [1, 0.5, 1])],
  [
    'move every 3rd box',
    () => {
      for (let i = 0; i < count; i += 3) place(meshes[i], i, 0.8);
      settle();
      for (let i = 0; i < count; i += 3) crowd.setMatrixAt(ids[i], meshes[i].matrix);
    },
  ],
  ['overview after moves', () => look([14, 10, 18])],
  [
    'hide every 5th box',
    () => {
      for (let i = 0; i < count; i += 5) {
        meshes[i].visible = false;
        crowd.setVisibleAt(ids[i], false);
      }
    },
  ],
  [
    'delete every 11th, show the hidden again',
    () => {
      for (let i = 0; i < count; i += 5) {
        meshes[i].visible = true;
        crowd.setVisibleAt(ids[i], true);
      }
      for (let i = 0; i < count; i += 11) {
        meshes[i].dispose();
        crowd.deleteInstance(ids[i]);
        meshes[i] = null;
      }
    },
  ],
  [
    'add boxes into deleted slots and past the end',
    () => {
      const added = [];
      for (let n = 0; n < 100; n++) {
        const i = n * 11 < count ? n * 11 : count + n;
        meshes[i] = add(i, (i + 1) % 4, 1.3);
        added.push(i);
      }
      settle();
      for (const i of added) {
        ids[i] = crowd.addInstance(meshes[i].matrix);
        crowd.setColorAt(ids[i], palette[(i + 1) % 4]);
      }
    },
  ],
  ['view from below', () => look([3, -6, 9])],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  return { label, drawn: await crowd.readCount(), alive: crowd.count };
}
// Picks over a grid: B returns a core mesh, A an instance index; both must name the same box.
async function picks() {
  look([14, 10, 18]);
  await draw();
  const out = [],
    canvas = document.getElementById('a');
  for (let y = 20; y < canvas.clientHeight; y += 40)
    for (let x = 20; x < canvas.clientWidth; x += 40) {
      const [p, q] = await Promise.all([crowd.pick(x, y), b.pick(x, y)]);
      out.push([p === null ? null : ids.indexOf(p), q ? meshes.indexOf(q) : null]);
    }
  return out;
}
window.check = { setup, step, steps: steps.length, picks, errors };
window.ready = true;
