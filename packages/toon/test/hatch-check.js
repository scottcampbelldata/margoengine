// Browser side of hatch-check.mjs: a white board facing the camera, lit at a chosen angle, under Hatching.
import { Engine, box, PbrMaterial } from '../../core/dist/index.js';
import { Hatching } from '../dist/hatch.js';
import { Shadows } from '../../shadows/dist/index.js';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
engine.camera.fov = 50;
engine.camera.position = [0, 0, 10];
engine.camera.target = [0, 0, 0];
engine
  .createMesh()
  .setGeometry(box(8, 8, 0.1))
  .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1, metalness: 0 }));
const hatching = Hatching.attach(engine);
window.check = {
  // light: n.l of the board, 0..1; options: Hatching's.
  async run(light, options) {
    engine.gpu.pushErrorScope('validation');
    const d = engine.lighting.direction;
    d[0] = Math.sqrt(1 - light * light);
    d[1] = 0;
    d[2] = light;
    hatching.set(options);
    await waitForPipelines(async () => {
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
    });
    const error = await engine.gpu.popErrorScope();
    if (error) errors.push(error.message);
    return { errors: errors.splice(0) };
  },
  async runWithShadows() {
    const shadows = Shadows.attach(engine, { cascades: 1, resolution: 512, distance: 20 });
    const caster = engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setPosition([1, 0, 2]);
    const remove = shadows.add(caster);
    try {
      return await this.run(0.6, { style: 'hatch', spacing: 16, width: 4 });
    } finally {
      remove();
      caster.dispose();
      shadows.dispose();
    }
  },
};
window.ready = true;
