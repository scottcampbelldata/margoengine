import { Engine } from '@margoengine/core';
import { Splats } from '@margoengine/splats';
import { parsePly, parseSplat } from '@margoengine/splats/data';
import { SplatBrush } from '@margoengine/splats/edit';
import { ColorBackground } from '@margoengine/environment';
import { OrbitControls } from '@margoengine/controls/orbit';
import { demoStatus } from 'margo-demo-status';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#scene'), cursor = $('#cursor'), loading = $('#loading'), errorNotice = $('#error'), tools = $('#tools');
const radiusInput = $('#radius'), undoButton = $('#undo'), resetButton = $('#reset'), streamStatus = $('#stream');
const status = demoStatus($('#exhibit'), loading, errorNotice);
const lifetime = new AbortController();
const listen = { signal: lifetime.signal };
const format = new Intl.NumberFormat('en');
// The four cabin views: eye and target in metres of the scan, field of view, and the near clip that opens up the cabin.
const views = {
  front: { eye: [0.84, -0.15, 0.43], target: [0.84, 0.25, -0.58], fov: 62, near: 0.27 },
  controls: { eye: [0.84, -0.6, -0.42], target: [0.84, 0.25, -0.58], fov: 59, near: 0.37 },
  couches: { eye: [0.84, 0.8, -1.62], target: [0.84, -0.4, -0.79], fov: 64, near: 0.46 },
  cutaway: { eye: [2.67, -0.14, -0.88], target: [0.84, 0.09, -0.88], fov: 57, near: 0.85 },
};
// Linear RGB of the three inks.
const inks = { cyan: [0.02, 0.48, 0.67], orange: [0.81, 0.275, 0.046], rose: [0.62, 0.087, 0.208] };
const inkNames = { cyan: 'cyan', orange: 'amber', rose: 'rose' };
const describe = () => ({ look: 'Drag to look around', paint: `Drag to recolor in ${inkNames[ink]}`, erase: 'Drag to erase' })[mode];
let engine, cloud, brush, orbit, frame, observer, detail = null, mode = 'paint', ink = 'cyan', pointer = null;

async function gunzip(url) {
  const response = await fetch(url, { signal: lifetime.signal });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function size() {
  const bounds = canvas.getBoundingClientRect(), density = Math.min(devicePixelRatio, 1.5);
  const width = Math.max(1, Math.round(bounds.width * density)), height = Math.max(1, Math.round(bounds.height * density));
  if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    try {
      const moving = orbit.update(1 / 60);
      engine.render({ delta: 1 / 60 });
      if (moving) schedule();
    } catch (error) { fail(error); }
  });
}

function lookFrom(name) {
  const view = views[name];
  engine.camera.fov = view.fov;
  engine.camera.near = view.near;
  engine.camera.position = [...view.eye];
  engine.camera.target = [...view.target];
  orbit.update(0);
  orbit.saveState();
  schedule();
}

function counters() {
  $('#count').textContent = format.format(cloud.count);
  $('#strokes').textContent = String(brush.strokes);
  undoButton.disabled = resetButton.disabled = brush.strokes === 0;
  document.body.dataset.strokes = String(brush.strokes);
}

// A pointer position as brush pixels of the frame the cloud last drew, with the brush radius from the slider.
function region(x, y) {
  const box = canvas.getBoundingClientRect(), [width, height] = brush.frame;
  const radius = (Number(radiusInput.value) / 200) * Math.min(width, height);
  return { x: ((x - box.left) / box.width) * width, y: ((y - box.top) / box.height) * height, radius };
}

function apply(x, y) {
  const area = region(x, y);
  if (mode === 'erase') brush.erase(area);
  else brush.paint(area, inks[ink], 0.7);
  schedule();
}

function placeCursor(x, y) {
  const box = canvas.getBoundingClientRect(), [width, height] = brush.frame;
  const diameter = (Number(radiusInput.value) / 100) * Math.min(box.width, box.height);
  cursor.style.width = cursor.style.height = `${diameter}px`;
  cursor.style.left = `${x - box.left}px`;
  cursor.style.top = `${y - box.top}px`;
  cursor.hidden = mode === 'look' || width === 0 || height === 0;
}

function setMode(next) {
  mode = next;
  document.body.dataset.mode = mode;
  orbit.enabled = mode === 'look';
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  $('#brush-options').hidden = mode === 'look';
  $('#colors').hidden = mode !== 'paint';
  $('#mode-description').textContent = describe();
  cursor.hidden = true;
}

// The finer scan replaces the opening one once no stroke is held on it, so no edit is lost.
function swapDetail() {
  if (!detail || brush.strokes > 0 || brush.inStroke) return;
  const data = detail;
  detail = null;
  brush.dispose();
  cloud.dispose();
  cloud = Splats.attach(engine, data);
  brush = SplatBrush.attach(engine, cloud, { history: 32 });
  streamStatus.textContent = 'Full scan';
  document.body.dataset.detail = 'true';
  counters();
  schedule();
}

