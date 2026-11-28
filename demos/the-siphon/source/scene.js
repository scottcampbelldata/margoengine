import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createApparatus } from './apparatus.js';
import { maxDrop, solveSiphon } from './rig.js';

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const range = document.getElementById('outlet');
const button = document.getElementById('guide');
const diagram = document.getElementById('diagram');
const state = document.getElementById('flow-state');
const [drop, flow, speed, pressure] = ['outlet-value', 'flow', 'speed', 'pressure'].map(id => document.getElementById(id));
const controller = new AbortController();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

let engine;
let model;
let presentation;
let observer;
let frame;
let previousFrame;
let listening = false;
let asked = Number(range.value) / 100;
let recordInput = false;
let wireVisible = false;

function setCanvasSize() {
  const ratio = Math.min(1.75, Math.max(1.20, devicePixelRatio));
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (width === canvas.width && height === canvas.height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

function aim() {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const distance = Math.max(1.01, 1.31 / aspect);
  const yaw = .24;
  const pitch = .17;
  const center = [.014, .219, 0];
  const ground = Math.cos(pitch) * distance;
  engine.camera.target = center;
  engine.camera.position = [center[0] + Math.sin(yaw) * ground, center[1] + Math.sin(pitch) * distance, Math.cos(yaw) * ground];
}

function updateReadouts() {
  drop.value = (100 * model.head).toFixed(1) + ' cm';
  range.style.setProperty('--progress', (100 * model.head / maxDrop) + '%');
  range.setAttribute('aria-valuetext', model.head ? (100 * model.head).toFixed(1) + ' centimeters below the waterline' : 'Level with the waterline');
  flow.value = model.litersPerMinute.toFixed(2);
  speed.value = model.speed.toFixed(2);
  pressure.value = model.crownPressure.toFixed(2).replace('-', '−');
  state.toggleAttribute('data-stopped', model.speed === 0);
  const label = model.speed ? 'Primed · flowing' : 'Primed · level outlet';
  if (state.lastElementChild.textContent !== label) state.lastElementChild.textContent = label;
}

function draw(delta) {
  aim();
  presentation.animate(delta, reduced.matches);
  engine.render({ delta: 0 });
  if (recordInput && !performance.getEntriesByName('margo-first-input-applied').length) {
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(() => {
      if (!controller.signal.aborted) performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  recordInput = false;
}

function update(now) {
  frame = undefined;
  if (controller.signal.aborted) return;
  if (listening && !recordInput && now - previousFrame < 31) {
    schedule();
    return;
  }
  try {
    if (asked !== model.head) {
      model = solveSiphon(asked);
      presentation.setModel(model);
      updateReadouts();
    }
    draw(previousFrame === undefined ? 0 : Math.min(.075, (now - previousFrame) / 1000));
    previousFrame = now;
    listening = model.speed > 0 && !reduced.matches && !document.hidden;
    if (listening) schedule();
  } catch (error) {
    fail(error);
  }
}

function schedule() {
  if (frame === undefined && !controller.signal.aborted) frame = requestAnimationFrame(update);
}

function wire() {
  const options = { signal: controller.signal };
  range.addEventListener('input', () => {
    asked = Number(range.value) / 100;
    recordInput = true;
    schedule();
  }, options);
  button.addEventListener('click', () => {
    wireVisible = !wireVisible;
    presentation.guide(wireVisible);
    diagram.hidden = !wireVisible;
    button.lastChild.textContent = wireVisible ? 'Hide waterline' : 'Show waterline';
    button.setAttribute('aria-pressed', String(wireVisible));
    schedule();
  }, options);
  reduced.addEventListener('change', schedule, options);
  document.addEventListener('visibilitychange', schedule, options);
}

function dispose() {
  controller.abort();
  if (frame !== undefined) cancelAnimationFrame(frame);
  observer?.disconnect();
  presentation?.dispose();
  engine?.dispose();
}

function fail(error) {
  if (controller.signal.aborted) return;
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The siphon could not open. ' + (error?.message ?? error);
  range.disabled = button.disabled = true;
  dispose();
  console.error(error);
}

async function start() {
  setCanvasSize();
  const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, { backend: 'webgpu', exactSize: true, antialias: true,
    camera: { near: .036, far: 8, fov: 38 }, signal: controller.signal });
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
    await install({ force: true, signal: controller.signal });
    engine = await open();
  }
  performance.mark('margo-engine-ready');
  engine.onError = fail;
  engine.scene.background = '#253a45';
  engine.lighting.direction.set([-.51, .72, .48, 2.38]);
  engine.lighting.radiance.set([1.0, .89, .75, .55]);
  engine.lighting.ambient.set([.55, .66, .75]);
  const shadows = Shadows.attach(engine, {
    bounds: { min: [-.45, -.015, -.24], max: [.45, .53, .24] },
    resolution: 1024, filter: 'pcf', normalBias: .0008,
  });
  model = solveSiphon(asked);
  presentation = createApparatus(engine, shadows, model);
  updateReadouts();
  performance.mark('margo-geometry-ready');
  draw(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (controller.signal.aborted) return;
  wire();
  observer = new ResizeObserver(() => { if (setCanvasSize()) schedule(); });
  observer.observe(canvas);
  range.disabled = button.disabled = false;
  loading.hidden = true;
  document.body.dataset.renderer = fallback ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}

addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); });
await start().catch(fail);