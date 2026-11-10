import { Engine, Geometry, PbrMaterial } from '../../core/dist/index.js';
import { sphereGeometry } from '../../geometry/dist/index.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { loadGLTF } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { Toon, ModelOutlines } from '../dist/screen-outline.js';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
engine.camera.target = [0, 0, 0];
engine.camera.fov = 50;
const geometry = sphereGeometry(1, 64, 32);
const core = engine
    .createMesh()
    .setGeometry(new Geometry(geometry.positions, geometry.normals, geometry.indices))
    .setMaterial(new PbrMaterial({ color: '#ffffff' })),
  mesh = createMesh(engine, sphereGeometry(1, 64, 32), new Material({ color: '#ffffff' })),
  fox = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb'),
  animation = Animation.attach(fox);
animation.playing = false;
const projection = CameraProjection.attach(engine);
let effect;
window.check = {
  async run(kind, distance, width, orthographic = false, pose = 0.1) {
    effect?.dispose();
    effect = undefined;
    core.visible = kind === 'core';
    mesh.root.visible = kind === 'mesh';
    fox.root.visible = kind === 'fox';
    engine.camera.position = kind === 'fox' ? [110, 50, 60] : [0, 0, distance];
    engine.camera.target = kind === 'fox' ? [0, 35, 0] : [0, 0, 0];
    projection.mode = orthographic ? 'orthographic' : 'perspective';
    projection.height = distance;
    animation.seek(animation.clips[0].duration * pose);
    engine.gpu.pushErrorScope('validation');
    if (width) effect = (kind === 'core' ? Toon : ModelOutlines).attach(engine, { outline: width, color: [0, 1, 0] });
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
