import { applyQualityTier } from '@margoengine/quality';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { readDisplayMesh } from './display-mesh.mjs';
import { createStage } from './stage.js';
import { dimensions, boreChord, sectionLimit } from './dimensions.mjs';
import manifest from './engine-block.json';

const canvas = document.querySelector('#block');
const loading = document.querySelector('#status');
const status = demoStatus(document.body, loading);
const slider = document.querySelector('#section');
const depth = document.querySelector('#depth');
const sectionState = document.querySelector('#view-state');
const whole = document.querySelector('#whole');
const centre = document.querySelector('#centre');
const download = document.querySelector('#download');
const verify = document.querySelector('#verify');
const fileStatus = document.querySelector('#file-status');
const boreButtons = [...document.querySelectorAll('[data-bore]')];
const controls = [slider, whole, centre, download, verify, ...boreButtons];
const controller = new AbortController();
const { signal } = controller;
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const quality = applyQualityTier();
const bufferURL = new URL('./engine-block.bin', import.meta.url);
const sourceURL = new URL('./engine-block.step', import.meta.url);
let engine, stage, observer, frame, previous, stepPromise;
let selected = 0, shownDepth = sectionLimit;
let requestedDepth = sectionLimit, viewTime = 0;

const millimetres = value => (value * 1000).toFixed(1) + ' mm';
function fail(error) {
  status.error(error);
  loading.hidden = false;
  for (const control of controls) control.disabled = true;
  if (frame !== undefined) cancelAnimationFrame(frame);
}

function prepareSize() {
  const ratio = Math.min(devicePixelRatio, quality === 'high' ? 1.6 : 1.5);
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return width / height;
}

function fitCamera() {
  const aspect = prepareSize();
  engine.camera.fov = Math.max(33, Math.min(53, 45 / Math.sqrt(aspect)));
}

function drawSection(value) {
  const measured = stage.setSection(value);
  const full = value === sectionLimit;
  const chord = boreChord(value / 1000);
  shownDepth = value;
  depth.textContent = full ? 'Open' : (value > 0 ? '+' : '') + value + ' mm';
  slider.setAttribute('aria-valuetext', full ? 'Whole casting' : value + ' millimetres from the centreline');
  sectionState.textContent = full ? 'Complete casting' : measured ? 'Longitudinal cut' : 'Plane outside casting';
  document.querySelector('#chord').textContent = full ? '—' : chord > 0 ? millimetres(chord) : 'Outside bores';
  whole.setAttribute('aria-pressed', String(full));
  centre.setAttribute('aria-pressed', String(value === 0));
  document.body.dataset.sectionActive = String(!full);
  document.body.dataset.sectionDepth = String(value);
  document.body.dataset.capArea = String(measured);
}

function queueFrame(duration = 0) {
  viewTime = Math.max(viewTime, duration);
  if (frame === undefined) frame = requestAnimationFrame(tick);
}

function tick(now) {
  frame = undefined;
  if (signal.aborted || status.failed) return;
  const seconds = previous === undefined ? 0 : Math.max(0, Math.min(.065, (now - previous) / 1000));
  previous = now;
  const sectionChanged = shownDepth !== requestedDepth;
  try {
    if (sectionChanged) drawSection(requestedDepth);
    engine.render(seconds);
    if (sectionChanged && !performance.getEntriesByName('engine-block-first-section-frame').length) {
      performance.mark('engine-block-first-section-frame');
    }
  } catch (error) {
    fail(error);
    return;
  }
  viewTime = Math.max(0, viewTime - seconds);
  if (viewTime > 0) queueFrame();
  else previous = undefined;
}

function chooseBore(index) {
  selected = index === selected ? 0 : index;
  stage.setBore(selected);
  queueFrame();
  for (const button of boreButtons) button.setAttribute('aria-pressed', String(Number(button.dataset.bore) === selected));
  document.body.dataset.selectedBore = String(selected);
}

async function fetchAsset(url, method) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Could not load the casting asset (' + response.status + ').');
  return response[method]();
}

function loadSTEP() {
  if (!stepPromise) {
    stepPromise = Promise.all([fetchAsset(sourceURL, 'text'), import('@margoengine/brep')])
      .then(([source, { model, parseSTEP }]) => {
        const parsed = model.bodiesFromSTEP(parseSTEP(source));
        const solid = parsed.bodies[0];
        if (parsed.bodies.length !== 1 || parsed.problems.length || solid.kind !== 'solid' ||
            model.checkBody(solid).length || solid.faces.length !== manifest.faces ||
            Math.abs(model.massProperties(solid).volume - manifest.volume) > 1e-9) {
          throw new Error('The exact model did not resolve to the authored casting.');
        }
        return { written: model.bodiesToSTEP([solid]), model, parseSTEP };
      })
      .catch(error => {
        stepPromise = undefined;
        throw error;
      });
  }
  return stepPromise;
}

