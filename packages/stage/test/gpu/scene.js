// Browser side of scene-check.mjs: a saved document through addScene (A) against the same scene built by hand (B), with one
// load per model for every copy on B. The frames must match, and A must fetch the model once.
import { box, Engine, PbrMaterial } from '../../../core/dist/index.js';
import { Clustered } from '../../../clustered/dist/index.js';
import { loadGLTF } from '../../../gltf-pro/dist/index.js';
import { Stage } from '../../dist/index.js';
import { addScene } from '../../dist/scene.js';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const url = '/packages/exporters/tests/fixtures/BoxTextured.glb',
  errors = [],
  spots = [-3, -1, 1, 3],
  floorColor = '#a8b0b8',
  camera = { position: [1, 3, 9], target: [1, 0.5, 0], fov: 45, near: 0.1, far: 100 },
  turn = [-0.38268343, 0, 0, 0.92387953],
  lamp = { position: [-2, 2, 2], color: [1, 0.3, 0.1], intensity: 12, range: 10 },
  cone = { position: [3, 3, 1], color: [0.2, 0.4, 1], intensity: 30, range: 12 };
const document_ = {
  format: 'margo-save',
  version: 1,
  entities: [
    {
      id: 'floor',
      transform: { position: [0, -0.75, 0] },
      components: { mesh: { shape: 'box', size: [12, 0.5, 8] }, material: { color: floorColor, roughness: 0.8 } },
    },
    ...spots.map((x, i) => ({ id: `crate${i}`, transform: { position: [x, 0, 0] }, components: { mesh: url } })),
    { id: 'sun', transform: { rotation: turn }, components: { light: { intensity: 2, color: [1, 0.95, 0.9], ambient: 0.2 } } },
    { id: 'lamp', transform: { position: lamp.position }, components: { light: { type: 'point', color: lamp.color, intensity: lamp.intensity, range: lamp.range } } },
    {
      id: 'cone',
      transform: { position: cone.position, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
      components: { light: { type: 'spot', color: cone.color, intensity: cone.intensity, range: cone.range, innerConeAngle: 0.3, outerConeAngle: 0.6 } },
    },
    { id: 'view', transform: { position: camera.position }, components: { camera: { target: camera.target, fov: camera.fov, near: camera.near, far: camera.far } } },
  ],
};
let fetched = 0;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input.url ?? input).endsWith('BoxTextured.glb')) fetched++;
  return fetchOriginal(input, init);
};
async function run() {
  const a = await Engine.create(document.getElementById('a')),
    b = await Engine.create(document.getElementById('b'), { camera });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  const stage = new Stage(a),
    scene = await addScene(stage, document_),
    forA = fetched;
  fetched = 0;
  // B: every step by hand, and a load of its own for each copy.
  b.createMesh().setGeometry(box(12, 0.5, 8)).setMaterial(new PbrMaterial({ color: floorColor, roughness: 0.8 })).setPosition([0, -0.75, 0]);
  const lights = Clustered.attach(b);
  for (const x of spots) {
    const holder = b.createMesh().setPosition([x, 0, 0]),
      model = await loadGLTF(b, url);
    model.root.setParent(holder);
    lights.add(model);
  }
  const back = [0, Math.SQRT1_2, Math.SQRT1_2];
  b.lighting.direction.set([...back, 2]);
  b.lighting.radiance.set([1, 0.95, 0.9, 0.2]);
  lights.setLights([lamp, { ...cone, direction: [0, -1, 0], innerAngle: 0.3, outerAngle: 0.6 }]);
  await waitForPipelines(async () => {
    for (const e of [a, b]) e.render({ culling: false });
    await Promise.all([a, b].map((e) => e.gpu.queue.onSubmittedWorkDone()));
  });
  const copies = [...scene.models.values()];
  return {
    fetched: forA,
    fetchedByHand: fetched,
    models: copies.length,
    assets: new Set(copies.map((model) => model.asset)).size,
    draws: [a.stats.drawCalls, b.stats.drawCalls],
    camera: [...a.camera.position],
    sun: [...a.lighting.direction],
  };
}
window.check = { run, errors };
window.ready = true;
