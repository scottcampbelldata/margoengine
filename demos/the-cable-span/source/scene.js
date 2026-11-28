import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createSpan } from './bridge.js';
import { span } from './equilibrium.js';

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const slider = document.getElementById('position');
const reference = document.getElementById('reference');
const view = document.getElementById('view');
const traceKey = document.getElementById('trace-key');
const [cart, drop, tension, west, east] = ['cart-readout', 'drop', 'tension', 'west', 'east']
  .map((id) => document.getElementById(id));
const controls = [slider, reference, view];
const stop = new AbortController();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let engine;
let exhibit;
let resize;
let pending;
let position = Number(slider.value);
let perspective = 0;
let requestedView = 0;
let interactiveFrame = false;
let comparison = false;

function size() {
  const ratio = Math.min(2, Math.max(1.25, devicePixelRatio));
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

function camera() {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const yaw = .48 - .45 * perspective;
  const pitch = .39 - .33 * perspective;
  const distance = Math.max(43, (33 + 1.4 * perspective) / aspect);
  const center = [.28 * (1 - perspective), -2.61 + 3.34 * perspective, 0];
  const ground = Math.cos(pitch) * distance;
  engine.camera.target = center;
  engine.camera.position = [
    center[0] + Math.sin(yaw) * ground,
    center[1] + Math.sin(pitch) * distance,
    center[2] + Math.cos(yaw) * ground,
  ];
}

function readouts() {
  const model = exhibit.model;
  cart.value = model.loadAt.toFixed(2) + ' m';
  slider.style.setProperty('--progress', (100 * model.loadAt / span) + '%');
  slider.setAttribute('aria-valuetext', model.loadAt.toFixed(2) + ' meters from the west tower');
  drop.value = Math.round(-model.deck(model.loadAt) * 100).toString();
  tension.value = model.peakTension.toFixed(1);
  west.value = (model.left * 2).toFixed(1);
  east.value = (model.right * 2).toFixed(1);
}

function draw() {
  camera();
  engine.render({ delta: 0 });
  if (interactiveFrame && performance.getEntriesByName('margo-first-input-applied').length === 0) {
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(() => {
      if (!stop.signal.aborted) performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  interactiveFrame = false;
}

function update() {
  pending = undefined;
  if (stop.signal.aborted) return;
  try {
    if (position !== exhibit.model.loadAt) {
      exhibit.update(position);
      readouts();
    }
    const difference = requestedView - perspective;
    if (reduceMotion.matches || Math.abs(difference) < .012) perspective = requestedView;
    else perspective += difference * .23;
    draw();
    if (perspective !== requestedView) schedule();
  } catch (error) {
    fail(error);
  }
}

function schedule() {
  if (pending === undefined && !stop.signal.aborted) pending = requestAnimationFrame(update);
}

function wire() {
  const options = { signal: stop.signal };
  slider.addEventListener('input', () => {
    position = Number(slider.value);
    interactiveFrame = true;
    schedule();
  }, options);
  reference.addEventListener('click', () => {
    comparison = !comparison;
    exhibit.showDatum(comparison);
    reference.setAttribute('aria-pressed', String(comparison));
    traceKey.hidden = !comparison;
    schedule();
  }, options);
  view.addEventListener('click', () => {
    requestedView = 1 - requestedView;
    view.setAttribute('aria-pressed', String(Boolean(requestedView)));
    view.textContent = requestedView ? 'Gorge view' : 'Side view';
    document.body.dataset.view = requestedView ? 'elevation' : 'perspective';
    schedule();
  }, options);
}

function dispose() {
  stop.abort();
  if (pending !== undefined) cancelAnimationFrame(pending);
  resize?.disconnect();
  exhibit?.dispose();
  engine?.dispose();
}

function fail(error) {
  if (stop.signal.aborted) return;
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The bridge could not open. ' + (error?.message ?? error);
  controls.forEach(control => { control.disabled = true; });
  dispose();
  console.error(error);
}

async function start() {
  size();
  const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, antialias: true,
    camera: { near: .7, far: 240, fov: 39 }, signal: stop.signal,
  });
  if (!force) {
    try {
      engine = await open();
    } catch (error) {
      if (error?.code !== 'unsupported') throw error;
    }
  }
  const fallback = !engine;
  if (fallback) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: stop.signal });
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#40515b';
  engine.lighting.direction.set([-.44, .72, .52, 2.45]);
  engine.lighting.radiance.set([1, .89, .75, .48]);
  engine.lighting.ambient.set([.51, .64, .76]);
  const shadows = Shadows.attach(engine, {
    bounds: { min: [-23, -9, -12.0], max: [23, 6, 12.0] },
    resolution: 1024, filter: 'pcf', normalBias: .035,
  });
  exhibit = createSpan(engine, shadows, position);
  readouts();
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (stop.signal.aborted) return;
  wire();
  resize = new ResizeObserver(() => { if (size()) schedule(); });
  resize.observe(canvas);
  controls.forEach(control => { control.disabled = false; });
  loading.hidden = true;
  document.body.dataset.renderer = fallback ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); });
await start().catch(fail);