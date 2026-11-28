import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { capacity, createSorter } from './motion.js';
import { createMachine } from './model.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const status = document.querySelector('#status');
const release = document.querySelector('#release');
const reset = document.querySelector('#reset');
const view = document.querySelector('#view');
const route = { left: document.querySelector('#left'), right: document.querySelector('#right') };
const counts = { left: document.querySelector('#left-count'), right: document.querySelector('#right-count') };
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const lifetime = new AbortController();
const sorter = createSorter();
const benchShot = { target: [-.019, .20, .125], offset: [.69, 1.30, 1.96], aspect: 1.13 };
const forkShot = { target: [.034, .333, .151], offset: [.39, .59, .82], aspect: 1.08 };
let engine, machine, observer, frame;
let ready = false, close = false, pendingRelease = false, viewBlend = 0, last = 0;

function resize() {
  const bounds = canvas.getBoundingClientRect();
  const ratio = 1.5;
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function poseCamera(amount) {
  const mix = (a, b) => a + (b - a) * amount;
  const shotFit = Math.max(1, mix(benchShot.aspect, forkShot.aspect) * canvas.height / canvas.width);
  const target = benchShot.target.map((coordinate, index) => mix(coordinate, forkShot.target[index]));
  engine.camera.target = target;
  engine.camera.position = target.map((coordinate, index) =>
    coordinate + shotFit * mix(benchShot.offset[index], forkShot.offset[index]));
}

function readout() {
  release.disabled = !ready || !sorter.canDrop;
  reset.disabled = !ready;
  view.disabled = !ready;
  view.setAttribute('aria-pressed', String(close));
  view.textContent = close ? 'Whole sorter' : 'Junction view';
  for (const side of Object.keys(route)) {
    route[side].disabled = !ready || !sorter.canSelect || sorter.counts[side] === capacity;
    route[side].setAttribute('aria-pressed', String(sorter.selected === side));
    counts[side].value = String(sorter.counts[side]);
  }
  let line;
  if (sorter.phase === 'feed') {
    line = sorter.canSelect ? 'Marble on the ramp. You can still switch trays.' : 'Marble approaching the locked junction.';
  } else if (sorter.phase === 'bridge') {
    line = 'Marble crossing the junction.';
  } else if (sorter.marble) {
    line = 'Marble headed to the ' + sorter.marble.side + ' tray.';
  } else if (sorter.counts.left === capacity && sorter.counts.right === capacity) {
    line = 'Both trays are full. Reset to start again.';
  } else if (sorter.counts[sorter.selected] === capacity) {
    line = 'This tray is full. Switch to the other tray.';
  } else {
    line = 'Junction set to the ' + sorter.selected + ' tray.';
  }
  if (status.textContent !== line) status.textContent = line;
}

function snapshot() {
  Object.assign(document.body.dataset, {
    phase: sorter.phase,
    selected: sorter.selected,
    routed: sorter.marble?.side ?? sorter.settled.at(-1)?.side ?? '',
    left: sorter.counts.left,
    right: sorter.counts.right,
    position: sorter.marble ? sorter.marble.position.map((value) => value.toFixed(4)).join(',') : '',
    travel: sorter.marble ? sorter.marble.distance.toFixed(5) : '',
    view: viewBlend === 1 ? 'junction' : viewBlend === 0 ? 'bench' : 'moving',
  });
}

function draw(now) {
  frame = undefined;
  const dt = last ? Math.min(.04, (now - last) / 1000) : 1 / 60;
  last = now;
  // A fixed slow-playback ratio keeps the moving ball and gate readable; the model still uses meters and seconds.
  sorter.update(dt * .78, motionPreference.matches);
  const target = Number(close);
  viewBlend = motionPreference.matches || Math.abs(viewBlend - target) < .0008
    ? target : target + (viewBlend - target) * Math.exp(-dt * 17);
  poseCamera(viewBlend);
  machine.apply(sorter);
  engine.render({ delta: dt });
  readout();
  snapshot();
  if (pendingRelease) {
    pendingRelease = false;
    performance.mark('margo-release-applied');
  }
  if (sorter.moving || viewBlend !== target) schedule();
  else last = 0;
}

function schedule() {
  if (frame === undefined && !lifetime.signal.aborted) frame = requestAnimationFrame((now) => {
    try { draw(now); } catch (error) { fail(error); }
  });
}

function fail(error) {
  ready = false;
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The sorter could not open on this browser.';
  readout();
  console.error(error);
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

async function start() {
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, capacity: 256,
    camera: { fov: 38, near: .14, far: 60 },
    signal: lifetime.signal, startupTimeout: 10000,
  });
  resize();
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
  engine.scene.background = '#cac4b0';
  engine.lighting.direction.set([-.96, 1.45, .91, 3.3]);
  engine.lighting.radiance.set([1, .926, .806, .41]);
  engine.lighting.ambient.set([.79, .94, 1]);
  const shadows = Shadows.attach(engine, { resolution: 1024, filter: 'soft', lightSize: .049,
    blockerSamples: 8, samples: 16, jitter: false,
    bounds: { min: [-1.15, -.24, -.91], max: [1.15, .84, 1.02] },
  });
  machine = createMachine(engine, shadows);
  Object.assign(document.body.dataset, { renderer: compatible ? 'compatibility' : 'webgpu', meshes: machine.meshCount });
  const options = { signal: lifetime.signal };
  release.addEventListener('click', () => {
    if (!sorter.canDrop) return;
    sorter.drop();
    pendingRelease = true;
    readout();
    schedule();
  }, options);
  for (const side of Object.keys(route)) route[side].addEventListener('click', () => {
    sorter.select(side);
    readout();
    schedule();
  }, options);
  reset.addEventListener('click', () => {
    sorter.reset();
    pendingRelease = false;
    close = false;
    readout();
    schedule();
  }, options);
  view.addEventListener('click', () => { close = !close; readout(); schedule(); }, options);
  motionPreference.addEventListener('change', schedule, options);
  addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    lifetime.abort();
    observer?.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    engine.dispose();
  }, options);
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  ready = true;
  loading.hidden = true;
  document.body.dataset.state = 'ready';
  readout();
  performance.mark('margo-first-usable-frame');
  observer = new ResizeObserver(() => { resize(); schedule(); });
  observer.observe(canvas);
}

await start().catch(fail);
