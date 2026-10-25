// Margo implementation of the parity control scenes (../parity.js, area 'controls'): @margoengine/controls driven by
// synthetic pointer and wheel events on the harness canvas, so each control does its real event and update work.
import { Camera } from '@margoengine/core';
import { app, engineFor, floor, meshes, palette } from '../margo.js';

const W = 1280,
  H = 720;

/** Dispatches a mouse PointerEvent at canvas pixel (x, y). */
export function pointer(canvas, type, x, y, buttons = 1) {
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : buttons,
      clientX: r.left + x,
      clientY: r.top + y,
    }),
  );
}
export function wheel(canvas, x, y, deltaY) {
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode: 0,
      clientX: r.left + x,
      clientY: r.top + y,
    }),
  );
}
/** Screen pixel of world point p for a camera {fov, at, target} (y up), as both engines project it. */
export function project(c, p, t = 0) {
  const eye = c.at(t),
    norm = (v) => {
      const l = Math.hypot(...v);
      return v.map((x) => x / l);
    },
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    f = norm(c.target.map((v, i) => v - eye[i])),
    r = norm(cross(f, [0, 1, 0])),
    u = cross(r, f),
    d = p.map((v, i) => v - eye[i]),
    k = Math.tan((c.fov * Math.PI) / 360);
  return [((dot(d, r) / (dot(d, f) * k * (W / H)) + 1) / 2) * W, ((1 - dot(d, u) / (dot(d, f) * k)) / 2) * H];
}
const round = (v) => v.map((x) => +x.toFixed(4));
/** The orbit and arcball tasks' camera. */
const VIEW = { fov: 45, near: 0.1, far: 100, position: [0, 5, 10], target: [0, 0, 0] };

export const builders = {
  async 'p-orbit-controls'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      { OrbitControls } = await import('@margoengine/controls/orbit'),
      camera = new Camera(VIEW),
      controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    // Margo's defaults turn half a turn per element height and double the distance per 500 wheel pixels; three.js
    // turns a full turn per height and scales by 0.95 per wheel notch. Set to three.js's sensitivity so both do the
    // same motion.
    controls.rotateSpeed = 2;
    controls.zoomSpeed = Math.log2(1 / 0.95) / 0.2;
    controls.saveState();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return {
      task() {
        controls.reset();
        pointer(canvas, 'pointerdown', 640, 360);
        for (let k = 1; k <= 10; k++) pointer(canvas, 'pointermove', 640 + 20 * k, 360);
        pointer(canvas, 'pointerup', 840, 360);
        wheel(canvas, 640, 360, 100);
        for (let i = 0; i < data.updates; i++) controls.update();
      },
      output: () => ({
        position: round([...camera.position]),
        distance: +controls.getDistance().toFixed(4),
      }),
      info: () => ({ note: '200 px drag in 10 moves, one wheel step of deltaY 100, then the updates (1/60 s each)' }),
    };
  },

  async 'p-transform-controls'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { TransformControls } = await import('@margoengine/controls/transform');
    floor(engine, data.floor);
    const list = meshes(engine, data, palette(data)),
      gizmo = TransformControls.attach(engine, { mode: 'translate' });
    gizmo.attach(list[0]);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'core batches; gizmo overlay pass not counted' });
  },

  async 'p-drag-controls'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { DragControls } = await import('@margoengine/controls/drag'),
      list = meshes(engine, data, palette(data)),
      index = new Map(list.map((m, i) => [m, i])),
      drag = DragControls.attach(engine, list),
      [x0, y0] = project(data.camera, data.items[0].position);
    let grabbed = null;
    drag.addEventListener('dragstart', (e) => (grabbed = e.object));
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return {
      task() {
        if (grabbed) grabbed.setPosition(data.items[index.get(grabbed)].position);
        grabbed = null;
        pointer(canvas, 'pointerdown', x0, y0);
        for (let k = 1; k <= 200; k++) pointer(canvas, 'pointermove', x0 + 2 * k, y0 + k);
        pointer(canvas, 'pointerup', x0 + 400, y0 + 200);
      },
      output: () => ({
        grabbed: grabbed ? index.get(grabbed) : null,
        position: grabbed ? round([grabbed.position.x, grabbed.position.y, grabbed.position.z]) : null,
      }),
      info: () => ({ note: 'down on box 0 centre, 200 moves of (2, 1) px, view-plane drag' }),
    };
  },

  async 'p-arcball'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      { ArcballControls } = await import('@margoengine/controls/arcball'),
      camera = new Camera(VIEW),
      controls = new ArcballControls(camera, canvas),
      // 200 points on a circle of 150 px about the canvas centre.
      // 200 points on a horizontal line through the centre (490 to 790 px), walked back and forth: three.js turns from
      // the grab point and Margo turn by turn, and turns about one axis compose the same way, so both end alike.
      path = Array.from({ length: 200 }, (_, k) => [490 + (300 * k) / 199, 360]),
      at = (i) => path[i % 398 < 200 ? i % 398 : 398 - (i % 398)];
    controls.saveState();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return {
      task() {
        controls.reset();
        pointer(canvas, 'pointerdown', ...path[0]);
        for (let i = 1; i <= data.updates; i++) {
          pointer(canvas, 'pointermove', ...at(i));
          controls.update();
        }
        pointer(canvas, 'pointerup', ...at(data.updates));
      },
      output: () => ({ position: round([...camera.position]), up: round([...(camera.up ?? [0, 1, 0])]) }),
      info: () => ({ note: 'one drag of 10,000 moves back and forth along a 200-point line, an update after each' }),
    };
  },
};
