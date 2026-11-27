import { Colormap, Figure } from '@margoengine/sciviz';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import specimen from './tools/density.json';
import source from './tools/density.bin?url';

const get = id => document.getElementById(id);
const panel = get('status'), reason = get('reason'), help = get('help');
const buttons = ['surface', 'volume', 'left', 'right', 'reset'].map(get);
const ruler = get('bar');
const slider = get('value'), label = get('control-label'), result = get('amount'), effect = get('effect');
let canvas = get('view'), status = demoStatus(canvas, panel, reason);
const lifetime = new AbortController(), { signal } = lifetime;
const defaults = { mode: 'surface', level: .085, opacity: 1, yaw: -36 };
let desired = { ...defaults }, revision = 0, drawn = 0, action = '';
let engine, figure, field, surface, volume, observing, frame, working = false, dirty = false;
const dims = specimen.displayShape, bounds = specimen.displayBoundsAngstrom;
const scale = 2 / bounds[5];
const mapCenter = specimen.sampleCoordinates.map(([first, last], i) =>
  (first + last) * specimen.spacingAngstrom[i] / 8);
const labels = [
  { tag: get('head-mark'), point: [215, 211, 263], side: 1, lift: -38 },
  { tag: get('rotor-mark'), point: [212, 215, 146], side: -1, lift: 29 },
];
for (const mark of labels) {
  const [x, y, z] = mark.point.map((value, i) => (value - mapCenter[i]) * scale);
  mark.world = [x, z, -y];
}
const figureOptions = {
  axes: false,
  controls: false,
  aspect: [bounds[1] / bounds[5], bounds[3] / bounds[5], 1],
  limits: bounds,
  signal,
};

const ink = [
  [0, [.20, .34, .59]],
  [.25, [.42, .52, .78]],
  [.57, [.75, .53, .63]],
  [.83, [1, .80, .58]],
  [1, [1, .95, .79]],
];
const map = new Colormap('Microscope', 'sequential', t => {
  const high = ink.findIndex(([point]) => point >= t);
  if (high <= 0) return ink[0][1];
  const [left, a] = ink[high - 1], [right, b] = ink[high];
  const f = (t - left) / (right - left);
  return a.map((v, i) => v + (b[i] - v) * f);
});

applyQualityTier();

async function loadField() {
  const response = await fetch(source, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok || !response.body) throw new Error('The density grid could not be downloaded.');
  const data = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const count = dims[0] * dims[1] * dims[2];
  if (data.length !== 2 * count) throw new Error('The density grid has an unexpected sample count.');
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const encoded = data[i] | (data[count + i] << 8);
    values[i] = ((encoded << 16) >> 16) / specimen.integerScale;
  }
  return values;
}

function fail(error) {
  if (status.failed || signal.aborted) return;
  status.error(error);
  const unsupported = error?.code === 'unsupported';
  panel.querySelector('strong').textContent = unsupported ?
    'The microscope needs WebGPU or full WebGL2.' : 'The microscope could not open.';
  help.hidden = !unsupported;
  panel.hidden = false;
  for (const control of [...buttons, slider]) control.disabled = true;
}

function labelSpecimen(yaw, height) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const cameraLength = Math.hypot(.665, 4.2);
  const right = [c, 0, -s];
  const up = [-s * .665 / cameraLength, 4.2 / cameraLength, -c * .665 / cameraLength];
  const dot = (a, b) => a.reduce((total, value, i) => total + value * b[i], 0);
  for (const { tag, world, side, lift } of labels) {
    const relative = [world[0], world[1] + .025, world[2]];
    const x = w / 2 + h * dot(relative, right) / height;
    const y = h / 2 - h * dot(relative, up) / height;
    tag.hidden = false;
    const text = tag.querySelector('span');
    const labelWidth = text.offsetWidth;
    const tagX = side === 1 ? w / 2 + Math.min(w * .24, h * .29) :
      w / 2 - Math.min(w * .24, h * .29) - labelWidth;
    const labelX = Math.min(w - labelWidth - 13, Math.max(13, tagX));
    const labelY = y + lift;
    const dx = side === 1 ? x - labelX + 6 : x - labelX - labelWidth - 6;
    text.style.left = '0px';
    tag.style.left = labelX + 'px';
    tag.style.top = labelY + 'px';
    const leader = tag.querySelector('i');
    leader.style.left = (side === 1 ? -6 : labelWidth + 6) + 'px';
    leader.style.setProperty('--length', Math.hypot(dx, lift) + 'px');
    leader.style.setProperty('--turn', Math.atan2(-lift, dx) + 'rad');
  }
}

function camera(yaw) {
  const cam = engine.camera;
  const angle = yaw * Math.PI / 180;
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const height = Math.max(2.29, 1.72 / aspect);
  const depth = cam.far - cam.near;
  cam.target = [0, -.025, 0];
  cam.position = [Math.sin(angle) * 4.2, .64, Math.cos(angle) * 4.2];
  cam.project = (out, ratio, reverseZ) => {
    out[0] = 2 / (height * ratio);
    out[5] = 2 / height;
    out[10] = reverseZ ? 1 / depth : -2 / depth;
    out[14] = reverseZ ? cam.far / depth : -(cam.far + cam.near) / depth;
    out[15] = 1;
  };
  ruler.style.width = 50 * scale * canvas.clientHeight / height + 'px';
  labelSpecimen(angle, height);
}

