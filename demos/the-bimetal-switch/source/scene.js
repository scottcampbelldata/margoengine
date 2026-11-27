import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { makeSwitch } from './instrument.js';
import { trip } from './model.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const temperature = document.querySelector('#temperature');
const degrees = document.querySelector('#degrees');
const reset = document.querySelector('#reset');
const view = document.querySelector('#view');
const contact = document.querySelector('#contact');
const rise = document.querySelector('#rise');
const tripReading = document.querySelector('#trip');
const lifetime = new AbortController();
const roomTemperature = 24;

let engine, instrument, observer, pendingFrame;
let inputPending = false, closeUp = false;

function studio() {
  const width = 64, height = 32;
  const data = new Float32Array(width * height * 4);
  const panels = [
    [-.76, .72, .61, .27, [6.5, 5.7, 4.5]],
    [1.32, .28, .42, .49, [3.4, 4.4, 4.9]],
    [2.69, -.16, .38, .30, [3.7, 3.4, 2.6]],
    [-2.59, .49, .49, .16, [4.7, 4.2, 3.3]],
  ];
  for (let y = 0; y < height; y++) {
    const elevation = Math.PI * (.5 - (y + .5) / height);
    for (let x = 0; x < width; x++) {
      const azimuth = Math.PI * (2 * (x + .5) / width - 1);
      const base = .11 + .17 * Math.max(0, Math.sin(elevation));
      const pixel = [base, base * 1.04, base, 1];
      for (const [center, pitch, w, h, rgb] of panels) {
        const offset = Math.atan2(Math.sin(azimuth - center), Math.cos(azimuth - center));
        const light = Math.exp(-1.7 * ((offset / w) ** 4 + ((elevation - pitch) / h) ** 4));
        for (let channel = 0; channel < 3; channel++) pixel[channel] += rgb[channel] * light;
      }
      data.set(pixel, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function resize() {
  const bounds = canvas.getBoundingClientRect();
  const density = Math.min(devicePixelRatio, 1.5);
  const width = Math.max(1, Math.round(bounds.width * density));
  const height = Math.max(1, Math.round(bounds.height * density));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  if (engine) {
    const distance = Math.max(1, 1.32 * height / width);
    const target = closeUp ? [.003, .125, .045] : [0, .046, .018];
    const offset = closeUp ? [.048, .078, .317] : [.213, .253, .508];
    engine.camera.target = target;
    engine.camera.position = target.map((center, axis) => center + distance * offset[axis]);
  }
}

function draw() {
  const value = temperature.valueAsNumber;
  const state = instrument.pose(value);
  engine.render();
  const tip = (state.tip.y * 1000).toFixed(2);
  degrees.value = value + ' °C';
  rise.value = tip;
  tripReading.value = trip.toFixed(1);
  contact.textContent = state.open ? 'Open' : 'Closed';
  temperature.setAttribute('aria-valuetext', value + ' degrees Celsius');
  document.body.dataset.temperature = String(value);
  document.body.dataset.contact = state.open ? 'open' : 'closed';
  document.body.dataset.rise = tip;
  if (inputPending) {
    performance.mark('margo-temperature-rendered');
    inputPending = false;
  }
}

function schedule() {
  if (pendingFrame !== undefined || lifetime.signal.aborted) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = undefined;
    try { draw(); } catch (error) { fail(error); }
  });
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
  engine?.dispose();
}

function fail(error) {
  if (lifetime.signal.aborted) return;
  document.body.dataset.state = 'error';
  temperature.disabled = true;
  reset.disabled = true;
  view.disabled = true;
  loading.hidden = false;
  loading.textContent = 'The thermal switch could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, antialias: true, capacity: 130,
    signal: lifetime.signal, startupTimeout: 9500, camera: { fov: 34, near: .037, far: 22 },
  });
  resize();
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
  engine.scene.background = '#657b6d';
  engine.lighting.direction.set([-.49, .79, .37, 1.85]);
  engine.lighting.radiance.set([1, .93, .84, .49]);
  engine.lighting.ambient.set([.56, .67, .63]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .083, normalBias: .00039,
    bounds: { min: [-.38, -.064, -.33], max: [.39, .24, .31] },
  });
  await EnvironmentLighting.load(engine, studio(), {
    size: 32, specularSize: 32, intensity: .95, signal: lifetime.signal,
  });
  instrument = makeSwitch(engine, shadows);
  resize();
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const options = { signal: lifetime.signal };
  const change = () => { inputPending = true; schedule(); };
  temperature.addEventListener('input', change, options);
  reset.addEventListener('click', () => {
    temperature.value = String(roomTemperature);
    change();
  }, options);
  view.addEventListener('click', () => {
    closeUp = !closeUp;
    view.setAttribute('aria-pressed', String(closeUp));
    view.textContent = closeUp ? 'Full instrument' : 'Close-up';
    resize();
    schedule();
  }, options);
  observer = new ResizeObserver(() => { resize(); schedule(); });
  observer.observe(canvas);
  temperature.disabled = false;
  reset.disabled = false;
  view.disabled = false;
  loading.hidden = true;
  document.body.dataset.renderer = fallback ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);



