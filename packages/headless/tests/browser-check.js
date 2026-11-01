// The same scene on a page canvas and on the stand-in, each on its own engine and device of the same adapter.
import { Camera, Engine, PbrMaterial, box } from '../../core/src/index.ts';
import { createHeadlessCanvas, installGPU, toPNG } from '../src/index.ts';

const scene = (engine) => {
  engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#84d6bd', roughness: 0.3 }));
  return new Camera({ position: [1.6, 1.4, 2.6], target: [0, 0, 0] });
};
window.check = {
  async page() {
    const engine = await Engine.create(document.querySelector('#page'), { backend: 'webgpu' });
    engine.render({ camera: scene(engine) });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    window.pageEngine = engine;
  },
  async headless() {
    const installed = installGPU({ gpu: navigator.gpu }),
      canvas = createHeadlessCanvas({ width: 256, height: 192 }),
      engine = await Engine.create(canvas, { backend: 'webgpu' }),
      errors = [];
    engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    engine.render({ camera: scene(engine) });
    const png = await toPNG(engine),
      format = canvas.getContext('webgpu').getConfiguration().format;
    engine.dispose();
    installed.dispose();
    return { png: [...png], format, errors };
  },
};
window.ready = true;
