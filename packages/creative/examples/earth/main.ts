import {CADCameraControls, createStage, type Stage} from 'margoengine';
import {Planet} from '../../src/index.js';
import {Stars} from './sky.js';

const controls = document.querySelector<HTMLFieldSetElement>('#controls')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const rotation = document.querySelector<HTMLInputElement>('#rotation')!;
const sun = document.querySelector<HTMLInputElement>('#sun')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const errorOutput = document.querySelector<HTMLParagraphElement>('#error')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let paused = reducedMotion.matches;
let speed = 1;
let stage: Stage | undefined;
let leaving = false;

function fail(error: unknown): void {
  errorOutput.textContent = error instanceof Error ? error.message : String(error);
  errorOutput.hidden = false;
  controls.disabled = true;
  status.textContent = 'The Earth view could not be rendered.';
  document.body.dataset.error = 'true';
}

function updatePause(): void {
  pause.textContent = paused ? 'Resume rotation' : 'Pause rotation';
  pause.setAttribute('aria-pressed', String(paused));
}
updatePause();
window.addEventListener('pagehide', () => {leaving = true; stage?.dispose();}, {once: true});

try {
  stage = await createStage('#viewport', {
    backend: 'webgpu', controls: false, autoStart: false,
    label: 'Earth with day and night lighting, drifting clouds, and stars',
    camera: {position: [0, 0.6, 3.8], target: [0, 0, 0], fov: 45, near: 0.05, far: 100},
    onError: fail,
  });
  if (leaving) {stage.dispose(); throw new DOMException('Page closed', 'AbortError');}
  const earth = await Planet.create(stage.engine, {
    radius: 1, tilt: 23.4,
    dayMap: new URL('./assets/earth-day.jpg', import.meta.url),
    nightMap: new URL('./assets/2k_earth_nightmap.jpg', import.meta.url),
    specularRoughnessMap: new URL('./assets/earth-specular-roughness.png', import.meta.url),
    normalMap: new URL('./assets/earth-normal.png', import.meta.url),
    clouds: new URL('./assets/2k_earth_clouds.jpg', import.meta.url),
    atmosphere: {color: [0.3, 0.6, 1.0], intensity: 1.2},
  });
  stage.use(new Stars());
  const navigation = new CADCameraControls(stage.engine.camera, stage.canvas);
  stage.use({name: 'earth-demo:navigation', setup() {}, onPreUpdate(delta) {
    navigation.update(delta);
    const camera = stage!.engine.camera, p = camera.position, distance = Math.hypot(p[0], p[1], p[2]);
    // Keep the near plane outside the cloud shell while zooming and panning.
    if (distance < 1.1) camera.position = distance ? [p[0] * 1.1 / distance, p[1] * 1.1 / distance, p[2] * 1.1 / distance] : [0, 0, 1.1];
  }, dispose: () => navigation.dispose()});
  stage.canvas.tabIndex = 0;
  stage.canvas.setAttribute('aria-describedby', 'navigation-help');

  const reset = (): void => {
    stage!.engine.camera.cancelFit();
    stage!.engine.camera.position = [0, 0.6, 3.8];
    stage!.engine.camera.target = [0, 0, 0];
    stage!.engine.camera.fov = 45;
  };
  const updateSun = (): void => {
    const angle = sun.valueAsNumber * Math.PI / 180;
    earth.setSunDirection([Math.sin(angle), 0.2, Math.cos(angle)]);
    document.querySelector<HTMLOutputElement>('#sun-value')!.value = `${sun.value}°`;
  };
  pause.addEventListener('click', () => {paused = !paused; updatePause();});
  document.querySelector('#reset')!.addEventListener('click', reset);
  rotation.addEventListener('input', () => {
    speed = rotation.valueAsNumber;
    document.querySelector<HTMLOutputElement>('#rotation-value')!.value = `${speed.toFixed(1)}×`;
  });
  sun.addEventListener('input', updateSun);
  stage.canvas.addEventListener('keydown', event => {
    switch (event.key) {
      case 'ArrowLeft': navigation.orbit(-0.08, 0); break;
      case 'ArrowRight': navigation.orbit(0.08, 0); break;
      case 'ArrowUp': navigation.orbit(0, -0.08); break;
      case 'ArrowDown': navigation.orbit(0, 0.08); break;
      case '+': case '=': stage!.engine.camera.fov = Math.max(20, stage!.engine.camera.fov - 3); break;
      case '-': stage!.engine.camera.fov = Math.min(80, stage!.engine.camera.fov + 3); break;
      case 'Home': reset(); break;
      default: return;
    }
    event.preventDefault();
  });
  updateSun();
  stage.onTick(delta => {
    if (paused) return;
    earth.rotation.y += 0.05 * speed * delta;
    earth.clouds.offsetU = (earth.clouds.offsetU + 0.01 * speed * delta) % 1;
  });
  controls.disabled = false;
  status.textContent = 'Ready. Explore the day–night boundary with the sun control.';
  document.body.dataset.ready = 'true';
  stage.engine.start();
} catch (error) {
  try {stage?.dispose();} catch {}
  if (!leaving) fail(error);
}
