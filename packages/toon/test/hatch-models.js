import { Engine } from '../../core/dist/index.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { boxGeometry } from '../../geometry/dist/index.js';
import { loadGLTF } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { ModelHatching } from '../dist/hatch-models.js';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
const mesh = createMesh(engine, boxGeometry(8, 8, 0.1), new Material({ color: '#ffffff', roughness: 1 })),
  fox = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb'),
  animation = Animation.attach(fox);
animation.playing = false;
let effect;
window.check = {
  async run(kind, options, pose = 0.1) {
    effect?.dispose();
    effect = undefined;
    mesh.root.visible = kind !== 'fox';
    mesh.material = new Material({ color: '#ffffff', roughness: 1, shading: kind === 'basic' ? 'basic' : 'standard' });
    fox.root.visible = kind === 'fox';
    engine.camera.position = kind === 'fox' ? [110, 50, 60] : [0, 0, 10];
    engine.camera.target = kind === 'fox' ? [0, 35, 0] : [0, 0, 0];
    engine.camera.fov = 50;
    engine.lighting.direction[0] = Math.sqrt(1 - 0.4 ** 2);
    engine.lighting.direction[1] = 0;
    engine.lighting.direction[2] = 0.4;
    animation.seek(animation.clips[0].duration * pose);
    engine.gpu.pushErrorScope('validation');
    if (options) effect = ModelHatching.attach(kind === 'fox' ? fox : mesh, options);
    await waitForPipelines(async () => {
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
    });
    return { error: (await engine.gpu.popErrorScope())?.message };
  },
};
window.ready = true;
