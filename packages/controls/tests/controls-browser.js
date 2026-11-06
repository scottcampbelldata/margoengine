import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { OrbitControls, TransformControls } from '@margoengine/controls';
import { webglRenderer } from '@margoengine/webgl';
import { ArcballControls, ArcballGizmo } from '@margoengine/controls/arcball';

const state = { errors: [] };
window.controlsState = state;

// Track listeners the controls add to the canvas, so dispose can be verified.
function trackListeners(element) {
  const add = element.addEventListener,
    remove = element.removeEventListener;
  element.addEventListener = function (type, listener, options) {
    this.__tracked ??= new Map();
    if (!this.__tracked.has(type)) this.__tracked.set(type, new Set());
    this.__tracked.get(type).add(listener);
    return add.call(this, type, listener, options);
  };
  element.removeEventListener = function (type, listener, options) {
    this.__tracked?.get(type)?.delete(listener);
    return remove.call(this, type, listener, options);
  };
  return {
    get size() {
      let n = 0;
      for (const set of element.__tracked?.values() ?? []) n += set.size;
      return n;
    },
  };
}
function read(engine) {
  const canvas = engine.canvas,
    copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  const data = context.getImageData(0, 0, copy.width, copy.height).data;
  // A new drawing buffer for the next frame: WebKit answers every read of one buffer in a task from the first read.
  canvas.setAttribute('width', canvas.width);
  return { width: copy.width, height: copy.height, data };
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
  const { width, height, data } = read(engine),
    counts = { yellow: 0, red: 0, green: 0, blue: 0, mesh: 0, other: 0 };
  let mx = 0,
    my = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        k = kind(data[i], data[i + 1], data[i + 2]);
      counts[k]++;
      if (k === 'mesh') {
        mx += x;
        my += y;
      }
    }
  return {
    counts,
    centroid: counts.mesh ? [mx / counts.mesh, my / counts.mesh] : null,
    pixel: (x, y) => {
      const i = (Math.round(y) * width + Math.round(x)) * 4;
      return kind(data[i], data[i + 1], data[i + 2]);
    },
  };
}
function project(engine, point) {
  const camera = engine.camera,
    m = camera.matrix,
    p = [...point, 1],
    c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
  return [((c[0] / c[2] + 1) / 2) * engine.canvas.clientWidth, ((1 - c[1] / c[2]) / 2) * engine.canvas.clientHeight];
}

window.setupOrbit = async () => {
  const canvas = document.getElementById('gpu');
  state.listeners = trackListeners(canvas);
  const engine = (state.engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 6], target: [0, 0, 0] },
  }));
  state.device = engineRuntime(engine).gpu;
  state.device.addEventListener('uncapturederror', (event) => state.errors.push(event.error.message));
  state.device.pushErrorScope('validation');
  state.mesh = engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 0.9 }))
    .setPosition([1.5, 0, 0]);
  state.orbit = new OrbitControls(engine);
  engine.render();
  const rect = canvas.getBoundingClientRect();
  return { left: rect.left, top: rect.top, backend: engine.backend, ...measure() };
};
function measure() {
  const engine = state.engine;
  engine.render({ delta: 1 / 60 });
  const a = analyze(engine);
  return {
    centroid: a.centroid,
    area: a.counts.mesh,
    expected: project(engine, [state.mesh.position.x, state.mesh.position.y, state.mesh.position.z]),
    azimuth: state.orbit?.getAzimuthalAngle(),
    distance: state.orbit?.getDistance(),
    counts: a.counts,
  };
}
window.measure = measure;