function attachHandlers() {
  canvas.addEventListener('pointerdown', (event) => {
    if (mode === 'look' || event.button !== 0) return;
    pointer = event.pointerId;
    canvas.setPointerCapture(pointer);
    brush.beginStroke();
    apply(event.clientX, event.clientY);
  }, listen);
  canvas.addEventListener('pointermove', (event) => {
    placeCursor(event.clientX, event.clientY);
    if (pointer === event.pointerId && brush.inStroke) apply(event.clientX, event.clientY);
  }, listen);
  const finish = (event) => {
    if (pointer !== event.pointerId) return;
    pointer = null;
    brush.endStroke();
    counters();
    swapDetail();
  };
  canvas.addEventListener('pointerup', finish, listen);
  canvas.addEventListener('pointercancel', finish, listen);
  canvas.addEventListener('pointerleave', () => (cursor.hidden = true), listen);
  canvas.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || mode === 'look') return;
    event.preventDefault();
    const box = canvas.getBoundingClientRect();
    brush.beginStroke();
    apply(box.left + box.width / 2, box.top + box.height / 2);
    brush.endStroke();
    counters();
  }, listen);
  for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => setMode(button.dataset.mode), listen);
  for (const button of document.querySelectorAll('[data-ink]')) {
    button.addEventListener('click', () => {
      ink = button.dataset.ink;
      $('#mode-description').textContent = describe();
      cursor.style.setProperty('--ink', `rgb(${inks[ink].map((c) => Math.round(255 * c ** (1 / 2.2))).join(' ')})`);
      for (const other of document.querySelectorAll('[data-ink]')) other.setAttribute('aria-pressed', String(other === button));
    }, listen);
  }
  radiusInput.addEventListener('input', () => {
    $('#radius-value').textContent = `${radiusInput.value}%`;
    const box = canvas.getBoundingClientRect();
    placeCursor(box.left + box.width / 2, box.top + box.height / 2);
    cursor.hidden = false;
  }, listen);
  $('#view').addEventListener('change', (event) => lookFrom(event.target.value), listen);
  undoButton.addEventListener('click', () => { brush.undo(); counters(); swapDetail(); schedule(); }, listen);
  resetButton.addEventListener('click', () => { brush.reset(); counters(); swapDetail(); schedule(); }, listen);
  orbit.addEventListener('change', schedule);
  observer = new ResizeObserver(() => (size(), schedule()));
  observer.observe(canvas);
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  orbit?.dispose();
  engine?.dispose();
}

function fail(error) {
  if (lifetime.signal.aborted) return;
  console.error(error);
  status.error(error);
  errorNotice.hidden = false;
  loading.hidden = true;
  tools.disabled = true;
  dispose();
}

async function start() {
  const options = { backend: 'webgpu', antialias: false, startupTimeout: 9000, signal: lifetime.signal, camera: { fov: 62, near: 0.27, far: 60 } };
  size();
  const opening = parseSplat(await gunzip(new URL('assets/columbia-opening.splat.gz', document.baseURI).href));
  if (new URLSearchParams(location.search).get('backend') !== 'webgl2') {
    engine = await Engine.create(canvas, options).catch((error) => { if (error?.code !== 'unsupported') throw error; });
  }
  const compatibility = !engine;
  if (compatibility) {
    await (await import('@margoengine/webgl2-compat')).install({ force: true, signal: lifetime.signal });
    engine = await Engine.create(canvas, options);
  }
  engine.onError = fail;
  // A dark studio gradient behind the cabin, so no flat void shows where the scan has gaps.
  ColorBackground.attach(engine, { color: '#2b2d33', bottom: '#0d0e11' });
  cloud = Splats.attach(engine, opening);
  brush = SplatBrush.attach(engine, cloud, { history: 32 });
  orbit = OrbitControls.attach(engine);
  Object.assign(orbit, { enableDamping: true, dampingFactor: 0.12, enablePan: false, enableZoom: false, rotateSpeed: 0.5 });
  orbit.connect(canvas);
  lookFrom('front');
  setMode('paint');
  attachHandlers();
  counters();
  engine.render({ delta: 1 / 60 });
  await engine.gpu.queue.onSubmittedWorkDone();
  if (lifetime.signal.aborted) return;
  tools.disabled = false;
  loading.hidden = true;
  streamStatus.textContent = 'Opening view of 5,600 Gaussians; the full scan is arriving';
  Object.assign(document.body.dataset, { ready: 'true', renderer: compatibility ? 'compatibility' : 'webgpu' });
  status.ready();
  schedule();
  detail = parsePly(await gunzip(new URL('assets/columbia-detail.ply.gz', document.baseURI).href));
  if (lifetime.signal.aborted) return;
  if (brush.strokes > 0 || brush.inStroke) streamStatus.textContent = 'Full scan ready: restore the scan to switch to it';
  swapDetail();
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, listen);
start().catch(fail);
