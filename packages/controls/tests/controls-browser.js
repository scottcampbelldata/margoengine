import {Engine, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {OrbitControls, TransformControls} from '@margoengine/controls';

const state = {errors: []};
window.controlsState = state;

// Track listeners the controls add to the canvas, so dispose can be verified.
function trackListeners(element) {
  const add = element.addEventListener, remove = element.removeEventListener;
  element.addEventListener = function (type, listener, options) {this.__tracked ??= new Map(); if (!this.__tracked.has(type)) this.__tracked.set(type, new Set()); this.__tracked.get(type).add(listener); return add.call(this, type, listener, options);};
  element.removeEventListener = function (type, listener, options) {this.__tracked?.get(type)?.delete(listener); return remove.call(this, type, listener, options);};
  return {get size() {let n = 0; for (const set of element.__tracked?.values() ?? []) n += set.size; return n;}};
}
function read(engine) {
  const canvas = engine.canvas, copy = document.createElement('canvas');
  copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
  return {width: copy.width, height: copy.height, data: context.getImageData(0, 0, copy.width, copy.height).data};
}
const kind = (r, g, b) => {
  if (r > 200 && g > 200 && b < 90) return 'yellow';
  if (r > 170 && g < 110 && b < 110) return 'red';
  if (g > 170 && r < 140 && b < 140) return 'green';
  if (b > 170 && r < 140 && g < 190 && b > r + 60) return 'blue';
  if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 40) return 'mesh';
  return 'other';
};
function analyze(engine) {
  const {width, height, data} = read(engine), counts = {yellow: 0, red: 0, green: 0, blue: 0, mesh: 0, other: 0};
  let mx = 0, my = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, k = kind(data[i], data[i + 1], data[i + 2]);
    counts[k]++;
    if (k === 'mesh') {mx += x; my += y;}
  }
  return {counts, centroid: counts.mesh ? [mx / counts.mesh, my / counts.mesh] : null, pixel: (x, y) => {const i = (Math.round(y) * width + Math.round(x)) * 4; return kind(data[i], data[i + 1], data[i + 2]);}};
}
function project(engine, point) {
  const camera = engine.camera, m = camera.matrix, p = [...point, 1], c = [0, 1, 3].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
  return [(c[0] / c[2] + 1) / 2 * engine.canvas.clientWidth, (1 - c[1] / c[2]) / 2 * engine.canvas.clientHeight];
}

window.setupOrbit = async () => {
  const canvas = document.getElementById('gpu');
  state.listeners = trackListeners(canvas);
  const engine = state.engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 6], target: [0, 0, 0]}});
  state.device = engineRuntime(engine).gpu;
  state.device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
  state.device.pushErrorScope('validation');
  state.mesh = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#ffffff', roughness: 0.9})).setPosition([1.5, 0, 0]);
  state.orbit = new OrbitControls(engine);
  engine.render();
  const rect = canvas.getBoundingClientRect();
  return {left: rect.left, top: rect.top, backend: engine.backend, ...measure()};
};
function measure() {
  const engine = state.engine; engine.render({delta: 1 / 60});
  const a = analyze(engine);
  return {centroid: a.centroid, area: a.counts.mesh, expected: project(engine, [state.mesh.position.x, state.mesh.position.y, state.mesh.position.z]),
    azimuth: state.orbit?.getAzimuthalAngle(), distance: state.orbit?.getDistance(), counts: a.counts};
}
window.measure = measure;

window.setupGizmo = () => {
  const {engine, mesh, orbit} = state;
  orbit.reset();
  mesh.setPosition([0, 0, 0]);
  const gizmo = state.gizmo = new TransformControls(engine);
  gizmo.addEventListener('dragging-changed', event => {orbit.enabled = !event.value;});
  state.draggingEvents = [];
  gizmo.addEventListener('dragging-changed', event => state.draggingEvents.push(event.value));
  gizmo.attach(mesh);
  engine.render();
  const f = gizmo.frame(), size = f.size, arrow = project(engine, [0.6 * size, 0, 0]), inside = project(engine, [0.3, 0, 0]);
  gizmo.visible = false; const plain = analyze((engine.render(), engine)); gizmo.visible = true;
  const shown = analyze((engine.render(), engine));
  return {size, arrow, inside, insideWithout: plain.pixel(inside[0], inside[1]), insideWith: shown.pixel(inside[0], inside[1]), countsWith: shown.counts, countsWithout: plain.counts, pixelsPerUnit: 400 / (2 * 6 * Math.tan(Math.PI / 6))};
};
window.gizmoState = () => {
  const {engine, gizmo, mesh} = state;
  gizmo.visible = true; const shown = analyze((engine.render(), engine));
  gizmo.visible = false; const plain = analyze((engine.render(), engine)); gizmo.visible = true; engine.render();
  return {axis: gizmo.axis, dragging: gizmo.dragging, position: [mesh.position.x, mesh.position.y, mesh.position.z], counts: shown.counts, centroid: plain.centroid,
    expected: project(engine, [mesh.position.x, mesh.position.y, mesh.position.z]), camera: [...engine.camera.position], events: state.draggingEvents, orbitEnabled: state.orbit.enabled};
};
window.finish = async () => {
  const {engine, gizmo, orbit} = state;
  const before = state.listeners.size;
  gizmo.dispose(); orbit.dispose();
  const after = state.listeners.size, plugin = engine.hasPlugin(gizmo.pluginName);
  const counts = analyze((engine.render(), engine)).counts;
  const error = await state.device.popErrorScope();
  if (error) state.errors.push(error.message);
  engine.dispose();
  return {before, after, plugin, counts, errors: state.errors};
};

// WebGL2 backend: the same overlay through the GL path.
window.runGL = async () => {
  const canvas = document.getElementById('gl');
  const engine = await Engine.create(canvas, {backend: 'webgl2', camera: {position: [0, 0, 6], target: [0, 0, 0]}});
  const mesh = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#ffffff'}));
  const gizmo = new TransformControls(engine); gizmo.attach(mesh);
  engine.render(); const shown = analyze(engine).counts;
  gizmo.dispose(); engine.render(); const hidden = analyze(engine).counts;
  engine.dispose();
  return {backend: 'webgl2', shown, hidden};
};
