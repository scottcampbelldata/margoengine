import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { makeRig } from './rig.js';
import { makeRace, sample } from './motion.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const slope = document.querySelector('#slope');
const degrees = document.querySelector('#degrees');
const release = document.querySelector('#release');
const result = document.querySelector('#result');
const times = [document.querySelector('#disc-time'), document.querySelector('#ring-time')];
const lifetime = new AbortController();
const controls = [slope, release];

let engine, rig, observer, animationFrame, last;
let angle = slope.valueAsNumber * Math.PI / 180;
let racers = makeRace(angle);
let clock = 0, phase = 'ready', releaseQueued = false;

function studio() {
  const width = 72, height = 36, data = new Float32Array(width * height * 4);
  const panels = [
    [-.77, .68, .59, .24, [7.0, 5.8, 4.83]],
    [1.34, .24, .37, .51, [3.9, 5.1, 5.4]],
    [2.87, -.19, .36, .34, [3.8, 3.44, 2.86]],
    [-2.62, .56, .50, .15, [5.2, 4.5, 3.4]],
  ];
  for (let y = 0; y < height; y++) {
    const pitch = Math.PI * (.5 - (y + .5) / height);
    for (let x = 0; x < width; x++) {
      const azimuth = Math.PI * 2 * ((x + .5) / width - .5);
      const base = .09 + .17 * Math.max(0, Math.sin(pitch));
      const rgb = [base, base * 1.05, base];
      for (const [bearing, elevation, w, h, power] of panels) {
        const offset = Math.atan2(Math.sin(azimuth - bearing), Math.cos(azimuth - bearing));
        const value = Math.exp(-1.75 * ((offset / w) ** 4 + ((pitch - elevation) / h) ** 4));
        for (let channel = 0; channel < 3; channel++) rgb[channel] += value * power[channel];
      }
      data.set([...rgb, 1], (y * width + x) * 4);
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
  if (engine) {
    const factor = Math.max(1, 1.42 * height / width);
    engine.camera.target = [-.047, .167, 0];
    engine.camera.position = [-.047 + .355 * factor, .167 + .68 * factor, 1.22 * factor];
  }
}
function showPhase(next) {
  phase = next;
  if (next === 'rolling') result.textContent = 'Both wheels are rolling.';
  if (next === 'ready') result.textContent = 'Ready at the gate.';
  if (next === 'complete') result.textContent = 'The disc finished ' + (racers[1].finish - racers[0].finish).toFixed(2) + ' s sooner.';
  slope.disabled = next === 'rolling';
  release.disabled = next === 'rolling';
}
function pose(now) {
  animationFrame = undefined;
  const delta = last === undefined ? 1 / 60 : Math.min(.075, (now - last) / 1000);
  last = now;
  if (phase === 'rolling') {
    clock = Math.min(racers[1].stop, clock + delta);
    if (clock === racers[1].stop) showPhase('complete');
  }

  const distances = racers.map((racer) => sample(racer, clock).distance);
  const finished = racers.map((racer) => clock >= racer.finish);
  rig.pose(angle, distances, clock, finished);
  for (const [index, output] of times.entries()) {
    const text = phase === 'ready' ? '—' : Math.min(clock, racers[index].finish).toFixed(2);
    if (output.textContent !== text) output.textContent = text;
  }
  engine.render({ delta });
  document.body.dataset.angle = slope.value;
  document.body.dataset.phase = phase;
  document.body.dataset.disc = distances[0].toFixed(5);
  document.body.dataset.ring = distances[1].toFixed(5);
  if (releaseQueued && distances[0] > .0005) {
    performance.mark('margo-release-rendered');
    releaseQueued = false;
  }
  if (phase === 'rolling') schedule();
  else last = undefined;
}
function schedule() {
  if (animationFrame === undefined && !lifetime.signal.aborted) animationFrame = requestAnimationFrame((now) => {
    try { pose(now); } catch (error) { fail(error); }
  });
}
function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  engine?.dispose();
}
function fail(error) {
  if (lifetime.signal.aborted) return;
  document.body.dataset.state = 'error';
  controls.forEach((control) => { control.disabled = true; });
  loading.hidden = false;
  loading.textContent = 'The rolling race could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, antialias: true, capacity: 165,
    signal: lifetime.signal, startupTimeout: 9500, camera: { fov: 35, near: .14, far: 20 },
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
  engine.scene.background = '#586c5d';
  engine.lighting.direction.set([-.54, .78, .32, 1.90]);
  engine.lighting.radiance.set([.96, .98, .88, .45]);
  engine.lighting.ambient.set([.57, .68, .61]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .114, normalBias: .00104,
    bounds: { min: [-.64,-.074,-.30], max: [.56,.53,.32] },
  });
  await EnvironmentLighting.load(engine, studio(), { size: 32, specularSize: 32, intensity: .97, signal: lifetime.signal });
  rig = makeRig(engine, shadows);
  size();
  pose(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;

  const options = { signal: lifetime.signal };
  slope.addEventListener('input', () => {
    angle = slope.valueAsNumber * Math.PI / 180;
    racers = makeRace(angle);
    degrees.textContent = slope.value + '°';
    slope.setAttribute('aria-valuetext', slope.value + ' degrees');
    clock = 0;
    showPhase('ready');
    schedule();
  }, options);
  release.addEventListener('click', () => {
    clock = 0;
    releaseQueued = true;
    showPhase('rolling');
    schedule();
  }, options);
  observer = new ResizeObserver(() => { size(); schedule(); });
  observer.observe(canvas);
  showPhase('ready');
  loading.hidden = true;
  document.body.dataset.renderer = fallback ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}
window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);
