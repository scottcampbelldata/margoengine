// Babylon.js, in words: scene.pick(scene.pointerX, scene.pointerY) (or scene.onPointerObservable with a POINTERPICK
// type) returns a PickingInfo with hit, pickedMesh and pickedPoint; a HighlightLayer adds a glowing outline to the
// picked mesh; scene.pickWithRay and Ray.intersectsMesh cover rays that do not start at the pointer.
//
// Margo: `Picking` reads what the GPU drew under a pixel, and answers asynchronously. `Selection` draws the outline.
// The pixel is the canvas's CSS pixel, which `event.offsetX` and `offsetY` give. Rays against triangles on the CPU are
// `Raycaster` from `@margoengine/bvh`.
import { createStage } from 'margoengine';
import { Picking, Selection } from 'margoengine/selection';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [4, 5, 7], target: [0, 0.4, 0] } }).catch(fail);
const engine = stage.engine;
stage.box({ size: [12, 0.1, 12], position: [0, -0.05, 0], color: '#cfcfc8', name: 'floor' });
for (const x of [-2, -1, 0, 1, 2])
  stage.box({ size: [0.7, 0.7, 0.7], position: [x * 1.3, 0.35, (x % 2) * 1.2], color: '#84d6bd', name: `cube ${x + 3}` });

const picking = Picking.attach(engine); // like scene.pick, but asynchronous
const outline = Selection.attach(engine, { color: [1, 0.6, 0] }); // like HighlightLayer

let pressedAt = [0, 0];
let busy = false; // one pick can wait at a time
engine.canvas.addEventListener('pointerdown', (event) => {
  pressedAt = [event.clientX, event.clientY];
});
engine.canvas.addEventListener('pointerup', async (event) => {
  // The end of an orbit drag is also a pointerup; ignore it, as Babylon's POINTERPICK ignores drags.
  if (busy || Math.hypot(event.clientX - pressedAt[0], event.clientY - pressedAt[1]) > 4) return;
  busy = true;
  const hit = await picking.pick(event.offsetX, event.offsetY); // null where nothing was drawn
  busy = false;
  const picked = hit && hit.mesh.name !== 'floor' ? hit.mesh : null;
  outline.set(picked ? [picked] : []);
  status.textContent = picked ? `Picked ${picked.name}.` : 'Click a cube.';
});
status.textContent = 'Click a cube.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
