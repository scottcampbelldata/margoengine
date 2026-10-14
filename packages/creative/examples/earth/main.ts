import {createStage, type Stage} from 'margoengine';
import {Planet} from '@margoengine/creative/planet';
import {OrbitControls} from '@margoengine/controls';
import {Bloom} from '@margoengine/post/bloom';
import {submitPrincipalScene} from '@margoengine/post/scene-fade';
import {engineRuntime} from '@margoengine/core/extension';
import {sceneSamples} from '../../../shared/quality.js';
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';
applyQualityTier();
import {Stars} from '@margoengine/creative/stars';

const controls = document.querySelector<HTMLFieldSetElement>('#controls')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const rotation = document.querySelector<HTMLInputElement>('#rotation')!;
const sun = document.querySelector<HTMLInputElement>('#sun')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const errorOutput = document.querySelector<HTMLParagraphElement>('#error')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let paused = reducedMotion.matches;
let speed = 1;
let cloudSpeed = 1;
let stage: Stage | undefined;
let leaving = false;
const events = new AbortController(), signal = events.signal;

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
window.addEventListener('pagehide', () => {leaving = true; events.abort(); stage?.dispose();}, {once: true});
if (import.meta.hot) import.meta.hot.dispose(() => {leaving = true; events.abort(); stage?.dispose();});

try {
  stage = await createStage('#viewport', {
    backend: 'webgpu', controls: false, autoStart: false,
    label: 'Earth with day and night lighting, drifting clouds, and stars',
    camera: {position: [0, 0.6, 3.8], target: [0, 0, 0], fov: 45, near: 0.05, far: 100},
    onError: fail,
  });
  if (leaving) {stage.dispose(); throw new DOMException('Page closed', 'AbortError');}
  paceEngine(stage.engine);
  const post = Bloom.attach(stage.engine, {strength: 0.25, threshold: 1, exposure: 0.6});
  const mobile = sceneSamples() === 1;
  const earth = await Planet.attach(stage.engine, {
    signal,
    radius: 1, tilt: 23.4,
    dayMap: new URL('./assets/earth-day-mobile.webp', import.meta.url),
    nightMap: new URL('./assets/earth-night-mobile.webp', import.meta.url),
    specularRoughnessMap: new URL('./assets/earth-specular-mobile.webp', import.meta.url),
    normalMap: new URL('./assets/earth-normal-mobile.webp', import.meta.url),
    clouds: new URL('./assets/earth-clouds-mobile.webp', import.meta.url),
    atmosphere: {color: [0.3, 0.6, 1.0], intensity: 1.2},
  });
  const stars = Stars.attach(stage.engine);
  const navigation = OrbitControls.attach(stage.engine);
  navigation.enableDamping = !reducedMotion.matches; navigation.enablePan = false;
  navigation.minDistance = 1.15; navigation.maxDistance = 12; navigation.saveState();
  stage.use({name: 'earth-demo:events', setup() {}, dispose: () => events.abort()});
  stage.canvas.tabIndex = 0;
  stage.canvas.setAttribute('aria-describedby', 'navigation-help');

  const reset = (): void => {
    stage!.engine.camera.cancelFit();
    navigation.reset();
  };
  const updateSun = (): void => {
    const angle = sun.valueAsNumber * Math.PI / 180;
    earth.setSunDirection([Math.sin(angle), 0.2, Math.cos(angle)]);
    document.querySelector<HTMLOutputElement>('#sun-value')!.value = `${sun.value}°`;
  };
  pause.addEventListener('click', () => {paused = !paused; updatePause();}, {signal});
  reducedMotion.addEventListener('change', () => {paused = reducedMotion.matches; navigation.enableDamping = !paused; updatePause();}, {signal});
  document.querySelector('#reset')!.addEventListener('click', reset, {signal});
  rotation.addEventListener('input', () => {
    speed = rotation.valueAsNumber;
    document.querySelector<HTMLOutputElement>('#rotation-value')!.value = `${speed.toFixed(1)}×`;
  }, {signal});
  sun.addEventListener('input', updateSun, {signal});
  for (const [id, change] of [
    ['cloud-speed', (value: number) => {cloudSpeed = value;}],
    ['bloom', (value: number) => {post.options.strength = value;}],
    ['exposure', (value: number) => {post.options.exposure = value;}],
  ] as const) {
    const input = document.querySelector<HTMLInputElement>('#'+id)!, output = document.querySelector<HTMLOutputElement>('#'+id+'-value')!;
    input.addEventListener('input', () => {change(input.valueAsNumber); output.value = id === 'cloud-speed' ? `${input.valueAsNumber.toFixed(1)}×` : input.value;}, {signal});
  }
  document.querySelector<HTMLInputElement>('#stars')!.addEventListener('change', event => {stars.enabled = (event.target as HTMLInputElement).checked;}, {signal});
  document.querySelector<HTMLElement>('#quality')!.textContent = sceneSamples() === 4 ? 'Desktop · 4× MSAA · HDR / AgX' : 'Light · 1× MSAA · HDR / AgX';
  document.querySelector<HTMLDetailsElement>('#settings')!.open = !matchMedia('(max-width:760px)').matches;
  stage.canvas.addEventListener('keydown', event => {
    switch (event.key) {
      case 'ArrowLeft': navigation.rotateLeft(0.08); break;
      case 'ArrowRight': navigation.rotateLeft(-0.08); break;
      case 'ArrowUp': navigation.rotateUp(0.08); break;
      case 'ArrowDown': navigation.rotateUp(-0.08); break;
      case '+': case '=': navigation.dollyIn(0.9); break;
      case '-': navigation.dollyOut(0.9); break;
      case 'Home': reset(); break;
      default: return;
    }
    event.preventDefault();
  }, {signal});
  updateSun();
  stage.onTick(delta => {
    if (paused) return;
    earth.rotation.y += 0.05 * speed * delta;
    earth.clouds.offsetU += 0.01 * cloudSpeed * delta;
  });
  const readiness = await submitPrincipalScene(() => stage!.engine.render(), engineRuntime(stage.engine).gpu!.queue, {signal});
  const demo = {stage, earth, post, stars, readiness, quality: mobile ? 'mobile' : 'preview'};
  Object.assign(window, {earthDemo: demo});
  controls.disabled = false;
  status.textContent = mobile ? 'Ready. Explore the day–night boundary with the sun control.' : 'Ready. Full detail is loading.';
  document.body.dataset.ready = 'true';
  stage.engine.start(); watchQuality();
  if (!mobile) void earth.updateMaps({
    signal,
    dayMap: new URL('./assets/earth-day.jpg', import.meta.url),
    nightMap: new URL('./assets/earth-night.webp', import.meta.url),
    specularRoughnessMap: new URL('./assets/earth-specular.webp', import.meta.url),
    normalMap: new URL('./assets/earth-normal.webp', import.meta.url),
    clouds: new URL('./assets/earth-clouds.webp', import.meta.url),
  }).then(() => {
    if (signal.aborted) return;
    demo.quality = 'full'; status.textContent = 'Ready. Explore the day–night boundary with the sun control.';
  }, error => {
    if (signal.aborted) return;
    status.textContent = 'Ready. Full detail could not load.';
    errorOutput.textContent = error instanceof Error ? error.message : String(error); errorOutput.hidden = false;
  });
} catch (error) {
  try {stage?.dispose();} catch {}
  if (!leaving) fail(error);
}
