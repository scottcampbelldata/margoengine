// PlayCanvas, in words: make a canvas, `new Application(canvas)`, set the canvas fill mode and resolution, call
// `app.start()`. Make an Entity, add a `camera` component (fov in degrees, clearColor, nearClip, farClip) and put it in
// `app.root`. Add a `light` component entity, then `render` component entities (box, sphere, plane). Per-frame work
// listens to `app.on('update', dt)`; `dt` is in seconds. The page's resize is handled with `app.resizeCanvas`.
//
// Margo: `createStage` mounts the canvas, makes the engine, camera and orbit controls, and starts the loop. Resize and
// pixel ratio are handled for you. The camera is a position and a target, in metres (Y up, right-handed).
import { createStage } from 'margoengine';
import { fail, status } from './common';

const stage = await createStage('#scene', {
  background: '#cfe3f2', // camera.clearColor
  camera: { position: [4, 3, 6], target: [0, 0.5, 0], fov: 50 }, // fov in degrees, as in PlayCanvas
}).catch(fail);
const engine = stage.engine;

stage.box({ size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d8d8cf' }); // a 'render' component, type 'box'
const ball = stage.sphere({ radius: 0.5, position: [0, 0.5, 0], color: '#84d6bd', roughness: 0.3 }); // type 'sphere'

// The light component of a directional light entity. Margo's sun is `engine.scene.lighting`: x, y, z point TOWARD the
// light (PlayCanvas shines along the entity's -Y axis), and the last number is its strength.
engine.scene.lighting.direction.set([-3, 5, 2, 3]);

// app.on('update', dt): dt is in seconds in both.
let time = 0;
stage.onTick((delta) => {
  time += delta;
  ball.position.y = 0.5 + Math.abs(Math.sin(time * 3)) * 0.8; // a bouncing ball
});
status.textContent = `Scene ready on ${engine.backend}. Drag to orbit, scroll to zoom.`;
window.addEventListener('pagehide', () => stage.dispose(), { once: true }); // app.destroy()