async function withFile(task) {
  download.disabled = verify.disabled = true;
  delete fileStatus.dataset.error;
  try {
    await task();
  } catch (error) {
    fileStatus.dataset.error = 'true';
    fileStatus.textContent = error.message ?? String(error);
  } finally {
    if (!signal.aborted && !status.failed) download.disabled = verify.disabled = false;
  }
}

function save() {
  return withFile(async () => {
    fileStatus.textContent = 'Writing exact STEP geometry…';
    const { written } = await loadSTEP();
    const url = URL.createObjectURL(new Blob([written], { type: 'application/step' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'margo-inline-four.step';
    document.body.append(link);
    link.click();
    link.remove();
    fileStatus.textContent = 'Downloaded · AP214 · One solid';
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function validateSTEP() {
  return withFile(async () => {
    fileStatus.textContent = 'Reading exact STEP geometry…';
    const { written, model, parseSTEP } = await loadSTEP();
    const restored = model.bodiesFromSTEP(parseSTEP(written));
    const solid = restored.bodies[0];
    const volume = solid && model.massProperties(solid).volume;
    if (restored.bodies.length !== 1 || restored.problems.length || solid.kind !== 'solid' ||
        model.checkBody(solid).length || Math.abs(volume - manifest.volume) > 1e-9 ||
        solid.faces.length !== manifest.faces) {
      throw new Error('The STEP round trip changed the casting.');
    }
    const display = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(volume * 1e6);
    fileStatus.textContent = 'Verified · 1 solid · ' + solid.faces.length + ' faces · ' + display + ' cm³';
    document.body.dataset.stepVerified = 'true';
  });
}

function connect() {
  const listen = (target, event, fn, options = {}) => target.addEventListener(event, fn, { ...options, signal });
  const sectionTo = value => {
    requestedDepth = Number(value);
    queueFrame();
  };
  listen(slider, 'input', () => sectionTo(slider.value));
  listen(whole, 'click', () => { slider.value = sectionLimit; sectionTo(slider.value); });
  listen(centre, 'click', () => { slider.value = 0; sectionTo(slider.value); });
  for (const button of boreButtons) listen(button, 'click', () => chooseBore(Number(button.dataset.bore)));
  listen(download, 'click', save);
  listen(verify, 'click', validateSTEP);
  const cube = stage.cube.element;
  const rotate = () => queueFrame(.34);
  listen(cube, 'click', rotate, { capture: true });
  listen(cube, 'keydown', rotate, { capture: true });
  listen(cube, 'pointermove', event => { if (event.buttons & 1) queueFrame(); }, { capture: true });
  listen(cube, 'pointerup', rotate, { capture: true });
  observer = new ResizeObserver(() => { fitCamera(); queueFrame(); });
  observer.observe(canvas);
}

async function open() {
  const meshReady = fetchAsset(bufferURL, 'arrayBuffer').then(readDisplayMesh);
  const loadCompat = async () => {
    const compat = await import('@margoengine/webgl2-compat');
    return { install: () => compat.install({ force: forced, signal }) };
  };
  await autoEngine(canvas, async current => {
    engine = current;
    const mesh = await meshReady;
    engine.camera.position = [.232,.520,.665];
    engine.camera.target = [0,.137,0];
    fitCamera();
    stage = createStage(engine, mesh);
    drawSection(sectionLimit);
    engine.render(0);
    await engine.gpu.queue.onSubmittedWorkDone();
  }, {
    backend: forced ? 'webgl2' : undefined, loadCompat, signal,
    startupTimeout: 5000, exactSize: true, antialias: true,
    camera: { near: .015, far: 5, fov: 34 },
  });
  if (signal.aborted || status.failed) return;
  engine.onError = fail;
  connect();
  for (const control of controls) control.disabled = false;
  document.querySelector('#diameter').textContent = 'Ø' + millimetres(dimensions.boreRadius * 2);
  document.querySelector('#pitch').textContent = millimetres(dimensions.pitch);
  document.querySelector('#shell').textContent = millimetres(dimensions.shellWall);
  document.body.dataset.renderer = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu';
  document.body.dataset.quality = quality;
  document.body.dataset.triangles = String(manifest.triangles);
  status.ready();
  loading.hidden = true;
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide', event => {
  if (event.persisted) return;
  controller.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
});
open().catch(error => { if (!signal.aborted) fail(error); });