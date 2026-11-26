// Babylon.js, in words: an ArcRotateCamera with attachControl(canvas, true), lowerRadiusLimit and upperRadiusLimit,
// upperBetaLimit, wheelPrecision and panningSensibility; a UniversalCamera or FreeCamera with WASD keys through
// camera.keysUp / keysLeft; scene.onKeyboardObservable (or an ActionManager with ExecuteCodeAction) for game keys.
//
// Margo: `OrbitControls` is the ArcRotateCamera: it listens on the canvas and updates before every frame, with limits
// as plain fields. Game keys are `Input` actions: name an action once, bind keys, mouse buttons, gamepad or touch to it,
// then read `input.state(name).value` after `input.update()` each frame. `FlyControls` and `WalkControls` are the
// FreeCamera family (see docs/from-babylon.md).
import { createStage } from 'margoengine';
import { OrbitControls } from 'margoengine/controls';
import { Input } from 'margoengine/input';
import { fail, status } from './common';

const stage = await createStage('#scene', {
  controls: false, // we attach our own controls below; the stage's default controls are CAD-style
  camera: { position: [5, 4, 7], target: [0, 0.5, 0], fov: 50 },
}).catch(fail);
const engine = stage.engine;
stage.box({ size: [12, 0.1, 12], position: [0, -0.05, 0], color: '#cfcfc8' });
const player = stage.box({ size: [0.6, 0.6, 0.6], position: [0, 0.3, 0], color: '#d9824c' });

// ArcRotateCamera: attachControl, lowerRadiusLimit, upperRadiusLimit, upperBetaLimit, useInputToZoomToCursor.
const orbit = OrbitControls.attach(engine);
orbit.enableDamping = true; // inertia
orbit.minDistance = 3; // lowerRadiusLimit
orbit.maxDistance = 20; // upperRadiusLimit
orbit.maxPolarAngle = Math.PI / 2 - 0.05; // upperBetaLimit: stay above the floor
orbit.zoomToCursor = true;

// scene.onKeyboardObservable: actions with keyboard codes. Opposing bindings sum to -1..1.
const input = new Input({
  right: [{ type: 'key', code: 'KeyD' }, { type: 'key', code: 'ArrowRight' }],
  left: [{ type: 'key', code: 'KeyA' }, { type: 'key', code: 'ArrowLeft' }],
  forward: [{ type: 'key', code: 'KeyW' }, { type: 'key', code: 'ArrowUp' }],
  back: [{ type: 'key', code: 'KeyS' }, { type: 'key', code: 'ArrowDown' }],
});
stage.onTick((delta) => {
  input.update(); // once per frame
  const x = input.state('right').value - input.state('left').value;
  const z = input.state('back').value - input.state('forward').value;
  player.position.x += x * 3 * delta; // metres per second, scaled by the frame time
  player.position.z += z * 3 * delta;
});
status.textContent = 'Move the cube with WASD or the arrow keys; drag to orbit.';
window.addEventListener(
  'pagehide',
  () => {
    input.dispose();
    stage.dispose();
  },
  { once: true },
);
