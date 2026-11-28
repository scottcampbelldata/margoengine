import { Engine } from '@margoengine/core';
import { Clustered } from '@margoengine/clustered';
import { Shadows } from '@margoengine/shadows';
import { createInstrument } from './model.js';
import { malus } from '@margoengine/optics/polarization';
import { ShotBlend } from '@margoengine/cameras/shots';

const transmissionAt = (degrees) => malus(degrees * Math.PI / 180);

const canvas = document.querySelector('#optics');
const loading = document.querySelector('#loading');
const range = document.querySelector('#angle');
const filter = document.querySelector('#filter');
const angleOutput = document.querySelector('#angle-output');
const result = document.querySelector('#result');
const meter = document.querySelector('#transmission');
const relative = document.querySelector('#relative');
const view = document.querySelector('#view');
const presets = Array.from(document.querySelectorAll('[data-angle]'));
const lifetime = new AbortController();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const overview = { target: [0, .150, .039], offset: [.492, .392, .929], fit: 1.10 };
const detail = { target: [.008, .241, .030], offset: [.448, .300, .585], fit: 1.02 };
const studio = [
  { position: [-.48, .61, -.57], range: 1.6, color: [.34, .66, 1], intensity: 1.8, radius: .12 },
  { position: [.29, .53, .42], range: 1.0, color: [1, .82, .63], intensity: .41, radius: .09 },
];
const detector = { position: [0, .263, .151], range: .39, color: [.39, .82, 1], intensity: .0015, radius: .041 };
let engine, shots, instrument, lights, observer, advance, last = 0;
const angles = { analyzer: Number(range.value), polarizer: 0 };
const separation = () => Math.abs(angles.analyzer - angles.polarizer);
let close = false, pending = false, opticalDirty = true;

function resize() {
  const frame = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(frame.width * 1.5));
  const height = Math.max(1, Math.round(frame.height * 1.5));
  if (canvas.width === width && canvas.height === height) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return true;
}

function status() {
  const difference = separation();
  const degrees = angles[filter.value];
  const transmission = transmissionAt(difference);
  const label = Math.round(transmission * 100) + '%';
  range.value = String(degrees);
  angleOutput.value = degrees + '°';
  range.setAttribute('aria-valuetext', filter.selectedOptions[0].text + ', ' + degrees + ' degrees');
  result.value = label;
  meter.value = transmission;
  meter.textContent = label;
  relative.textContent = difference + '° between filters.';
  for (const preset of presets) preset.setAttribute('aria-pressed', String(Number(preset.dataset.angle) === difference % 180));
  view.setAttribute('aria-pressed', String(close));
  view.textContent = close ? 'Whole instrument' : 'Optics close-up';
}

function paint(now) {
  advance = undefined;
  const delta = last ? Math.min(.06, (now - last) / 1000) : 1 / 60;
  last = now;
  shots.goal = Number(close);
  const moving = shots.update(delta, canvas.width, canvas.height);
  const brightness = transmissionAt(separation());
  if (opticalDirty) {
    instrument.update(angles, brightness, filter.value);
    lights.setLights([...studio, { ...detector, intensity: .021 * brightness }]);
    opticalDirty = false;
  }
  engine.render({ delta });
  Object.assign(document.body.dataset, {
    angle: angles[filter.value],
    analyzer: angles.analyzer,
    polarizer: angles.polarizer,
    separation: separation(),
    transmission: brightness.toFixed(6),
    view: moving ? 'moving' : close ? 'detail' : 'overview',
  });
  if (pending) {
    performance.mark('margo-angle-applied');
    pending = false;
  }
  if (moving) schedule();
  else last = 0;
}

function schedule() {
  if (advance === undefined && !lifetime.signal.aborted) {
    advance = requestAnimationFrame((now) => {
      try { paint(now); } catch (error) { fail(error); }
    });
  }
}

function turn(next) {
  if (angles[filter.value] === next) return;
  angles[filter.value] = next;
  opticalDirty = true;
  status();
  pending = true;
  schedule();
}

function clean() {
  lifetime.abort();
  observer?.disconnect();
  if (advance !== undefined) cancelAnimationFrame(advance);
  engine?.dispose();
}

function fail(error) {
  document.body.dataset.state = 'error';
  for (const control of [range, filter, view, ...presets]) control.disabled = true;
  loading.hidden = false;
  loading.textContent = 'The optics could not open on this browser.';
  console.error(error);
  clean();
}

async function start() {
  resize();
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, capacity: 256, signal: lifetime.signal, startupTimeout: 10000,
    camera: { fov: 38, near: .095, far: 52 },
  });
  if (!forced) {
    try { engine = await open(); } catch (error) { if (error?.code !== 'unsupported') throw error; }
  }
  const compatible = !engine;
  if (compatible) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: lifetime.signal });
    engine = await open();
  }
  engine.onError = fail;
  shots = new ShotBlend(engine.camera, overview, detail, { rate: 17, still: reducedMotion });
  engine.scene.background = '#4c5b62';
  engine.lighting.direction.set([-.67, 1.05, .53, 3.3]);
  engine.lighting.radiance.set([1, .90, .74, .36]);
  engine.lighting.ambient.set([.76, .88, 1]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .052, blockerSamples: 8, samples: 16, jitter: false,
    bounds: { min: [-.75, -.23, -.71], max: [.65, .61, .70] },
  });
  lights = Clustered.attach(engine, { tiles: [6, 5, 8], maxLights: 8 });
  instrument = createInstrument(engine, shadows);
  Object.assign(document.body.dataset, { renderer: compatible ? 'compatibility' : 'webgpu', meshes: instrument.count });
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const options = { signal: lifetime.signal };
  range.addEventListener('input', () => turn(Number(range.value)), options);
  filter.addEventListener('change', () => { opticalDirty = true; status(); schedule(); }, options);
  for (const button of presets) button.addEventListener('click', () => {
    const difference = Number(button.dataset.angle);
    const stationary = angles[filter.value === 'analyzer' ? 'polarizer' : 'analyzer'];
    turn(stationary + difference <= 180 ? stationary + difference : stationary - difference);
  }, options);
  view.addEventListener('click', () => { close = !close; status(); schedule(); }, options);
  reducedMotion.addEventListener('change', schedule, options);
  addEventListener('pagehide', (event) => { if (!event.persisted) clean(); }, options);
  observer = new ResizeObserver(() => { if (resize()) schedule(); });
  observer.observe(canvas);
  status();
  for (const control of [range, filter, view, ...presets]) control.disabled = false;
  loading.hidden = true;
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);
