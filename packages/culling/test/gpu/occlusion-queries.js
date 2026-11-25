// Browser side of occlusion-queries-check.mjs: a wall at z = 0 hides a box and a mesh behind it from a camera at
// z = 20, while a box in front stays in view. Each step renders until a result from after the change has landed.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { OcclusionQueries } from '../../dist/occlusion.js';

const errors = [];
let engine, queries, front, behind, hidden, hiddenMesh;
async function settle() {
  // Results land one to three frames after their query: render until two sets have landed after the change.
  for (let n = 0; n < 2; n++) {
    const landed = queries.next({ signal: AbortSignal.timeout(10000) });
    for (let i = 0; i < 4; i++) {
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
    }
    await landed;
  }
}
const read = (q) => ({
  occluded: q.isOccluded,
  samples: q.samples,
  known: q.hasResult,
});
async function setup(exact) {
  // exact: no MSAA (one sample, depth32float-stencil8 or depth32float); otherwise the tier's 4x MSAA.
  engine = await Engine.create(document.getElementById(exact ? 'b' : 'a'), {
    ...(exact && { exactSize: [480, 320] }),
    camera: {
      fov: 50,
      near: 0.1,
      far: 200,
      position: [0, 0, 20],
      target: [0, 0, 0],
    },
  });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const grey = new PbrMaterial({ color: '#b0b0b0', roughness: 0.8 });
  engine
    .createMesh()
    .setGeometry(box(12, 12, 0.5))
    .setMaterial(grey);
  hiddenMesh = engine
    .createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(grey)
    .setPosition([1, 0, -6]);
  queries = OcclusionQueries.attach(engine);
  front = queries.add({ min: [3, -1, 4], max: [4, 0, 5] });
  behind = queries.add({ min: [-1, -1, -10], max: [1, 1, -8] });
  hidden = queries.add(hiddenMesh);
}
async function step(i) {
  if (i === 1) engine.camera.position = [40, 0, -9]; // round the wall's side: everything behind it shows
  if (i === 2) engine.camera.position = [0, 0, 20];
  await settle();
  return {
    front: read(front),
    behind: read(behind),
    mesh: read(hidden),
    pipelines: [...queries.gpu.pipelines.keys()],
  };
}
function dispose() {
  queries.dispose();
  engine.dispose();
}
window.check = { setup, step, dispose, errors };
window.ready = true;
