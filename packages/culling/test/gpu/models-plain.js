// Browser side of models-plain-check.mjs: engine A culls primitives without instances with CulledModels, engine B draws
// the same scene with no plugin. Two scenes: a grid of materials meshes with a wall that hides them, and a real glTF file.
import { Engine } from '../../../core/dist/index.js';
import { Material, createInstancedMesh, createMesh } from '../../../materials/dist/index.js';
import { boxGeometry } from '../../../geometry/dist/index.js';
import { loadGLTF } from '../../../gltf-pro/dist/index.js';
import { CulledModels } from '../../dist/models.js';

const errors = [],
  side = 12;
let a, b, sceneA, sceneB, culled, steps;
const draw = async () => {
  a.render();
  b.render();
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
const look = (position, target = [0, 0, 0]) => {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const grid = (e) => {
  const boxes = [];
  for (let n = 0; n < side * side; n++) {
    const mesh = createMesh(e, boxGeometry(1, 1, 1), new Material({ color: [(n % 5) / 4, (n % 3) / 2, 1], roughness: 0.6 }));
    mesh.root.setPosition([(n % side) * 3 - 16, (n % 7) / 2, Math.floor(n / side) * 3 - 16]);
    boxes.push(mesh);
  }
  const wall = createMesh(e, boxGeometry(70, 30, 1), new Material({ color: '#c08040', roughness: 0.8 }));
  wall.root.setPosition([0, 0, 500]);
  // Instance rows take the same Hi-Z test.
  const rows = createInstancedMesh(e, boxGeometry(1, 1, 1), new Material({ color: '#50c070', roughness: 0.5 }), 25);
  for (let n = 0; n < 25; n++) rows.instances.setMatrixAt(n, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (n % 5) * 3 - 6, 3, Math.floor(n / 5) * 3 - 6, 1]);
  rows.instances.count = 25;
  return { boxes, wall, rows };
};
const both = (edit) => {
  edit(sceneA);
  edit(sceneB);
};
const scenes = {
  async grid() {
    sceneA = grid(a);
    sceneB = grid(b);
    culled = CulledModels.attach(a, [...sceneA.boxes, sceneA.wall, sceneA.rows], { occlusion: true });
    culled.addOccluder(sceneA.wall);
    look([0, 12, 30]);
    return [
      ['overview, nothing hidden', () => {}],
      ['close, most outside', () => look([0, 2, 6], [0, 0, 0])],
      ['a box moves into view', () => both((s) => s.boxes[140].root.setPosition([0, 1, 1]))],
      [
        'the wall comes between',
        () => {
          look([0, 12, 40]);
          both((s) => s.wall.root.setPosition([0, 0, 22]));
        },
      ],
      ['the camera moves past the wall', () => look([0, 12, 18])],
      [
        'a box stands in front of the wall',
        () => {
          look([0, 12, 40]);
          both((s) => s.boxes[7].root.setPosition([0, 4, 26]));
        },
      ],
      ['the wall stops occluding: the frame is still the same', () => culled.removeOccluder(sceneA.wall)],
      [
        'removed from the culler: every primitive draws',
        () => {
          for (const m of [...sceneA.boxes, sceneA.wall, sceneA.rows]) culled.remove(m);
        },
      ],
    ];
  },
  async nodes() {
    const url = '/examples/assets/khronos/NodePerformanceTest/NodePerformanceTest.glb';
    sceneA = await loadGLTF(a, url);
    sceneB = await loadGLTF(b, url);
    culled = CulledModels.attach(a, [sceneA]);
    a.render();
    // Where the 10,000 nodes stand: their middle and how far they spread.
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (const { node } of sceneA.primitives)
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], node.matrix[12 + k]);
        high[k] = Math.max(high[k], node.matrix[12 + k]);
      }
    const middle = low.map((v, k) => (v + high[k]) / 2),
      size = Math.max(...low.map((v, k) => high[k] - v)),
      from = (x, y, z) => [middle[0] + x * size, middle[1] + y * size, middle[2] + z * size],
      far = from(0.2, 0.9, 1.2);
    look(far, middle);
    return [
      ['overview', () => {}],
      ['close, inside the field', () => look(from(0, 0.02, 0.1), from(0.1, 0, 0.1))],
      ['the model moves', () => both((m) => m.root.setPosition([size * 0.02, 0, 0]))],
      ['back out', () => look(far, middle)],
    ];
  },
};
async function setup(name) {
  const camera = { fov: 50, near: 0.1, far: name === 'nodes' ? 100000 : 400, position: [0, 12, 30], target: [0, 0, 0] };
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  steps = await scenes[name]();
  await draw();
  return steps.length;
}
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  const counts = [...(await culled.readCounts()).values()];
  return { label, drawn: counts.reduce((x, y) => x + y, 0), primitives: counts.length };
}
window.check = { setup, step, errors };
window.ready = true;
