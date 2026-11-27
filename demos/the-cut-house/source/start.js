import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { loadBuilding, sourceURL } from './building.js';

const canvas = document.querySelector('#house');
const notice = document.querySelector('#status');
const warning = document.querySelector('#error');
const help = document.querySelector('#help');
const status = demoStatus(canvas, notice, document.querySelector('#message'));
const controller = new AbortController();
const { signal } = controller;
const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
document.querySelector('#ifc-source').href = sourceURL;
let engine;

function fit() {
  const width = Math.max(1, Math.round(canvas.clientWidth * 1.65));
  const height = Math.max(1, Math.round(canvas.clientHeight * 1.65));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}
function destroy() {
  if (signal.aborted) return;
  controller.abort();
  engine?.dispose();
}
function fail(reason) {
  if (signal.aborted) return;
  status.error(reason);
  notice.hidden = true;
  warning.hidden = false;
  help.hidden = reason?.code !== 'unsupported';
  for (const control of document.querySelectorAll('main button,main input,main select')) control.disabled = true;
  if (reason?.code !== 'unsupported') console.error(reason);
  queueMicrotask(destroy);
}

fit();
applyQualityTier({ search: '?quality=high', userAgent: '' });
addEventListener('pagehide', event => { if (!event.persisted) destroy(); }, { signal });
const building = loadBuilding(signal);
const scene = import('./scene.js');
const options = { backend: 'webgpu', exactSize: true, antialias: true, capacity: 36, startupTimeout: 2500, signal,
  camera: { fov: 34, near: .3, far: 200 } };

async function connect() {
  if (!force && navigator.gpu) {
    try { return await Engine.create(canvas, options); }
    catch (reason) {
      if (reason?.code !== 'unsupported' && reason?.code !== 'timeout') throw reason;
    }
  }
  const { install } = await import('@margoengine/webgl2-compat');
  await install({ force: true, signal });
  return Engine.create(canvas, options);
}

const opening = connect().then(target => {
  if (signal.aborted) { target.dispose(); signal.throwIfAborted(); }
  engine = target;
  performance.mark('cut-house-device-ready');
  return target;
});
Promise.all([opening, scene, building]).then(([target, exhibit, model]) => exhibit.open({
  engine: target, model, fit, status, notice, signal, fail,
})).catch(fail);
