import { Clustered } from '@margoengine/clustered';
import { openBench } from '@margoengine/studio/bench';
import { createBench, lampAxis, lampPosition } from './bench.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const angle = document.querySelector('#angle');
const value = document.querySelector('#angle-value');
const beam = document.querySelector('#open-beam');
const view = document.querySelector('#view');
const reset = document.querySelector('#reset');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const lifetime = new AbortController();
const initialAngle = Number(angle.defaultValue);
const controls = [angle, beam, view, reset];
// The wide shot stands back far enough that the gauge blocks at the front right stay inside the frame.
const wideShot = { target: [-.03, .40, -.01], offset: [.57, .89, 2.22], framedAspect: 1.99 };
const closeShot = { target: [.34, .43, -.205], offset: [.26, .35, 1.27], framedAspect: 1.26 };

let bench, engine, set, frame;
let last = 0, displayedAngle = initialAngle, displayedLift = 0, displayedView = 0;
let isOpen = false, isClose = false;
let apertureChanged = false;

function camera(t) {
  const blend = (a, b) => a + (b - a) * t;
  const aspect = canvas.width / canvas.height;
  const fit = Math.max(1, blend(wideShot.framedAspect, closeShot.framedAspect) / aspect);
  const target = wideShot.target.map((coordinate, index) => blend(coordinate, closeShot.target[index]));
  engine.camera.target = target;
  engine.camera.position = target.map((coordinate, index) =>
    coordinate + fit * blend(wideShot.offset[index], closeShot.offset[index]));
}

function draw(now) {
  frame = undefined;
  const targetAngle = Number(angle.value);
  const targetLift = Number(isOpen);
  const targetView = Number(isClose);
  const dt = last ? Math.min(.08, (now - last) / 1000) : 1 / 60;
  last = now;
  const smooth = reduced.matches ? 1 : 1 - Math.exp(-dt * 23);
  const ease = (current, target, epsilon) => Math.abs(target - current) < epsilon
    ? target : current + (target - current) * smooth;
  // The mask follows the slider directly. Only the swing and camera glide.
  displayedAngle = targetAngle;
  displayedLift = ease(displayedLift, targetLift, .0008);
  displayedView = ease(displayedView, targetView, .0008);
  set.setMask(displayedAngle * Math.PI / 180, displayedLift);
  camera(displayedView);
  engine.render({ delta: dt });
  document.body.dataset.renderedAngle = String(displayedAngle);
  document.body.dataset.renderedBeam = displayedLift === 1 ? 'open' : displayedLift === 0 ? 'masked' : 'moving';
  document.body.dataset.renderedView = displayedView === 1 ? 'close' : displayedView === 0 ? 'bench' : 'moving';
  if (apertureChanged) {
    apertureChanged = false;
    performance.mark('margo-aperture-applied');
  }
  if (displayedLift !== targetLift || displayedView !== targetView) schedule();
}

function schedule() {
  if (frame === undefined && !lifetime.signal.aborted) frame = requestAnimationFrame((now) => {
    try { draw(now); } catch (error) { fail(error); }
  });
}

function syncControls() {
  value.textContent = angle.value + '°';
  angle.setAttribute('aria-valuetext', angle.value + ' degrees');
  beam.setAttribute('aria-pressed', String(isOpen));
  beam.textContent = isOpen ? 'Insert mask' : 'Open beam';
  view.setAttribute('aria-pressed', String(isClose));
  view.textContent = isClose ? 'Whole bench' : 'Close-up';
}

function fail(error) {
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The light bench could not open on this browser.';
  for (const control of controls) control.disabled = true;
  console.error(error);
  lifetime.abort();
  if (frame !== undefined) cancelAnimationFrame(frame);
}

async function start() {
  bench = await openBench(canvas, {
    exhibit: document.body, signal: lifetime.signal, pixelRatio: 1.5, capacity: 160, startupTimeout: 10000,
    camera: { fov: 33, near: .2, far: 18 }, background: '#1b2528', backdrop: false, contact: false, shadows: false,
    environment: { intensity: .3 }, light: { direction: [.23, .79, .55], intensity: 1.18, color: [.78, .88, 1], ambient: .19, ambientColor: [.75, .87, 1] },
    onError: fail, onResize: () => schedule(),
  });
  engine = bench.engine;
  // Cool key from the bench sun with the kit softbox fill at 0.3. Only the warm optical beam casts a dynamic shadow.
  const light = Clustered.attach(engine, { grid: [8, 6, 12], maxLights: 3, shadows: { maxLights: 1, resolution: 1024 } });
  light.setLights([
    {
      position: lampPosition,
      direction: lampAxis,
      range: 4.2,
      innerAngle: .465,
      outerAngle: .530,
      color: [1, .66, .39],
      intensity: 12.0,
      shadow: { near: .064, far: 3.2, bias: .00014, normalBias: .0012 },
    },
    { position: [-.83, 1.12, -.20], range: 2.5, color: [.91, .82, .68], intensity: .42 },
    { position: [.37, .90, 1.68], range: 3.5, color: [.62, .79, 1], intensity: 1.12 },
  ]);
  set = createBench(engine, light);
  document.body.dataset.meshCount = String(set.meshCount);
  const options = { signal: lifetime.signal };
  const update = () => { syncControls(); schedule(); };
  const applyAngle = () => {
    // Returning the mask to the gate makes the new setting visible immediately.
    isOpen = false;
    apertureChanged = true;
    update();
  };
  angle.addEventListener('input', applyAngle, options);
  beam.addEventListener('click', () => { isOpen = !isOpen; update(); }, options);
  view.addEventListener('click', () => { isClose = !isClose; update(); }, options);
  reset.addEventListener('click', () => {
    angle.value = String(initialAngle);
    isOpen = false;
    isClose = false;
    update();
  }, options);
  reduced.addEventListener('change', schedule, options);
  lifetime.signal.addEventListener('abort', () => { if (frame !== undefined) cancelAnimationFrame(frame); }, { once: true });

  draw(performance.now());
  if (!await bench.ready()) return;
  for (const control of controls) control.disabled = false;
  loading.hidden = true;
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);
