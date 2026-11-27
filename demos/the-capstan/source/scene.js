import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { assembleCapstan } from './rig.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const wrap = document.querySelector('#wrap');
const friction = document.querySelector('#friction');
const wrapValue = document.querySelector('#wrap-value');
const frictionValue = document.querySelector('#friction-value');
const holding = document.querySelector('#holding');
const ratio = document.querySelector('#ratio');
const view = document.querySelector('#view');
const lifetime = new AbortController();

let engine, capstan, observer, frame;
let changed = false, plan = false;

function softboxes() {
  const width = 64, height = 32;
  const data = new Float32Array(width * height * 4);
  const cards = [
    [-.69, .76, .64, .31, [6.9, 5.5, 4.2]],
    [1.42, .39, .34, .62, [3.2, 4.2, 5.5]],
    [2.86, .12, .53, .29, [4.8, 3.4, 2.1]],
  ];
  for (let y = 0; y < height; y++) {
    const elevation = Math.PI * (.5 - (y + .5) / height);
    for (let x = 0; x < width; x++) {
      const bearing = Math.PI * (2 * (x + .5) / width - 1);
      const base = .075 + .18 * Math.max(0, Math.sin(elevation));
      const rgb = [base * .86, base, base * 1.1, 1];
      for (const [center, pitch, w, h, radiance] of cards) {
        const d = Math.atan2(Math.sin(bearing - center), Math.cos(bearing - center));
        const power = Math.exp(-1.9 * ((d / w) ** 4 + ((elevation - pitch) / h) ** 4));
        for (let c = 0; c < 3; c++) rgb[c] += power * radiance[c];
      }
      data.set(rgb, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function size() {
  const bounds = canvas.getBoundingClientRect();
  const density = Math.min(devicePixelRatio, 1.5);
  const width = Math.max(1, Math.round(bounds.width * density));
  const height = Math.max(1, Math.round(bounds.height * density));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  if (!engine) return;
  const scale = Math.max(1, 1.45 * height / width);
  const target = [0, .049, .002];
  const offset = plan ? [0, 1.010, .015] : [-.320, .604, .744];
  engine.camera.target = target;
  engine.camera.position = target.map((value, axis) => value + scale * offset[axis]);
}

function draw() {
  const wraps = wrap.valueAsNumber, coefficient = friction.valueAsNumber;
  const result = capstan.pose(wraps, coefficient);
  engine.render();
  wrapValue.value = wraps.toFixed(2);
  frictionValue.value = coefficient.toFixed(2);
  holding.value = result.holdingTension.toFixed(result.holdingTension < 1 ? 2 : 1);
  ratio.value = result.ratio.toFixed(result.ratio > 100 ? 0 : 2);
  wrap.setAttribute('aria-valuetext', wraps.toFixed(2) + ' wraps');
  friction.setAttribute('aria-valuetext', coefficient.toFixed(2));
  document.body.dataset.holding = String(result.holdingTension);
  document.body.dataset.wrap = wrap.value;
  document.body.dataset.friction = friction.value;
  if (changed) {
    performance.mark('margo-capstan-input-rendered');
    changed = false;
  }
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    try { draw(); } catch (error) { fail(error); }
  });
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  if (lifetime.signal.aborted) return;
  document.body.dataset.state = 'error';
  wrap.disabled = true;
  friction.disabled = true;
  view.disabled = true;
  loading.hidden = false;
  loading.textContent = 'The capstan could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, antialias: true, capacity: 170,
    startupTimeout: 9500, signal: lifetime.signal, camera: { fov: 34, near: .040, far: 22 },
  });
  size();
  if (!forced) {
    try { engine = await open(); }
    catch (error) { if (error?.code !== 'unsupported') throw error; }
  }
  const fallback = !engine;
  if (fallback) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: lifetime.signal });
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#485264';
  engine.lighting.direction.set([-.60, .73, .38, 1.92]);
  engine.lighting.radiance.set([.98, .92, .84, .47]);
  engine.lighting.ambient.set([.57, .62, .73]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .077, normalBias: .00039,
    bounds: { min: [-.37, -.040, -.31], max: [.36, .30, .33] },
  });
  await EnvironmentLighting.load(engine, softboxes(), { size: 32, specularSize: 32, intensity: 1.12, signal: lifetime.signal });
  capstan = assembleCapstan(engine, shadows);
  size();
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const markInput = () => { changed = true; schedule(); };
  const options = { signal: lifetime.signal };
  wrap.addEventListener('input', markInput, options);
  friction.addEventListener('input', markInput, options);
  view.addEventListener('click', () => {
    plan = !plan;
    view.setAttribute('aria-pressed', String(plan));
    view.textContent = plan ? 'Instrument view' : 'Plan view';
    size();
    schedule();
  }, options);
  observer = new ResizeObserver(() => { size(); schedule(); });
  observer.observe(canvas);
  wrap.disabled = false;
  friction.disabled = false;
  view.disabled = false;
  loading.hidden = true;
  document.body.dataset.renderer = fallback ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);



