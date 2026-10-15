import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import {DracoDecoder} from '@margoengine/decoders';
import {Animation} from '@margoengine/animation';
import {OrbitControls} from '@margoengine/controls';
import {ColorBackground, Environment, EnvironmentLighting} from '@margoengine/environment';
import {Stats} from '@margoengine/stats';
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';
import {engineRuntime} from '@margoengine/core/extension';
import {submitPrincipalScene} from '../packages/shared/demo-frame.js';
import {studioCube} from './tokyo-studio.js';
applyQualityTier();

const status = document.querySelector<HTMLElement>('#status')!, error = document.querySelector<HTMLElement>('#error')!;
const abort = new AbortController();
let dispose: (() => void) | undefined;
addEventListener('pagehide', () => {abort.abort(); dispose?.();}, {once: true});

try {
  const stage = await createStage('#viewport', {backend: 'webgpu', autoStart: false, controls: false, capacity: 4096,
    label: 'Animated Tokyo street corner diorama', camera: {position: [-6, 5, 8], target: [0, 1, 0], near: 0.05, far: 200},
    onError: reason => {error.textContent = String(reason);}});
  dispose = () => stage.dispose();
  if (abort.signal.aborted) {stage.dispose(); abort.signal.throwIfAborted();}
  paceEngine(stage.engine);
  ColorBackground.attach(stage.engine, {color: '#bfe3dd'});

  const draco = new DracoDecoder({workerLimit: 2});
  let model;
  try {
    model = await loadGLTF(stage.engine, new URL('./assets/tokyo-diorama.glb', import.meta.url), {signal: abort.signal, decoders: {draco}});
  } finally {
    draco.dispose();
  }

  const environment = await Environment.attach(stage.engine, studioCube(64));
  EnvironmentLighting.attach(stage.engine, environment).add(model);
  const runtime = engineRuntime(stage.engine);
  runtime.lighting.direction.set([-3, 8, 5, 4]);
  runtime.lighting.radiance.set([1, 0.95, 0.88, 0.25]);
  Stats.attach(stage.engine);

  const controls = OrbitControls.attach(stage.engine);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotateSpeed = 0.6;
  stage.canvas.tabIndex = 0;
  stage.canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === '+' || event.key === '-') stage.canvas.dispatchEvent(new WheelEvent('wheel', {deltaY: event.key === '+' ? -100 : 100, cancelable: true}));
    else {controls.rotateLeft(event.key === 'ArrowLeft' ? 0.1 : event.key === 'ArrowRight' ? -0.1 : 0); controls.rotateUp(event.key === 'ArrowUp' ? 0.1 : event.key === 'ArrowDown' ? -0.1 : 0);}
  });
  const b = model.bounds;
  stage.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], {aspect: stage.canvas.clientWidth / stage.canvas.clientHeight, duration: 0});
  controls.saveState();

  const animation = Animation.attach(model);
  animation.play('Diorama');
  const pause = document.querySelector<HTMLButtonElement>('#pause')!, rotate = document.querySelector<HTMLInputElement>('#auto-rotate')!;
  const speed = document.querySelector<HTMLInputElement>('#speed')!, speedValue = document.querySelector<HTMLOutputElement>('#speed-value')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset-view')!;
  const sync = () => {
    pause.textContent = animation.playing ? 'Pause animation' : 'Resume animation';
    pause.setAttribute('aria-pressed', String(!animation.playing));
    rotate.checked = controls.autoRotate;
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => {animation.playing = !reduced.matches; controls.autoRotate = !reduced.matches; sync();};
  motion();
  reduced.addEventListener('change', motion);
  stage.use({name: 'tokyo-motion', setup() {}, dispose: () => reduced.removeEventListener('change', motion)});
  pause.addEventListener('click', () => {animation.playing = !animation.playing; sync();});
  rotate.addEventListener('change', () => {controls.autoRotate = rotate.checked;});
  speed.addEventListener('input', () => {animation.options.speed = speed.valueAsNumber; speedValue.value = speed.value + '×';});
  reset.addEventListener('click', () => controls.reset());
  for (const control of [pause, rotate, speed, reset]) control.disabled = false;

  Object.assign(window, {tokyoDemo: {stage, model, animation, controls}});
  await submitPrincipalScene(() => stage.engine.render(), runtime.gpu!.queue, {signal: abort.signal});
  stage.engine.start();
  watchQuality();
  document.querySelector<HTMLElement>('#viewport')!.dataset.ready = 'true';
  status.textContent = 'Ready';
} catch (reason) {
  dispose?.();
  if (!abort.signal.aborted) {status.textContent = 'Unable to load scene'; error.textContent = String(reason);}
}
