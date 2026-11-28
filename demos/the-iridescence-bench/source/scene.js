import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createBench } from './model.js';
import { ShotBlend } from '@margoengine/cameras/shots';

const canvas = document.querySelector('#film');
const loading = document.querySelector('#loading');
const film = document.querySelector('#thickness');
const tilt = document.querySelector('#tilt');
const filmOutput = document.querySelector('#film-output');
const tiltOutput = document.querySelector('#tilt-output');
const view = document.querySelector('#view');
const presets = Array.from(document.querySelectorAll('[data-thickness]'));
const controls = [film, tilt, view, ...presets];
const lifetime = new AbortController();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const overview = { target: [-.003, .187, .069], offset: [.47, .69, 1.02], fit: 1.10 };
const closeUp = { target: [.016, .323, .017], offset: [.346, .44, .713], fit: 1.11 };
let thickness = Number(film.value), degrees = Number(tilt.value);
let engine, shots, bench, observer, frame, last = 0;
let detail = false, opticalDirty = true, pending = false;

function resize() {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * 1.5));
  const height = Math.max(1, Math.round(bounds.height * 1.5));
  if (canvas.width === width && canvas.height === height) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return true;
}

function status() {
  film.value = String(thickness);
  tilt.value = String(degrees);
  filmOutput.value = thickness + ' nm';
  tiltOutput.value = degrees + '°';
  film.setAttribute('aria-valuetext', thickness + ' nanometers');
  tilt.setAttribute('aria-valuetext', degrees + ' degrees');
  view.setAttribute('aria-pressed', String(detail));
  view.textContent = detail ? 'Whole bench' : 'Coating close-up';
  for (const preset of presets) preset.setAttribute('aria-pressed', String(Number(preset.dataset.thickness) === thickness));
}

function paint(now) {
  frame = undefined;
  const delta = last ? Math.min(.06, (now - last) / 1000) : 1 / 60;
  last = now;
  shots.goal = Number(detail);
  const moving = shots.update(delta, canvas.width, canvas.height);
  if (opticalDirty) {
    bench.update(thickness, degrees);
    opticalDirty = false;
  }
  engine.render({ delta });
  Object.assign(document.body.dataset, { thickness, tilt: degrees, view: moving ? 'moving' : detail ? 'detail' : 'overview' });
  if (pending) {
    performance.mark('margo-film-applied');
    pending = false;
  }
  if (moving) schedule();
  else last = 0;
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame((now) => { try { paint(now); } catch (error) { fail(error); } });
}

function adjust(nextThickness, nextTilt) {
  if (thickness === nextThickness && degrees === nextTilt) return;
  thickness = nextThickness;
  degrees = nextTilt;
  opticalDirty = true;
  pending = true;
  status();
  schedule();
}

function clean() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  document.body.dataset.state = 'error';
  for (const control of controls) control.disabled = true;
  loading.hidden = false;
  loading.textContent = 'The reflector could not open on this browser.';
  console.error(error);
  clean();
}

async function start() {
  resize();
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, capacity: 256, signal: lifetime.signal, startupTimeout: 10000,
    camera: { fov: 39, near: .095, far: 27 },
  });
  if (!forced) {
    try { engine = await open(); } catch (error) { if (error?.code !== 'unsupported') throw error; }
  }
  const compatibility = !engine;
  if (compatibility) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: lifetime.signal });
    engine = await open();
  }
  engine.onError = fail;
  shots = new ShotBlend(engine.camera, overview, closeUp, { rate: 16, still: reducedMotion });
  engine.scene.background = '#516067';
  engine.lighting.direction.set([0, 1, 0, 3.82]);
  engine.lighting.radiance.set([1, .99, .97, .49]);
  engine.lighting.ambient.set([.73, .90, 1]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .075, blockerSamples: 8, samples: 16, jitter: false,
    bounds: { min: [-.62, -.20, -.66], max: [.64, .70, .66] },
  });
  bench = createBench(engine, shadows);
  Object.assign(document.body.dataset, { renderer: compatibility ? 'compatibility' : 'webgpu', meshes: bench.count });
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const options = { signal: lifetime.signal };
  film.addEventListener('input', () => adjust(Number(film.value), degrees), options);
  tilt.addEventListener('input', () => adjust(thickness, Number(tilt.value)), options);
  for (const preset of presets) preset.addEventListener('click', () => adjust(Number(preset.dataset.thickness), degrees), options);
  view.addEventListener('click', () => { detail = !detail; status(); schedule(); }, options);
  reducedMotion.addEventListener('change', schedule, options);
  addEventListener('pagehide', (event) => { if (!event.persisted) clean(); }, options);
  observer = new ResizeObserver(() => { if (resize()) schedule(); });
  observer.observe(canvas);
  status();
  for (const control of controls) control.disabled = false;
  loading.hidden = true;
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);
