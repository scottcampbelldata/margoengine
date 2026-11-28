import { Engine } from '@margoengine/core';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { PointStyle } from '@margoengine/points/style';
import { histogram } from '@margoengine/sciviz';
import { OrbitControls } from '@margoengine/controls/orbit';
import { fetchPointSources, galacticOfDirection, nearInfraredColor, pointSourceLook } from '@margoengine/sky/milky-way';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { Tonemap } from '@margoengine/tonemap';
import { demoStatus } from 'margo-demo-status';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#sky'), loading = $('#loading'), errorNotice = $('#error'), controls = $('#controls');
const field = $('#field'), bars = $('#histogram'), progress = $('#progress'), streamStatus = $('#stream-status');
const status = demoStatus($('#exhibit'), loading, errorNotice);
const lifetime = new AbortController();
// The nine catalogue chunks: the 8,192 brightest sources first, then the rest in Ks order of the extract.
const chunks = Array.from({ length: 9 }, (_, i) => `assets/psc-0${i}.bin.gz`);
// J-Ks bins of 0.1 mag from -0.4 to 2.3; the outer two take the tails.
const bins = 27, low = -0.4, step = 0.1;
// Ks magnitude drawn at full light, the flux stretch and the point sizes, in CSS pixels.
const look = { referenceMagnitude: 6, compression: 0.5, brightness: 0.45, minSize: 0.7, sizeRange: 2.2, saturation: 1.8 };
const counts = new Float64Array(bins), clouds = [];
let engine, points, orbit, frame, observer, loaded = 0, brush = null, anchor = -1;
const format = new Intl.NumberFormat('en');

function size() {
  const bounds = canvas.getBoundingClientRect(), density = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * density));
  canvas.height = Math.max(1, Math.round(bounds.height * density));
}

function lookAt(longitude) {
  // The eye sits a hair from the centre of the sky sphere and looks back through it: -z is the galactic centre.
  engine.camera.target = [0, 0, 0];
  engine.camera.position = longitude === 0 ? [0, 0, 0.001] : [0, 0, -0.001];
  orbit.update(0);
  schedule();
}

function showCoordinates() {
  const [px, py, pz] = engine.camera.position;
  const { l, b } = galacticOfDirection([-px, -py, -pz]);
  $('#coordinates').textContent = `${l.toFixed(1).padStart(5, '0')}° / ${b >= 0 ? '+' : '−'}${Math.abs(b).toFixed(1)}°`;
}

function draw() {
  frame = undefined;
  const moving = orbit.update(1 / 60);
  showCoordinates();
  engine.render({ delta: 1 / 60 });
  if (moving) schedule();
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame(() => {
    try { draw(); } catch (error) { fail(error); }
  });
}

// The brushed J-Ks range as a points style filter; the outer bins reach out to the tails.
function range() {
  if (!brush) return null;
  const [a, b] = brush;
  return [a === 0 ? -Infinity : low + a * step, b === bins - 1 ? Infinity : low + (b + 1) * step];
}

function applyBrush() {
  const span = range();
  let selected = 0;
  for (const { cloud, table } of clouds) {
    if (!span) { cloud.setMask(null); continue; }
    const { show } = new PointStyle({ filter: { ranges: { colorIndex: span } } }).evaluate(table);
    for (const value of show) selected += value;
    cloud.setMask(show, { mode: 'fade', fade: 0.06 });
  }
  bars.dataset.brushed = String(!!span);
  for (const [i, bar] of [...bars.children].entries()) bar.setAttribute('aria-pressed', String(!span || (i >= brush[0] && i <= brush[1])));
  $('#range').textContent = span ? `${span[0] === -Infinity ? '< ' + (low + step).toFixed(1) : span[0].toFixed(1)} to ${span[1] === Infinity ? '> ' + (low + (bins - 1) * step).toFixed(1) : span[1].toFixed(1)} mag` : 'All colors';
  $('#selected').textContent = span ? format.format(selected) : '—';
  document.body.dataset.selected = String(span ? selected : loaded);
  schedule();
}

function showCounts() {
  const top = Math.max(...counts);
  for (const [i, bar] of [...bars.children].entries()) {
    bar.style.setProperty('--bar-height', `${(100 * counts[i]) / top}%`);
    bar.setAttribute('aria-label', `J − Ks ${(low + i * step).toFixed(1)} to ${(low + (i + 1) * step).toFixed(1)}: ${format.format(counts[i])} sources`);
  }
}