window.setupGizmo = () => {
  const { engine, mesh, orbit } = state;
  orbit.reset();
  mesh.setPosition([0, 0, 0]);
  const gizmo = (state.gizmo = new TransformControls(engine));
  gizmo.addEventListener('dragging-changed', (event) => {
    orbit.enabled = !event.value;
  });
  state.draggingEvents = [];
  gizmo.addEventListener('dragging-changed', (event) => state.draggingEvents.push(event.value));
  gizmo.attach(mesh);
  engine.render();
  const f = gizmo.frame(),
    size = f.size,
    arrow = project(engine, [0.6 * size, 0, 0]),
    inside = project(engine, [0.3, 0, 0]);
  gizmo.visible = false;
  const plain = analyze((engine.render(), engine));
  gizmo.visible = true;
  const shown = analyze((engine.render(), engine));
  return {
    size,
    arrow,
    inside,
    insideWithout: plain.pixel(inside[0], inside[1]),
    insideWith: shown.pixel(inside[0], inside[1]),
    countsWith: shown.counts,
    countsWithout: plain.counts,
    pixelsPerUnit: 400 / (2 * 6 * Math.tan(Math.PI / 6)),
  };
};
// Reuse the same gizmo: an axis pointing at the camera is deliberately hidden.
window.gizmoView = (position) => {
  const { engine, gizmo, orbit } = state;
  if (position) engine.camera.position = [...position];
  else orbit.reset();
  engine.render();
  const f = gizmo.frame(),
    shown = analyze(engine),
    zArrow = project(engine, [0, 0, 0.6 * f.size]);
  return {
    counts: shown.counts,
    camera: [...engine.camera.position],
    target: [...engine.camera.target],
    handles: gizmo.handles().map((handle) => handle.name),
    axisDots: f.axes.map((axis) => Math.abs(axis.reduce((sum, value, i) => sum + value * f.eye[i], 0))),
    axis: gizmo.axis,
    dragging: gizmo.dragging,
    mode: gizmo.mode,
    space: gizmo.space,
    visible: gizmo.visible,
    show: [gizmo.showX, gizmo.showY, gizmo.showZ],
    zArrowPixels: [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => shown.pixel(zArrow[0] + dx, zArrow[1] + dy))),
  };
};
// `occlude`: a box in front of the gizmo hides it, and turning the option off draws it on top again.
window.gizmoOcclude = () => {
  const { engine, gizmo, mesh, orbit } = state;
  orbit.reset();
  mesh.setPosition([0, 0, 0]);
  const wall = engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#00ffff' }))
    .setPosition([0, 0, 3])
    .setScale([6, 6, 0.1]);
  gizmo.occlude = true;
  const hidden = analyze((engine.render(), engine)).counts;
  wall.setPosition([0, 0, -3]);
  const open = analyze((engine.render(), engine)).counts;
  wall.setPosition([0, 0, 3]);
  gizmo.occlude = false;
  const onTop = analyze((engine.render(), engine)).counts;
  wall.dispose();
  engine.render();
  return { hidden, open, onTop };
};
// The arcball's rings draw on the real backend, and `autoHide` leaves the frame clean between gestures.
window.arcballGizmo = () => {
  const { engine, gizmo, orbit } = state;
  orbit.reset();
  gizmo.visible = false;
  const arcball = ArcballControls.attach(engine),
    rings = ArcballGizmo.attach(arcball, { autoHide: false, lineWidth: 3 }),
    shown = analyze((engine.render(), engine)).counts;
  rings.autoHide = true;
  const hidden = analyze((engine.render(), engine)).counts;
  rings.dispose();
  arcball.dispose();
  gizmo.visible = true;
  engine.render();
  return { shown, hidden };
};
window.gizmoState = () => {
  const { engine, gizmo, mesh } = state;
  gizmo.visible = true;
  const shown = analyze((engine.render(), engine));
  gizmo.visible = false;
  const plain = analyze((engine.render(), engine));
  gizmo.visible = true;
  engine.render();
  return {
    axis: gizmo.axis,
    dragging: gizmo.dragging,
    position: [mesh.position.x, mesh.position.y, mesh.position.z],
    counts: shown.counts,
    centroid: plain.centroid,
    expected: project(engine, [mesh.position.x, mesh.position.y, mesh.position.z]),
    camera: [...engine.camera.position],
    events: state.draggingEvents,
    orbitEnabled: state.orbit.enabled,
  };
};
window.finish = async () => {
  const { engine, gizmo, orbit } = state;
  const before = state.listeners.size;
  gizmo.dispose();
  orbit.dispose();
  const after = state.listeners.size,
    plugin = engine.hasPlugin(gizmo.pluginName);
  const counts = analyze((engine.render(), engine)).counts;
  const error = await state.device.popErrorScope();
  if (error) state.errors.push(error.message);
  engine.dispose();
  return { before, after, plugin, counts, errors: state.errors };
};

// WebGL2 backend: the same overlay through the GL path.
window.runGL = async () => {
  const canvas = document.getElementById('gl');
  const engine = await Engine.create(canvas, {
    backend: 'webgl2',
    fallback: webglRenderer,
    camera: { position: [0, 0, 6], target: [0, 0, 0] },
  });
  const mesh = engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#ffffff' }));
  const gizmo = new TransformControls(engine);
  gizmo.attach(mesh);
  engine.render();
  const shown = analyze(engine).counts;
  const wall = engine.createMesh().setGeometry(box()).setPosition([0, 0, 3]).setScale([6, 6, 0.1]);
  gizmo.occlude = true;
  engine.render();
  const occluded = analyze(engine).counts;
  gizmo.occlude = false;
  engine.render();
  const onTop = analyze(engine).counts;
  wall.dispose();
  gizmo.dispose();
  engine.render();
  const hidden = analyze(engine).counts;
  engine.dispose();
  return { backend: 'webgl2', shown, hidden, occluded, onTop };
};

