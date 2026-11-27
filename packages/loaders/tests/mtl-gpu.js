// Browser side of mtl-gpu-check.mjs: loadOBJ reads fixtures/mtl-gpu/quad.obj, its quad.mtl and the 2 x 2 checker.png
// that `map_Kd` names, and draws the textured quad on a 128 x 128 canvas through an orthographic camera.
import { Engine } from '../../core/dist/extension.js';
import { loadOBJ } from '../dist/mtl.js';

const errors = [],
  engine = await Engine.create(document.getElementById('a'), { camera: { position: [0, 0, 3], target: [0, 0, 0] } });
engine.stop();
// Orthographic: x and y pass through, so the quad's -1..1 square is the whole canvas.
engine.camera.project = (out) => {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

let shown;
async function draw(name = 'quad', cubed = false) {
  shown?.dispose();
  const loaded = await loadOBJ(engine, new URL(`./fixtures/mtl-gpu/${name}.obj`, import.meta.url)),
    set = loaded.materials.materials;
  shown = loaded;
  // The second material's cube reflection, drawn on the same quad.
  if (cubed) set.get('checker').envMap = set.get('cubed').envMap;
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  return { warnings: loaded.warnings, materials: loaded.materials.materials.size ?? loaded.materials.materials.length };
}
window.check = { draw, errors };
window.ready = true;
