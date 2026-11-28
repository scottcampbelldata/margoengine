import { demoStatus } from 'margo-demo-status';

const element = id => document.getElementById(id);
const exhibit = element('exhibit');
const canvas = element('view');
const era = element('era');
const layout = element('layout');
const generate = element('generate');
const view = element('plan');
const message = element('status');
const status = demoStatus(exhibit, message);
const controller = new AbortController();
const {signal} = controller;
const controls = [era, layout, generate, view];
let seed = 13407, scene, observer, revision = 0, overhead = false, busy = false;
let drawing, resizePending = false;
const worker = new Worker(new URL('./plan.worker.js', import.meta.url), {type: 'module'});
let job;
worker.addEventListener('message', ({data}) => {
  if (!job || data.id !== job.id) return;
  const active = job;
  job = undefined;
  if (data.error) active.reject(new Error(data.error));
  else active.resolve(data.plan);
}, {signal});
worker.addEventListener('error', event => {
  const error = new Error(event.message || 'The city worker did not start.');
  job?.reject(error);
  job = undefined;
  fail(error);
}, {signal});
signal.addEventListener('abort', () => {
  worker.terminate();
  job?.reject(signal.reason);
  job = undefined;
}, {once: true});

function build() {
  const id = revision;
  return new Promise((resolve, reject) => {
    job = {id, resolve, reject};
    worker.postMessage({id, seed, era: era.value, layout: layout.value});
  });
}
function report(city) {
  const {seed, era, layout, streets, blocks, lots, buildings, roads, lotsSignature, buildingsSignature, styles, triangles} = city;
  Object.assign(exhibit.dataset, {
    seed, era, layout, streets, blocks, lots, buildings, roads, lotsSignature, buildingsSignature,
    styles: JSON.stringify(styles), triangles, revision,
  });
  for (const [id, value] of Object.entries({streets, blocks, lots, buildings})) element(id).textContent = value;
  element('seed').textContent = 'Plan seed ' + seed.toString().padStart(5, '0');
}
function fail(error) {
  if (signal.aborted) return;
  status.error(error);
  for (const control of controls) control.disabled = true;
  scene?.close();
  worker.terminate();
}
async function renderView() {
  if (!scene || busy || drawing || signal.aborted || status.failed) return;
  resizePending = false;
  const next = overhead;
  drawing = scene.draw(next);
  try {
    await drawing;
    if (signal.aborted) return;
    view.setAttribute('aria-pressed', String(next));
    view.textContent = next ? 'Model view' : 'Plan view';
    exhibit.dataset.view = next ? 'plan' : 'model';
  } catch (error) {
    fail(error);
  } finally {
    drawing = undefined;
    if (resizePending) void renderView();
  }
}
async function change(nextSeed) {
  if (busy || !scene || signal.aborted || status.failed) return;
  busy = true;
  seed = nextSeed;
  revision++;
  for (const control of controls) control.disabled = true;
  message.textContent = 'Laying out streets and lots…';
  try {
    const model = await build();
    await drawing;
    performance.mark('margo-generation-' + revision);
    await scene.replace(model);
    if (signal.aborted) return;
    report(model);
    message.textContent = '';
    if (!performance.getEntriesByName('margo-first-input-rendered').length) {
      performance.mark('margo-first-input-rendered');
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    if (!signal.aborted && !status.failed) {
      for (const control of controls) control.disabled = false;
      if (resizePending) void renderView();
    }
  }
}

generate.addEventListener('click', () => void change((Math.imul(seed, 16807) >>> 0) % 99991 + 1), {signal});
era.addEventListener('change', () => void change(seed), {signal});
layout.addEventListener('change', () => void change(seed), {signal});
view.addEventListener('click', () => {
  overhead = !overhead;
  resizePending = true;
  void renderView();
}, {signal});
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  controller.abort();
  observer?.disconnect();
}, {signal});
const first = build();
first.catch(fail);
import('./scene.js').then(async ({openCity}) => {
  scene = await openCity(canvas, first, signal);
  const model = await first;
  signal.throwIfAborted();
  report(model);
  exhibit.dataset.renderer = scene.backend;
  exhibit.dataset.view = 'model';
  observer = new ResizeObserver(() => {
    resizePending = true;
    void renderView();
  });
  observer.observe(canvas);
  for (const control of controls) control.disabled = false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);
