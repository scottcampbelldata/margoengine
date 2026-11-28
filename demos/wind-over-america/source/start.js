import { startEngine } from '@margoengine/webgl2-compat/auto';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { loadAtlas, loadWind, openingDay } from './wind-data.js';
import { prepareFrames } from './flow-cache.js';

const canvas = document.querySelector('#map');
const label = document.querySelector('#status');
const message = document.querySelector('#message');
const status = demoStatus(canvas, label, message);
const errorBox = document.querySelector('#error');
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const help = document.querySelector('#help');
const controller = new AbortController();
const { signal } = controller;
const controls = [document.querySelector('#day'), document.querySelector('#play')];
let engine, renderer, atlas;

function fit() {
  const width = Math.max(1, Math.round(canvas.clientWidth * 1.5));
  const height = Math.max(1, Math.round(canvas.clientHeight * 1.5));
  if (width === canvas.width && height === canvas.height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

function stop() {
  if (signal.aborted) return;
  controller.abort();
  engine?.dispose();
  atlas?.close();
}
function fail(reason) {
  if (signal.aborted) return;
  status.error(reason);
  label.hidden = true;
  errorBox.hidden = false;
  help.hidden = reason?.code !== 'unsupported';
  for (const control of controls) control.disabled = true;
  if (reason?.code !== 'unsupported') console.error(reason);
  queueMicrotask(stop);
}

fit();
applyQualityTier();
addEventListener('pagehide', (event) => { if (!event.persisted) stop(); }, { signal });
const image = loadAtlas(signal).then((image) => (atlas = image));
const field = loadWind(signal).then((archive) => {
  signal.throwIfAborted();
  return { archive, frames: prepareFrames(archive, openingDay, signal) };
});
const scene = import('./scene.js');
const options = { exactSize: true, antialias: true, capacity: 48, forceCompat: forced,
  loadCompat: () => import('@margoengine/webgl2-compat'),
  startupTimeout: 2500, camera: { near: .02, far: 15, fov: 35 }, signal };

const opening = startEngine(canvas, options).then((started) => {
  const target = started.engine;
  renderer = started.renderer;
  if (signal.aborted) {
    target.dispose();
    signal.throwIfAborted();
  }
  engine = target;
  performance.mark('wind-device-ready');
  return target;
});
Promise.all([opening, image, field, scene]).then(([engine, atlas, field, exhibit]) =>
  exhibit.open({ engine, renderer, atlas, ...field, fit, fail, status, signal, label })).catch(fail);