function makeVolume() {
  return figure.volume(field, {
    dims, bounds,
    range: [.036, .36],
    colormap: map,
    opacity: [[0, 0], [.08, 0], [.20, .046], [.39, .144], [.68, .34], [1, .52]],
    quality: 1.45,
    shading: true,
  });
}

function readout() {
  const solid = desired.mode === 'surface';
  get('surface').setAttribute('aria-pressed', String(solid));
  get('volume').setAttribute('aria-pressed', String(!solid));
  slider.min = solid ? '.055' : '.30';
  slider.max = solid ? '.185' : '1.85';
  slider.step = solid ? '.005' : '.05';
  slider.value = String(solid ? desired.level : desired.opacity);
  label.textContent = solid ? 'Contour level' : 'Volume opacity';
  get('density-key').hidden = solid;
  const value = solid ? desired.level.toFixed(3) : Math.round(desired.opacity * 100) + '%';
  result.textContent = value;
  slider.setAttribute('aria-valuetext', value);
  effect.textContent = solid ? 'Raise the level to leave only the strongest density.' :
    'Increase the opacity to make the same density cloud more solid.';
}

function schedule() {
  dirty = true;
  if (frame === undefined && !working && !signal.aborted && !status.failed) frame = requestAnimationFrame(draw);
}

function change(patch, name) {
  desired = { ...desired, ...patch };
  revision++;
  action = name;
  readout();
  schedule();
}

async function complete(snapshot, trigger, update) {
  camera(snapshot.yaw);
  engine.render({ delta: 0 });
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  canvas.dataset.mode = snapshot.mode;
  canvas.dataset.level = surface.level.toFixed(3);
  canvas.dataset.opacity = (volume?.density ?? defaults.opacity).toFixed(2);
  canvas.dataset.yaw = String(Math.round(snapshot.yaw));
  canvas.dataset.triangles = String(surface.triangles);
  canvas.dataset.revision = String(update);
  canvas.dataset.action = trigger;
  if (update > drawn && !performance.getEntriesByName('microscope-first-input').length)
    performance.mark('microscope-first-input');
  drawn = update;
}

async function draw() {
  frame = undefined;
  if (!dirty || signal.aborted || status.failed) return;
  dirty = false;
  working = true;
  try {
    const snapshot = desired, update = revision, trigger = action;
    const solid = snapshot.mode === 'surface';
    if (solid && snapshot.level !== surface.level) await surface.update(snapshot.level, { signal });
    if (!solid && !volume) {
      volume = makeVolume();
      await figure.ready();
    }
    if (update !== revision) return;
    surface.visible = solid;
    if (volume) {
      volume.visible = !solid;
      volume.density = snapshot.opacity;
    }
    await complete(snapshot, trigger, update);
  } catch (error) {
    fail(error);
  } finally {
    working = false;
    if (dirty) schedule();
  }
}

function connect() {
  const on = (node, type, callback) => node.addEventListener(type, callback, { signal });
  on(slider, 'input', () => change(desired.mode === 'surface' ?
    { level: Number(slider.value) } : { opacity: Number(slider.value) }, 'slider'));
  for (const mode of ['surface', 'volume']) on(get(mode), 'click', () => change({ mode }, mode));
  on(get('left'), 'click', () => change({ yaw: desired.yaw - 35 }, 'rotate'));
  on(get('right'), 'click', () => change({ yaw: desired.yaw + 35 }, 'rotate'));
  on(get('reset'), 'click', () => change(defaults, 'reset'));
  let pointer, previous;
  on(canvas, 'pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    pointer = event.pointerId;
    previous = event.clientX;
    canvas.setPointerCapture(pointer);
  });
  on(canvas, 'pointermove', event => {
    if (event.pointerId !== pointer) return;
    const delta = event.clientX - previous;
    previous = event.clientX;
    if (delta !== 0) change({ yaw: desired.yaw - delta * .58 }, 'rotate');
  });
  on(canvas, 'lostpointercapture', () => { pointer = undefined; });
  observing = new ResizeObserver(schedule);
  observing.observe(canvas);
}

async function open() {
  const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const known = force || !navigator.gpu;
  const openFigure = async () => {
    if (!known) {
      try {
        return await Figure.create(canvas, figureOptions);
      } catch (error) {
        if (error?.code !== 'unsupported') throw error;
        const replacement = canvas.cloneNode();
        canvas.replaceWith(replacement);
        canvas = replacement;
        status = demoStatus(canvas, panel, reason);
      }
    }
    const { openCompatibility } = await import('./compatibility.js');
    return openCompatibility(canvas, figureOptions);
  };
  await Promise.all([
    loadField().then(values => { field = values; }),
    openFigure().then(value => {
      signal.throwIfAborted();
      figure = value;
      engine = figure.engine;
      engine.stop();
      engine.onError = fail;
      void figure.renderer.compute().catch(fail);
    }),
  ]);
  engine.scene.background = '#181c2a';
  engine.camera.near = .08;
  engine.camera.far = 28;
  const kind = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu';
  surface = await figure.isosurface(field, desired.level, { dims, bounds, color: '#d7ba9d', signal });
  await figure.ready();
  await complete(desired, '', 0);
  if (status.failed) return;
  canvas.dataset.renderer = kind;
  for (const control of [...buttons, slider]) control.disabled = false;
  readout();
  connect();
  panel.hidden = true;
  performance.mark('margo-first-usable-frame');
  status.ready();
}

window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  lifetime.abort();
  observing?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  figure?.dispose();
});
open().catch(fail);
