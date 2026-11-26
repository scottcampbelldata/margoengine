// Babylon.js, in words: make an Engine on a canvas, make a Scene, add an ArcRotateCamera (alpha, beta, radius, target)
// and attach its controls to the canvas, add a HemisphericLight, put a sphere and a ground in the scene, start
// engine.runRenderLoop, and call engine.resize() from a window resize listener.
//
// Margo: createStage mounts the canvas, makes the engine, camera and orbit controls, and starts the loop. Resize and
// pixel ratio are handled for you. The camera is a position and a target, in metres (Y up, right-handed).
import { createStage } from 'margoengine';
import { fail, status } from './common';

const stage = await createStage('#scene', {
  background: '#cfe3f2', // scene.clearColor
  camera: { position: [4, 3, 6], target: [0, 0.5, 0], fov: 50 }, // fov in degrees, not radians as in Babylon
}).catch(fail);
const engine = stage.engine;

stage.box({ size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d8d8cf' }); // MeshBuilder.CreateGround
const ball = stage.sphere({ radius: 0.5, position: [0, 0.5, 0], color: '#84d6bd', roughness: 0.3 }); // MeshBuilder.CreateSphere

// engine.scene.lighting is the one sun plus ambient light (Babylon: a DirectionalLight and a HemisphericLight).
engine.scene.lighting.direction.set([-3, 5, 2, 3]); // x, y, z point TOWARD the light; the last number is its strength

// scene.onBeforeRenderObservable: the delta is in seconds (Babylon's getDeltaTime() is in milliseconds).
let time = 0;
stage.onTick((delta) => {
  time += delta;
  ball.position.y = 0.5 + Math.abs(Math.sin(time * 3)) * 0.8; // a bouncing ball
});
status.textContent = `Scene ready on ${engine.backend}. Drag to orbit, scroll to zoom.`;
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
