import { Engine, Geometry, PbrMaterial } from '../../core/dist/index.js';
import { sphereGeometry, boxGeometry } from '../../geometry/dist/index.js';
import { MeshOutline } from '../dist/outline.js';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
engine.camera.target = [0, 0, 0];
engine.camera.fov = 50;
const make = (g) => new Geometry(g.positions, g.normals, g.indices);
const sphere = make(sphereGeometry(1, 64, 32)),
  box = make(boxGeometry(1.4, 1.4, 1.4));
const mesh = engine.createMesh().setMaterial(new PbrMaterial({ color: '#ffffff' }));
let outline;
window.check = {
  // shape: 'sphere' or 'box'; scaleX -1 mirrors the mesh.
  async run({ shape = 'sphere', distance = 5, scaleX = 1, ...options }) {
    outline?.dispose();
    mesh.setGeometry(shape === 'box' ? box : sphere);
    mesh.setScale([scaleX, 1, 1]);
    engine.camera.position = [0, 0, distance];
    engine.gpu.pushErrorScope('validation');
    outline = MeshOutline.attach(engine, { mesh, color: [0, 1, 0], ...options });
    await waitForPipelines(async () => {
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
    });
    const error = await engine.gpu.popErrorScope();
    if (error) errors.push(error.message);
    return { errors: errors.splice(0) };
  },
};
window.ready = true;