// ArcballControls on its own canvas and engine: a grey box at the origin and a red marker on the target plane.
const red = (r, g, b) => r > 170 && g < 110 && b < 110;
function redCentroid(engine) {
  const { width, height, data } = read(engine);
  let n = 0,
    mx = 0,
    my = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (red(data[i], data[i + 1], data[i + 2])) n++, (mx += x), (my += y);
    }
  return n ? [mx / n + 0.5, my / n + 0.5] : null;
}
window.setupArcball = async () => {
  const canvas = document.getElementById('arc');
  const wheels = [];
  // The test's wheel recorder goes on before listener tracking, so only the controls' listeners are counted.
  canvas.addEventListener('wheel', (event) => wheels.push([event.deltaY, event.deltaMode]));
  const arc = (state.arc = { listeners: trackListeners(canvas), wheels });
  const engine = (arc.engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 6], target: [0, 0, 0] },
  }));
  arc.device = engineRuntime(engine).gpu;
  arc.errors = [];
  arc.device.addEventListener('uncapturederror', (event) => arc.errors.push(event.error.message));
  arc.device.pushErrorScope('validation');
  engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#808080', roughness: 0.9 }))
    .setScale([0.8, 0.8, 0.8]);
  arc.marker = engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#ff0000', roughness: 1 }))
    .setScale([0.12, 0.12, 0.01])
    .setPosition([1.1, 0.7, 0]);
  arc.controls = ArcballControls.attach(engine);
  arc.controls.saveState();
  engine.render();
  const rect = canvas.getBoundingClientRect();
  return { left: rect.left, top: rect.top, backend: engine.backend, ...(await arcballState()) };
};
async function arcballState(x, y) {
  const { engine, controls, marker } = state.arc;
  engine.render({ delta: 1 / 60 });
  // Read the image before awaiting the pick: a WebGPU canvas is only readable in the task that rendered it.
  const rendered = redCentroid(engine),
    c = engine.camera,
    m = marker.position,
    pickAt = x === undefined ? null : await engine.pick(x, y);
  return {
    position: [...c.position],
    target: [...c.target],
    up: [...c.up],
    azimuth: Math.atan2(-c.position[0] + c.target[0], c.position[2] - c.target[2]),
    distance: controls.getDistance(),
    marker: project(engine, [m.x, m.y, m.z]),
    redCentroid: rendered,
    picked: pickAt === null ? null : pickAt === marker ? 'marker' : pickAt ? 'other' : 'none',
    wheels: state.arc.wheels,
    state: controls.state,
  };
}
window.arcballState = arcballState;
// World point on the plane through the target facing the camera under CSS pixel (x, y), and a world point's pixel.
window.arcballUnder = ([x, y]) => {
  const { engine } = state.arc,
    c = engine.camera,
    sub = (a, b) => a.map((v, i) => v - b[i]),
    unit = (a) => a.map((v) => v / Math.hypot(...a)),
    forward = unit(sub(c.target, c.position)),
    right = unit([
      forward[1] * c.up[2] - forward[2] * c.up[1],
      forward[2] * c.up[0] - forward[0] * c.up[2],
      forward[0] * c.up[1] - forward[1] * c.up[0],
    ]),
    up = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ],
    w = engine.canvas.clientWidth,
    h = engine.canvas.clientHeight,
    half = Math.hypot(...sub(c.position, c.target)) * Math.tan((c.fov * Math.PI) / 360),
    nx = (x / w) * 2 - 1,
    ny = 1 - (y / h) * 2;
  return c.target.map((v, i) => v + right[i] * nx * half * (w / h) + up[i] * ny * half);
};
window.arcballProject = (point) => (state.arc.engine.render(), project(state.arc.engine, point));
window.arcballReset = (damping = false) => {
  const { controls, engine } = state.arc;
  controls.reset();
  controls.enableDamping = damping;
  state.arc.wheels.length = 0;
  engine.render();
};
// Renders frames of 1/60 s until the camera stops; returns the per-frame motion and the total frames.
window.arcballSettle = () => {
  const { engine } = state.arc,
    c = engine.camera,
    steps = [];
  let previous = [...c.position, ...c.up];
  for (let frame = 0; frame < 3000; frame++) {
    engine.render({ delta: 1 / 60 });
    const now = [...c.position, ...c.up],
      step = Math.hypot(...now.map((v, i) => v - previous[i]));
    previous = now;
    if (!step) break;
    steps.push(step);
  }
  // Ten more frames: nothing left pending.
  const before = [...c.position];
  for (let i = 0; i < 10; i++) engine.render({ delta: 1 / 60 });
  return {
    steps,
    creep: Math.hypot(...c.position.map((v, i) => v - before[i])),
    azimuth: Math.atan2(-c.position[0], c.position[2]),
    distance: state.arc.controls.getDistance(),
  };
};
window.arcballFinish = async () => {
  const { engine, controls, listeners } = state.arc,
    before = listeners.size,
    plugins = () => [...engine.plugins.keys()].filter((name) => name.includes(':arcball:')).length,
    pluginBefore = plugins();
  controls.dispose();
  const error = await state.arc.device.popErrorScope();
  if (error) state.arc.errors.push(error.message);
  return { before, after: listeners.size, pluginBefore, pluginAfter: plugins(), errors: state.arc.errors };
};
window.arcballDisposeEngine = () => state.arc.engine.dispose();
