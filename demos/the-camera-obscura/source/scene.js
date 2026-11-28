import { Engine } from '@margoengine/core';
import { Clustered } from '@margoengine/clustered';
import { Shadows } from '@margoengine/shadows';
import { createCamera } from './model.js';
import { relativeExposure } from './optics.js';
import { lerp as mix } from '@margoengine/math/mathutils';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const range = document.querySelector('#distance');
const distanceOutput = document.querySelector('#distance-output');
const exposure = document.querySelector('#exposure');
const rays = document.querySelector('#rays');
const view = document.querySelector('#view');
const controls = [range, rays, view];
const lifetime = new AbortController();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const overall = { target: [-.002, .165, .078], offset: [1.135, .78, 1.33], fitAspect: 1.23 };
const plateView = { target: [.300, .247, .014], offset: [.83, .38, .45], fitAspect: .93 };
let millimeters = Number(range.value);
let engine, camera, observer, frame, last = 0;
let zoom = 0, detail = false, showRays = false, opticalDirty = true, pending = false;

function resize() {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * 1.5));
  const height = Math.max(1, Math.round(bounds.height * 1.5));
  if (canvas.width === width && canvas.height === height) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return true;
}

function readout() {
  range.setAttribute('aria-valuetext', millimeters + ' millimeters');
  distanceOutput.value = millimeters + ' mm';
  exposure.value = Math.round(100 * relativeExposure(millimeters / 1000)) + '%';
  rays.setAttribute('aria-pressed', String(showRays));
  rays.textContent = showRays ? 'Hide ray paths' : 'Show ray paths';
  view.setAttribute('aria-pressed', String(detail));
  view.textContent = detail ? 'Whole camera' : 'View the plate';
}

function paint(now) {
  frame = undefined;
  const delta = last ? Math.min(.06, (now - last) / 1000) : 1 / 60;
  last = now;
  const distance = millimeters / 1000;
  const target = Number(detail);
  zoom = reducedMotion.matches || Math.abs(zoom - target) < .001 ? target : mix(target, zoom, Math.exp(-delta * 16));
  const fit = Math.max(1, mix(overall.fitAspect, plateView.fitAspect, zoom) * canvas.height / canvas.width);
  const focus = overall.target.map((value, i) => mix(value, i === 0 ? distance : plateView.target[i], zoom));
  engine.camera.target = focus;
  engine.camera.position = focus.map((value, i) => value + fit * mix(overall.offset[i], plateView.offset[i], zoom));
  if (opticalDirty) {
    camera.update(distance, showRays);
    opticalDirty = false;
  }
  engine.render({ delta });
  Object.assign(document.body.dataset, { distance: millimeters, exposure: relativeExposure(distance).toFixed(6),
    rays: String(showRays), view: zoom === 1 ? 'plate' : zoom === 0 ? 'overview' : 'moving' });
  if (pending) {
    performance.mark('margo-distance-applied');
    pending = false;
  }
  if (zoom !== target) schedule();
  else last = 0;
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame((now) => { try { paint(now); } catch (error) { fail(error); } });
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
  loading.textContent = 'The camera could not open on this browser.';
  console.error(error);
  clean();
}

async function start() {
  resize();
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, capacity: 256, signal: lifetime.signal, startupTimeout: 10000,
    camera: { fov: 37, near: .105, far: 30 },
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
  engine.scene.background = '#575363';
  engine.lighting.direction.set([.98, 1.63, .48, 3.65]);
  engine.lighting.radiance.set([1, .92, .77, .43]);
  engine.lighting.ambient.set([.82, .94, 1]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .071, blockerSamples: 8, samples: 16, jitter: false,
    bounds: { min: [-1.10, -.21, -.71], max: [.91, .70, .67] },
  });
  const lights = Clustered.attach(engine, { tiles: [6, 5, 8], maxLights: 4 });
  lights.setLights([{ position: [-.432,.307,.073], range: .43, intensity: .110, radius: .066,
    color: [.68,.94,1], direction: [-1,0,0], angle: 1.17, penumbra: .55 }]);
  camera = createCamera(engine, shadows);
  Object.assign(document.body.dataset, { renderer: compatibility ? 'compatibility' : 'webgpu', meshes: camera.meshes });
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const options = { signal: lifetime.signal };
  range.addEventListener('input', () => {
    millimeters = Number(range.value);
    pending = true;
    opticalDirty = true;
    readout();
    schedule();
  }, options);
  rays.addEventListener('click', () => { showRays = !showRays; opticalDirty = true; readout(); schedule(); }, options);
  view.addEventListener('click', () => { detail = !detail; readout(); schedule(); }, options);
  reducedMotion.addEventListener('change', schedule, options);
  addEventListener('pagehide', (event) => { if (!event.persisted) clean(); }, options);
  observer = new ResizeObserver(() => { if (resize()) schedule(); });
  observer.observe(canvas);
  readout();
  for (const control of controls) control.disabled = false;
  loading.hidden = true;
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);
