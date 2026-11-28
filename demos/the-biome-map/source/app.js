import { demoStatus } from 'margo-demo-status';

const el = id => document.getElementById(id);
const exhibit = el('exhibit'), temperature = el('temp'), rainfall = el('rain');
const status = demoStatus(exhibit, el('status'));
const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
const controller = new AbortController();
const {signal} = controller;
const worker = new Worker(new URL('./atlas.worker.js', import.meta.url), {type: 'module'});
let awaiting, scene, observer, working = false, climateDirty = false, viewDirty = false, revision = 0, state;

function fail(error) {
  if (signal.aborted || status.failed) return;
  status.error(error);
  temperature.disabled = rainfall.disabled = true;
  worker.terminate();
  scene?.close();
}
worker.addEventListener('message', ({data}) => {
  if (data.id !== awaiting?.id) return;
  const active = awaiting;
  awaiting = undefined;
  if (data.error) active.reject(new Error(data.error));
  else active.resolve(data);
}, {signal});
worker.addEventListener('error', event => {
  const error = new Error(event.message || 'The biome worker could not open.');
  awaiting?.reject(error);
  fail(error);
}, {signal});
signal.addEventListener('abort', () => {
  awaiting?.reject(signal.reason);
  worker.terminate();
}, {once: true});
function classify(temp, rain) {
  const id = revision;
  return new Promise((resolve, reject) => {
    awaiting = {id, resolve, reject};
    worker.postMessage({id, temp, rain});
  });
}
function inputs() {
  return {temp: Number(temperature.value), rain: Number(rainfall.value)};
}
function showInputs({temp, rain}) {
  el('temp-value').value = temp + ' °C';
  el('rain-value').value = rain + ' mm';
  temperature.setAttribute('aria-valuetext', temp + ' degrees Celsius');
  rainfall.setAttribute('aria-valuetext', rain + ' millimetres per year');
}
function report(model, controls) {
  const {shares, ...fields} = model.stats;
  state = controls;
  for (const [i, amount] of shares.entries()) el('share-' + i).textContent = amount.toFixed(1) + '%';
  Object.assign(exhibit.dataset, fields, controls, {revision, shares: shares.map(v=>v.toFixed(3)).join(',')});
}
async function update() {
  if (working || !scene || status.failed || signal.aborted) return;
  const values = inputs();
  const modified = climateDirty && (state.temp !== values.temp || state.rain !== values.rain);
  if (!modified && !viewDirty) return;
  working = true;
  climateDirty = viewDirty = false;
  try {
    if (modified) {
      revision++;
      const result = await classify(values.temp, values.rain);
      signal.throwIfAborted();
      performance.mark('margo-classified-' + revision);
      await scene.update(result.weights);
      report(result, values);
      if (revision === 1) performance.mark('margo-first-input-rendered');
    } else await scene.draw();
  } catch (error) {
    fail(error);
  } finally {
    working = false;
    if (viewDirty || climateDirty) void update();
  }
}
for (const control of [temperature, rainfall]) {
  control.addEventListener('input', () => {
    showInputs(inputs());
    climateDirty = true;
    void update();
  }, {signal});
}
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  controller.abort();
  observer?.disconnect();
}, {signal});

const initialValues = inputs();
const initial = classify(initialValues.temp, initialValues.rain);
initial.catch(fail);
import('./scene.js').then(async ({openAtlas}) => {
  scene = await openAtlas(el('view'), initial, force, signal);
  report(await initial, initialValues);
  exhibit.dataset.renderer = scene.backend;
  observer = new ResizeObserver(() => {
    viewDirty = true;
    void update();
  });
  observer.observe(el('view'));
  temperature.disabled = rainfall.disabled = false;
  showInputs(initialValues);
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);