function buildBars() {
  for (let i = 0; i < bins; i++) {
    const bar = document.createElement('button');
    const [r, g, b] = nearInfraredColor(low + (i + 0.5) * step, look.saturation);
    Object.assign(bar, { type: 'button', className: 'hist-bar' });
    bar.style.setProperty('--bar-color', `color(srgb-linear ${r} ${g} ${b})`);
    bar.setAttribute('aria-pressed', 'true');
    bars.append(bar);
  }
  const listen = { signal: lifetime.signal };
  const binAt = (event) => [...bars.children].indexOf(document.elementFromPoint(event.clientX, event.clientY));
  bars.addEventListener('pointerdown', (event) => {
    const i = binAt(event);
    if (i < 0) return;
    anchor = i;
    brush = [i, i];
    bars.setPointerCapture(event.pointerId);
    applyBrush();
  }, listen);
  bars.addEventListener('pointermove', (event) => {
    const i = binAt(event);
    if (anchor < 0 || i < 0) return;
    brush = [Math.min(anchor, i), Math.max(anchor, i)];
    applyBrush();
  }, listen);
  bars.addEventListener('pointerup', () => (anchor = -1), listen);
  bars.addEventListener('keydown', (event) => {
    const i = [...bars.children].indexOf(document.activeElement);
    if (i < 0) return;
    const next = event.key === 'ArrowLeft' ? i - 1 : event.key === 'ArrowRight' ? i + 1 : i;
    if (next !== i && next >= 0 && next < bins) {
      event.preventDefault();
      bars.children[next].focus();
      if (event.shiftKey) {
        brush = brush ? [Math.min(brush[0], next), Math.max(brush[1], next)] : [Math.min(i, next), Math.max(i, next)];
        applyBrush();
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      brush = [i, i];
      applyBrush();
    }
  }, listen);
}

async function addChunk(url) {
  const sources = await fetchPointSources(url, { radius: 40, signal: lifetime.signal });
  const { colors, sizes } = pointSourceLook(sources, look);
  const cloud = points.add(new PointCloud({
    positions: sources.positions, colors, sizes, colorFormat: 'float',
    material: { size: 1, shape: 'round', transparent: true, blending: 'additive', depthWrite: false },
  }));
  const table = { colorIndex: sources.colorIndex };
  clouds.push({ cloud, table });
  const { counts: chunkCounts } = histogram(sources.colorIndex.map((v) => Math.min(low + bins * step - 1e-4, Math.max(low, v))), { bins, range: [low, low + bins * step] });
  chunkCounts.forEach((n, i) => (counts[i] += n));
  loaded += sources.count;
  $('#count').textContent = format.format(loaded);
  progress.value = loaded;
  document.body.dataset.sources = String(loaded);
  showCounts();
  if (brush) applyBrush();
  schedule();
}

async function stream() {
  for (let i = 1; i < chunks.length; i++) {
    streamStatus.textContent = `Adding fainter sources, part ${i + 1} of ${chunks.length}…`;
    await addChunk(new URL(chunks[i], document.baseURI).href);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  streamStatus.textContent = '2MASS Point Source Catalog, one million sources';
  document.body.dataset.complete = 'true';
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
  controls.disabled = true;
  dispose();
}

async function start() {
  const options = { backend: 'webgpu', exactSize: true, antialias: true, startupTimeout: 9000, signal: lifetime.signal, background: '#010205', camera: { fov: Number(field.value), near: 0.0005, far: 100 } };
  size();
  if (new URLSearchParams(location.search).get('backend') !== 'webgl2') {
    engine = await Engine.create(canvas, options).catch((error) => { if (error?.code !== 'unsupported') throw error; });
  }
  const compatibility = !engine;
  if (compatibility) {
    await (await import('@margoengine/webgl2-compat')).install({ force: true, signal: lifetime.signal });
    engine = await Engine.create(canvas, options);
  }
  engine.onError = fail;
  points = PointsPlugin.attach(engine, { pointBudget: 1_000_000 });
  // Bloom gathers the dense star clouds of the plane into a glow; AgX keeps the bright stars' colour as they clip.
  PostStack.attach(engine, [new Bloom({ strength: 0.35, radius: 0.6 }), new Tonemap({ curve: 'agx', exposure: 1, contrast: 1.15, vignette: 0.2 })]);
  orbit = OrbitControls.attach(engine);
  Object.assign(orbit, { enableDamping: true, dampingFactor: 0.12, enablePan: false, enableZoom: false, rotateSpeed: -0.35 });
  orbit.connect(canvas);
  buildBars();
  await addChunk(new URL(chunks[0], document.baseURI).href);
  // Open a little east of the centre, so the bulge sits right of the frame and the plane runs into the distance.
  lookAt(0);
  orbit.rotateLeft(-0.3);
  orbit.rotateUp(-0.06);
  orbit.saveState();
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  if (lifetime.signal.aborted) return;

  const listen = { signal: lifetime.signal };
  field.addEventListener('input', () => {
    engine.camera.fov = Number(field.value);
    $('#field-value').textContent = `${field.value}°`;
    schedule();
  }, listen);
  $('#center').addEventListener('click', () => lookAt(0), listen);
  $('#anticenter').addEventListener('click', () => lookAt(180), listen);
  $('#clear').addEventListener('click', () => ((brush = null), applyBrush()), listen);
  canvas.addEventListener('keydown', (event) => {
    const turn = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[event.key];
    if (!turn) return;
    event.preventDefault();
    orbit.rotateLeft(turn[0]);
    orbit.rotateUp(turn[1]);
    schedule();
  }, listen);
  orbit.addEventListener('change', schedule);
  for (const type of ['pointerdown', 'pointermove']) canvas.addEventListener(type, schedule, listen);
  observer = new ResizeObserver(() => (size(), schedule()));
  observer.observe(canvas);
  controls.disabled = false;
  loading.hidden = true;
  Object.assign(document.body.dataset, { ready: 'true', renderer: compatibility ? 'compatibility' : 'webgpu' });
  status.ready();
  await stream();
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);
