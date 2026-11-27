import { Engine } from '@margoengine/core';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { createBench } from './bench.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const load = document.querySelector('#load');
const fold = document.querySelector('#fold');
const cycle = document.querySelector('#cycle');
const stress = document.querySelector('#stress');
const inspect = document.querySelector('#inspect');
const loadLabel = document.querySelector('#load-value');
const foldLabel = document.querySelector('#fold-value');
const readouts = ['flat-bend', 'fold-bend', 'ratio', 'flat-stress', 'fold-stress'].map(id => document.getElementById(id));
const labels = [document.querySelector('#flat-pin'), document.querySelector('#fold-pin')];
const legend = document.querySelector('#stress-key');
const stop = new AbortController();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const controls = [load, fold, cycle, stress, inspect];
const target = { grams: Number(load.value), depth: Number(fold.value) / 1000, stress: false, detail: 0 };
const projected = { x: 0, y: 0, z: 0 };

let engine;
let bench;
let resize;
let frame;
let inputPending;
let startedAt;
let mode = 0;
let motionTime = 0;
let lastFrame = 0;
let lastGeometry = [target.depth, target.grams, target.stress];

function setOutputs() {
  const [flat, folded] = bench.values();
  const results = [flat.deflection * 1000, folded.deflection * 1000, folded.stiffness / flat.stiffness,
    flat.peakStress / 1e6, folded.peakStress / 1e6];
  for (const [index, value] of results.entries()) {
    readouts[index].value = value.toFixed(index === 1 || index > 2 ? 2 : 1);
  }
  loadLabel.value = Math.round(target.grams) + ' g';
  foldLabel.value = Number(fold.value).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' mm';
}

function measureCanvas() {
  const pixelRatio = Math.min(2, Math.max(1.25, devicePixelRatio));
  const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function cameraPose(phase) {
  const width = canvas.clientWidth;
  const height = Math.max(1, canvas.clientHeight);
  const aspect = width / height;
  const yaw = .55 + .60 * phase;
  const pitch = .43 - .085 * phase;
  const distance = Math.max(.429, .520 / aspect) * (1 - .43 * phase);
  const center = [.041 * phase, .053 + .025 * phase, -.055 * phase];
  const groundDistance = Math.cos(pitch) * distance;
  engine.camera.target = center;
  engine.camera.position = [center[0] + Math.sin(yaw) * groundDistance, center[1] + Math.sin(pitch) * distance,
    center[2] + Math.cos(yaw) * groundDistance];
}

function updatePins() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  labels.forEach((label, index) => {
    const [x, y, z] = bench.labels[index];
    worldToScreen({ x, y, z }, engine.camera, width, height, projected);
    const left = Math.min(width - label.offsetWidth - 8, Math.max(8, projected.x - label.offsetWidth * .55));
    label.style.transform = 'translate(' + left + 'px,' + Math.max(8, projected.y - 27) + 'px)';
  });
}

function cancelCycle() {
  startedAt = undefined;
  cycle.setAttribute('aria-pressed', 'false');
  cycle.textContent = 'Run load cycle';
}

function draw() {
  const geometry = [target.depth, target.grams, target.stress];
  if (geometry.some((value, index) => lastGeometry[index] !== value)) {
    bench.update(...geometry);
    lastGeometry = geometry;
  }
  cameraPose(mode);
  engine.render({ delta: 0 });
  updatePins();
  setOutputs();
  if (inputPending && !performance.getEntriesByName('margo-first-input-applied').length) {
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(() => {
      if (!stop.signal.aborted) performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  inputPending = false;
}

function animate(now) {
  frame = undefined;
  if (stop.signal.aborted) return;
  try {
    if (startedAt !== undefined) {
      const progress = Math.min(1, (now - startedAt) / 2300);
      const grams = Math.round(30 * Math.sin(Math.PI * progress) ** 2);
      target.grams = grams;
      load.value = grams;
      if (progress === 1) cancelCycle();
    }
    motionTime = now - lastFrame;
    lastFrame = now;
    if (reduced.matches || Math.abs(mode - target.detail) < .002) mode = target.detail;
    else mode += (target.detail - mode) * (1 - Math.exp(-Math.min(motionTime, 50) / 85));
    draw();
    if (startedAt !== undefined || mode !== target.detail) schedule();
  } catch (error) {
    fail(error);
  }
}

function schedule() {
  if (frame === undefined && !stop.signal.aborted) {
    lastFrame = performance.now() - 16;
    frame = requestAnimationFrame(animate);
  }
}

function connect() {
  const options = { signal: stop.signal };
  load.addEventListener('input', () => {
    cancelCycle();
    target.grams = Number(load.value);
    inputPending = true;
    schedule();
  }, options);
  fold.addEventListener('input', () => {
    target.depth = Number(fold.value) / 1000;
    inputPending = true;
    schedule();
  }, options);
  stress.addEventListener('click', () => {
    target.stress = !target.stress;
    stress.setAttribute('aria-pressed', String(target.stress));
    legend.hidden = !target.stress;
    schedule();
  }, options);
  inspect.addEventListener('click', () => {
    target.detail = 1 - target.detail;
    inspect.setAttribute('aria-pressed', String(Boolean(target.detail)));
    inspect.textContent = target.detail ? 'Back to the bench' : 'Inspect the folds';
    document.body.dataset.inspect = target.detail ? 'detail' : 'bench';
    schedule();
  }, options);
  cycle.setAttribute('aria-pressed', 'false');
  cycle.addEventListener('click', () => {
    if (startedAt !== undefined) cancelCycle();
    else if (reduced.matches) {
      target.grams = target.grams === 30 ? 0 : 30;
      load.value = target.grams;
    } else {
      startedAt = performance.now();
      cycle.setAttribute('aria-pressed', 'true');
      cycle.textContent = 'Stop load cycle';
    }
    inputPending = true;
    schedule();
  }, options);
}

function dispose() {
  stop.abort();
  if (frame !== undefined) cancelAnimationFrame(frame);
  resize?.disconnect();
  bench?.dispose();
  engine?.dispose();
}

function fail(error) {
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The test bench could not open. ' + (error?.message ?? error);
  controls.forEach((control) => { control.disabled = true; });
  dispose();
  console.error(error);
}

async function start() {
  measureCanvas();
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu',
    exactSize: true,
    camera: { near: .025, far: 8, fov: 35 },
    signal: stop.signal,
  });
  if (!forced) {
    try {
      engine = await open();
    } catch (error) {
      if (error?.code !== 'unsupported') throw error;
    }
  }
  const compatibility = !engine;
  if (compatibility) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: stop.signal });
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#435059';
  engine.lighting.direction.set([-.53, .78, .37, 2.55]);
  engine.lighting.radiance.set([1, .93, .82, .44]);
  engine.lighting.ambient.set([.50, .61, .75]);
  const shadows = Shadows.attach(engine, {
    bounds: { min: [-.21, -.05, -.17], max: [.21, .12, .17] },
    filter: 'pcf',
    resolution: 1024,
    normalBias: .0002,
  });
  bench = createBench(engine, shadows);
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (stop.signal.aborted) return;
  connect();
  controls.forEach((control) => { control.disabled = false; });
  document.body.dataset.renderer = compatibility ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
  loading.hidden = true;
  resize = new ResizeObserver(() => {
    measureCanvas();
    schedule();
  });
  resize.observe(canvas);
}

addEventListener('pagehide', (event) => {
  if (!event.persisted) dispose();
});
await start().catch(fail);
