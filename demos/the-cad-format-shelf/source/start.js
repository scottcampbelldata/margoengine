import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { catalogue, jobs } from './samples.js';
import { openArchive } from './archive.js';

const canvas = document.querySelector('#shelf');
const notice = document.querySelector('#status');
const error = document.querySelector('#error');
const message = document.querySelector('#message');
const help = document.querySelector('#help');
const status = demoStatus(canvas, notice, message);
const controller = new AbortController();
const { signal } = controller;
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
let engine;

for (const [format, samples] of Object.entries(catalogue)) {
  const select = document.querySelector('#' + format + '-sample');
  for (const sample of samples) select.add(new Option(sample.label, sample.id));
}
function fit() {
  const width = Math.max(1, Math.round(canvas.clientWidth * 1.50));
  const height = Math.max(1, Math.round(canvas.clientHeight * 1.50));
  if (width === canvas.width && height === canvas.height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}
function close() {
  if (signal.aborted) return;
  controller.abort();
  engine?.dispose();
}
function fail(reason) {
  if (signal.aborted) return;
  status.error(reason);
  notice.hidden = true;
  error.hidden = false;
  help.hidden = reason?.code !== 'unsupported';
  for (const control of document.querySelectorAll('#laboratory select,#laboratory button')) control.disabled = true;
  if (reason?.code !== 'unsupported') console.error(reason);
  queueMicrotask(close);
}

fit();
applyQualityTier();
addEventListener('pagehide', (event) => { if (!event.persisted) close(); }, { signal });

const archive = openArchive(signal);
const opening = Promise.all(jobs.slice(0, 2).map((id) => archive.get(id)));
const scene = import('./scene.js');
const options = { backend: 'webgpu', exactSize: true, antialias: true, capacity: 88,
  camera: { near: .10, far: 32, fov: 34 }, startupTimeout: 2500, signal };
async function create() {
  if (!forced && navigator.gpu) {
    try { return await Engine.create(canvas, options); }
    catch (reason) {
      if (reason?.code !== 'unsupported' && reason?.code !== 'timeout') throw reason;
    }
  }
  const { install } = await import('@margoengine/webgl2-compat');
  await install({ force: true, signal });
  return Engine.create(canvas, options);
}
const device = create().then((target) => {
  if (signal.aborted) { target.dispose(); signal.throwIfAborted(); }
  engine = target;
  performance.mark('cad-shelf-device-ready');
  return target;
});
Promise.all([device, scene, opening]).then(([engine, exhibit, initial]) => exhibit.open({
  archive, initial, engine, fit, status, notice, signal, fail,
})).catch(fail);
