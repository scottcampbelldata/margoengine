// Browser side of models-cull-check.mjs: engine A culls a materials instanced mesh with CulledModels, engine B draws the
// same mesh with no plugin. Rows sit on a grid; the mesh has two material groups, so two primitives share its instances.
import { Engine } from '../../../core/dist/index.js';
import { Material, createInstancedMesh } from '../../../materials/dist/index.js';
import { boxGeometry } from '../../../geometry/dist/index.js';
import { CulledModels } from '../../dist/models.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 400, position: [0, 12, 30], target: [0, 0, 0] },
  side = 40,
  count = side * side;
let a, b, ma, mb, culled;
const translated = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const build = (e) => {
  const mesh = createInstancedMesh(e, boxGeometry(1, 1, 1), new Material({ color: '#4080c0', roughness: 0.6 }), count + 64);
  for (let n = 0; n < count; n++) {
    mesh.instances.setMatrixAt(n, translated((n % side) * 3 - 60, (n % 7) / 2, Math.floor(n / side) * 3 - 60));
    mesh.instances.setColorAt(n, [(n % 5) / 4, (n % 3) / 2, 1]);
  }
  mesh.instances.count = count;
  return mesh;
};
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
const both = (edit) => {
  edit(ma);
  edit(mb);
};
async function setup(withShadows) {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  ma = build(a);
  mb = build(b);
  culled = CulledModels.attach(a, [ma]);
  if (withShadows) {
    const { Shadows } = await import('../../../shadows/dist/index.js');
    Shadows.attach(a, { resolution: 1024, filter: 'hard', distance: 80 }).add(ma);
    Shadows.attach(b, { resolution: 1024, filter: 'hard', distance: 80 }).add(mb);
  }
  await draw();
}
const steps = [
  ['overview', () => {}],
  ['close, most rows outside', () => look([0, 4, 10], [0, 0, 0])],
  ['a row moves into view', () => both((m) => m.instances.setMatrixAt(5, translated(0, 2, 4)))],
  ['fewer rows', () => both((m) => (m.instances.count = count - 700))],
  ['the root moves', () => both((m) => m.root.setPosition([3, 0, -2]))],
  ['from above, all in view', () => look([0, 160, 1])],
  ['removed from the culler: every row draws', () => culled.remove(ma)],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  const counts = [...(await culled.readCounts()).values()];
  return { label, drawn: counts.length ? Math.max(...counts) : -1, primitives: counts.length, total: ma.instances.count };
}
window.check = { setup, step, steps: steps.length, errors };
window.ready = true;
