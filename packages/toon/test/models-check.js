// Browser side of models-check.mjs: Fox.glb (a skinned glTF character, Khronos sample) posed by Animation's compute
// deformer, drawn with and without ModelOutlines.
import { Engine } from '../../core/dist/index.js';
import { loadGLTF } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { boxGeometry } from '../../geometry/dist/index.js';
import { ModelOutlines } from '../dist/models.js';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
engine.camera.position = [110, 50, 60];
engine.camera.target = [0, 35, 0];
engine.camera.far = 1000;
const model = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb'),
  animation = Animation.attach(model);
animation.playing = false;
let outlines;
// Frames until every pipeline (the deformer's, the model's, the hull's) is in place; the last is drawn with them all.
const settle = () =>
  waitForPipelines(async () => {
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
  });
// box: a hard-edged box (24 vertices, face normals), seen across a corner; width 0 draws it without outlines.
let box;
const show = (shown) => {
  model.root.visible = shown === model;
  if (box) box.root.visible = shown === box;
  engine.camera.position = shown === model ? [110, 50, 60] : [4, 3, 5];
  engine.camera.target = shown === model ? [0, 35, 0] : [0, 0, 0];
};
const outline = (width, smooth) => {
  if (width && !outlines) outlines = ModelOutlines.attach(engine, { outline: width, color: [0, 1, 0] });
  if (!width && outlines) {
    outlines.dispose();
    outlines = undefined;
  }
  if (outlines) outlines.smooth = smooth;
};
window.check = {
  async box(width, smooth) {
    engine.gpu.pushErrorScope('validation');
    box ??= createMesh(engine, boxGeometry(2, 2, 2), new Material({ color: '#ffffff' }));
    show(box);
    outline(width, smooth);
    await settle();
    const error = await engine.gpu.popErrorScope();
    if (error) errors.push(error.message);
    return { errors: errors.splice(0) };
  },
  // share: where in the clip; width: outline in world units (0: no ModelOutlines attached).
  async run(share, width, smooth = true) {
    engine.gpu.pushErrorScope('validation');
    show(model);
    animation.seek(animation.clips[0].duration * share);
    outline(width, smooth);
    await settle();
    const error = await engine.gpu.popErrorScope();
    if (error) errors.push(error.message);
    return { errors: errors.splice(0) };
  },
};
window.ready = true;
