// Tokyo corner: the diorama is one Draco-compressed glTF (examples/assets/tokyo-diorama.glb) built in Blender by
// examples/assets/source/tokyo_diorama/build.py (`npm run build:tokyo`), with a single 12 s keyframed clip.
import { createStage } from 'margoengine';
import { loadGLTF } from '@margoengine/gltf-pro'; // GLTFLoader
import { DracoDecoder } from '@margoengine/decoders'; // DRACOLoader
import { Animation } from '@margoengine/animation'; // AnimationMixer
import { OrbitControls } from '@margoengine/controls'; // OrbitControls
import { ColorBackground, Environment, EnvironmentLighting } from '@margoengine/environment'; // PMREMGenerator + scene.background
import { Stats } from '@margoengine/stats'; // Stats
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import { applyQualityTier, paceEngine, watchQuality } from '@margoengine/quality';
import { engineRuntime } from '@margoengine/core/extension';
import { submitPrincipalScene } from '../packages/shared/demo-frame.js';
import { studioCube } from './tokyo-studio.js'; // RoomEnvironment stand-in
applyQualityTier();

const status = document.querySelector('#status'),
  error = document.querySelector('#error');
const abort = new AbortController();
let dispose;
addEventListener(
  'pagehide',
  () => {
    abort.abort();
    dispose?.();
  },
  { once: true },
);

try {
  const stage = await createStage('#viewport', {
    backend: 'webgpu',
    autoStart: false,
    controls: false,
    capacity: 4096,
    label: 'Animated Tokyo street corner diorama',
    camera: { position: [-6, 5, 8], target: [0, 1, 0], near: 0.05, far: 200 },
    onError: (reason) => {
      error.textContent = String(reason);
    },
  });
  dispose = () => stage.dispose();
  if (abort.signal.aborted) {
    stage.dispose();
    abort.signal.throwIfAborted();
  }
  paceEngine(stage.engine);
  ColorBackground.attach(stage.engine, { color: '#bfe3dd' });

  // Load the diorama; Draco geometry decodes in worker threads.
  const draco = new DracoDecoder({ workerLimit: 2 });
  let model;
  try {
    model = await loadGLTF(stage.engine, new URL('./assets/tokyo-diorama.glb', import.meta.url), {
      signal: abort.signal,
      decoders: { draco },
    });
  } finally {
    draco.dispose();
  }

  // Lighting: a procedural studio cube for image-based light, a warm key light, soft shadows and ACES tone mapping.
  const environment = await Environment.attach(stage.engine, studioCube(64), { intensity: 0.7 });
  EnvironmentLighting.attach(stage.engine, environment).add(model);
  const runtime = engineRuntime(stage.engine);
  runtime.lighting.direction.set([-3, 8, 5, 4]);
  runtime.lighting.radiance.set([1.25, 1.12, 0.95, 0.2]);
  Tonemap.attach(stage.engine, { curve: 'acescg', exposure: 0.15, contrast: 1.12 });
  const span = Math.max(model.bounds[3] - model.bounds[0], model.bounds[5] - model.bounds[2]);
  Shadows.attach(stage.engine, {
    resolution: 1024,
    distance: span * 2,
    casterMargin: span,
    lightSize: 0.05,
    normalBias: 0.01,
  }).add(model);
  Stats.attach(stage.engine, { profiling: new URLSearchParams(location.search).has('profile') }); // ?profile shows GPU time

  // Camera and controls.
  const controls = OrbitControls.attach(stage.engine);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotateSpeed = 0.6;
  stage.canvas.tabIndex = 0;
  stage.canvas.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === '+' || event.key === '-')
      stage.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: event.key === '+' ? -100 : 100, cancelable: true }));
    else {
      controls.rotateLeft(event.key === 'ArrowLeft' ? 0.1 : event.key === 'ArrowRight' ? -0.1 : 0);
      controls.rotateUp(event.key === 'ArrowUp' ? 0.1 : event.key === 'ArrowDown' ? -0.1 : 0);
    }
  });
  const b = model.bounds;
  stage.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], {
    aspect: stage.canvas.clientWidth / stage.canvas.clientHeight,
    duration: 0,
  });
  controls.saveState();

  // Play the clip; the panel pauses it, changes its speed, toggles auto-rotate and resets the view.
  const animation = Animation.attach(model);
  animation.play('Diorama');
  const pause = /** @type {HTMLButtonElement} */ (document.querySelector('#pause')),
    rotate = /** @type {HTMLInputElement} */ (document.querySelector('#auto-rotate'));
  const speed = /** @type {HTMLInputElement} */ (document.querySelector('#speed')),
    speedValue = /** @type {HTMLOutputElement} */ (document.querySelector('#speed-value'));
  const reset = /** @type {HTMLButtonElement} */ (document.querySelector('#reset-view'));
  const sync = () => {
    pause.textContent = animation.playing ? 'Pause animation' : 'Resume animation';
    pause.setAttribute('aria-pressed', String(!animation.playing));
    rotate.checked = controls.autoRotate;
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => {
    animation.playing = !reduced.matches;
    controls.autoRotate = !reduced.matches;
    sync();
  };
  motion();
  reduced.addEventListener('change', motion);
  stage.use({ name: 'tokyo-motion', setup() {}, dispose: () => reduced.removeEventListener('change', motion) });
  pause.addEventListener('click', () => {
    animation.playing = !animation.playing;
    sync();
  });
  rotate.addEventListener('change', () => {
    controls.autoRotate = rotate.checked;
  });
  speed.addEventListener('input', () => {
    animation.options.speed = speed.valueAsNumber;
    speedValue.value = speed.value + '×';
  });
  reset.addEventListener('click', () => controls.reset());
  for (const control of [pause, rotate, speed, reset]) control.disabled = false;

  Object.assign(window, { tokyoDemo: { stage, model, animation, controls } });
  await submitPrincipalScene(() => stage.engine.render(), runtime.gpu.queue, { signal: abort.signal });
  stage.engine.start();
  watchQuality();
  /** @type {HTMLElement} */ (document.querySelector('#viewport')).dataset.ready = 'true';
  status.textContent = 'Ready';
} catch (reason) {
  dispose?.();
  if (!abort.signal.aborted) {
    status.textContent = 'Unable to load scene';
    error.textContent = String(reason);
  }
}
