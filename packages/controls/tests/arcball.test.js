import test from 'node:test';
import assert from 'node:assert/strict';
import { ArcballControls, arcballPoint } from '../dist/index.js';
import { ArcballControls as EntryArcball } from '../dist/arcball.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { FakeElement, camera, close, closeVec, pointer, run } from './control-fakes.js';

// Pixel checks go through core's Float32 camera matrix, good to about 1e-5 px.
const PX = 1e-3;
const W = 800,
  H = 600;
const len = (a) => Math.hypot(...a);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => a.map((v) => v / len(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function rig(options = {}, cam = camera(), controlOptions) {
  const el = new FakeElement(W, H),
    control = new ArcballControls(cam, el, controlOptions),
    events = [];
  Object.assign(control, options);
  for (const type of ['start', 'change', 'end']) control.addEventListener(type, () => events.push(type));
  return { el, cam, control, events };
}
// Press, move through `points` with one update after each move, release.
function gesture(el, control, points, extra = {}, delta = 1 / 60) {
  pointer(el, 'pointerdown', points[0][0], points[0][1], extra);
  for (const [x, y] of points.slice(1)) {
    pointer(el, 'pointermove', x, y, extra);
    control.update(delta);
  }
  pointer(el, 'pointerup', ...points[points.length - 1], extra);
}
// Pixel of a world point through the camera's real matrix (core Camera.update, WebGPU depth).
function screen(cam, point) {
  cam.update(W / H, true);
  const m = cam.matrix,
    x = m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12],
    y = m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13],
    w = m[3] * point[0] + m[7] * point[1] + m[11] * point[2] + m[15];
  return [((x / w + 1) / 2) * W, ((1 - y / w) / 2) * H];
}
// World point on the plane through the target facing the camera under a pixel (half: visible half-height there).
function under(cam, px, py, half) {
  const forward = unit(sub(cam.target, cam.position)),
    right = unit(cross(forward, cam.up)),
    up = cross(right, forward),
    nx = (px / W) * 2 - 1,
    ny = 1 - (py / H) * 2;
  return cam.target.map((v, i) => v + right[i] * nx * half * (W / H) + up[i] * ny * half);
}
const perspectiveHalf = (cam) => len(sub(cam.position, cam.target)) * Math.tan((cam.fov * Math.PI) / 360);
const wheel = (el, deltaY, x, y, extra = {}) =>
  el.dispatch('wheel', { deltaY, deltaMode: 0, clientX: x, clientY: y, ...extra });

test('arcball: defaults, root and /arcball entries, lifecycle', () => {
  assert.equal(EntryArcball, ArcballControls);
  const { control, el } = rig();
  assert.equal(control.enableRotate && control.enableZoom && control.enablePan, true);
  assert.equal(control.enableDamping, false);
  assert.equal(control.dampingFactor, 0.05);
  assert.equal(control.zoomToCursor, true);
  assert.deepEqual(control.mouseButtons, { LEFT: 0, MIDDLE: 1, RIGHT: 2 });
  assert.equal(control.state, 'none');
  assert.equal(control.projection, null);
  assert.equal(el.style.touchAction, 'none');
  assert.equal(control.update(), false, 'idle update does not move or rewrite up');
  control.dispose();
  assert.equal(el.listenerCount, 0, 'dispose removes every listener');
  assert.equal(el.style.touchAction, 'auto');
  control.dispose();
  assert.throws(() => new ArcballControls(camera(), new FakeElement(), { projection: {} }), TypeError);
});

test('arcball: sphere mapping is continuous where the ball meets the hyperbolic sheet', () => {
  const edge = Math.SQRT1_2;
  for (const angle of [0, 0.7, 2, 4]) {
    const c = Math.cos(angle),
      s = Math.sin(angle),
      inside = arcballPoint(c * (edge - 1e-9), s * (edge - 1e-9)),
      outside = arcballPoint(c * (edge + 1e-9), s * (edge + 1e-9));
    close(inside[2], outside[2], 1e-8, 'height');
    close(inside[2], edge, 1e-8, 'height at the seam');
  }
  closeVec(arcballPoint(0, 0), [0, 0, 1], 0);
  close(len(arcballPoint(0.3, -0.4)), 1, 1e-12, 'inside lies on the unit sphere');
  close(arcballPoint(3, 4)[2], 0.1, 1e-12, 'outside: z = 1 / (2 r)');
  // The slope of the height matches at the seam too (no kink): compare one-sided differences.
  const h = 1e-5,
    slopeIn = (arcballPoint(edge, 0)[2] - arcballPoint(edge - h, 0)[2]) / h,
    slopeOut = (arcballPoint(edge + h, 0)[2] - arcballPoint(edge, 0)[2]) / h;
  close(slopeIn, slopeOut, 1e-3, 'slope');
});

test('arcball: a drag across the centre turns by the angle between the ball points about screen up', () => {
  const { el, cam, control, events } = rig();
  const radius = Math.min(W, H) / 2,
    x = 60 / radius,
    expected = 2 * Math.asin(x);
  gesture(el, control, [
    [W / 2 - 60, H / 2],
    [W / 2 + 60, H / 2],
  ]);
  close(len(cam.position), 10, 1e-9, 'distance kept');
  close(Math.atan2(-cam.position[0], cam.position[2]), expected, 1e-9, 'angle about +Y; camera moves to -X');
  close(cam.position[1], 0, 1e-9);
  closeVec(cam.up, [0, 1, 0], 1e-9, 'axis is screen up, so up is unchanged');
  assert.deepEqual(events, ['start', 'change', 'end']);

  // A vertical drag turns about screen right; dragging up moves the camera down.
  const r = rig();
  gesture(r.el, r.control, [
    [W / 2, H / 2 + 60],
    [W / 2, H / 2 - 60],
  ]);
  close(Math.atan2(-r.cam.position[1], r.cam.position[2]), expected, 1e-9, 'angle about +X');
  close(r.cam.position[0], 0, 1e-9);
  control.dispose();
  r.control.dispose();
});

test('arcball: no up lock: the camera rolls and passes over the pole', () => {
  // Circling the pointer far from the centre rolls the view about the view axis.
  let { el, cam, control } = rig();
  const points = [];
  for (let i = 0; i <= 90; i++) {
    const a = (i / 90) * Math.PI;
    points.push([W / 2 + 900 * Math.cos(a), H / 2 - 900 * Math.sin(a)]);
  }
  gesture(el, control, points);
  const forward = unit(sub(cam.target, cam.position));
  assert.ok(dot(cam.up, [0, 1, 0]) < Math.cos(0.3), `up rolled: ${cam.up}`);
  close(dot(cam.up, forward), 0, 1e-9, 'up stays perpendicular to the view');
  assert.ok(dot(forward, [0, 0, -1]) > 0.5, 'mostly a roll: still looking down -Z');
  cam.update(W / H, true);
  control.dispose();

  // Repeated upward drags carry the camera over the top: upside down behind the target.
  ({ el, cam, control } = rig());
  const step = 2 * Math.asin(0.2); // per drag of +/-60 px across the centre
  const drags = Math.round(Math.PI / step);
  for (let i = 0; i < drags; i++)
    gesture(el, control, [
      [W / 2, H / 2 + 60],
      [W / 2, H / 2 - 60],
    ]);
  const turned = drags * step;
  closeVec(cam.position, [0, -10 * Math.sin(turned), 10 * Math.cos(turned)], 1e-8);
  assert.ok(cam.up[1] < -0.9, 'upside down');
  cam.update(W / H, true); // a valid view: no vertical-camera error at or past the pole
  control.dispose();
});

test('arcball: 1000 drags compose without drift (orthonormal frame, distance kept)', () => {
  const { el, cam, control } = rig();
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 1000; i++) {
    const x = W / 2 + random() * 380,
      y = H / 2 + random() * 280;
    gesture(el, control, [
      [x, y],
      [x + random() * 120, y + random() * 120],
      [x + random() * 120, y + random() * 120],
    ]);
  }
  const forward = unit(sub(cam.target, cam.position));
  close(len(cam.up), 1, 1e-12, '|up|');
  close(dot(cam.up, forward), 0, 1e-12, 'up . forward');
  close(len(sub(cam.position, cam.target)), 10, 1e-9, 'distance');
  closeVec(cam.target, [0, 0, 0], 0, 'rotation never moves the target');
  cam.update(W / H, true);
  control.dispose();
});

test('arcball: pan keeps the grabbed point under the cursor (perspective, rolled camera)', () => {
  const { el, cam, control, events } = rig();
  // Roll and tilt first, so pan must use the rolled screen axes.
  control.rotate([0.3, 0.2, 1], 0.8);
  control.update();
  const half = perspectiveHalf(cam),
    grabbed = under(cam, 500, 200, half),
    position = [...cam.position],
    target = [...cam.target];
  closeVec(screen(cam, grabbed), [500, 200], PX, 'setup');
  events.length = 0;
  gesture(
    el,
    control,
    [
      [500, 200],
      [530, 260],
      [610, 330],
    ],
    { button: 2 },
  );
  closeVec(screen(cam, grabbed), [610, 330], PX, 'grabbed point follows the cursor');
  closeVec(sub(cam.position, position), sub(cam.target, target), 1e-9, 'camera and target move together');
  assert.deepEqual(events, ['start', 'change', 'change', 'end']);
  control.dispose();

  // Shift + left pans as well.
  const r = rig(),
    point = under(r.cam, 300, 400, perspectiveHalf(r.cam));
  gesture(
    r.el,
    r.control,
    [
      [300, 400],
      [340, 380],
    ],
    { shiftKey: true },
  );
  closeVec(screen(r.cam, point), [340, 380], PX);
  r.control.dispose();
});

test('arcball: pan and zoom keep the cursor point under an orthographic camera', () => {
  const cam = camera({ position: [3, 4, 10], target: [1, 0, 0] }),
    projection = new CameraProjection({ mode: 'orthographic', height: 4, zoom: 1.5 });
  projection.attach(cam);
  cam.update(W / H, true);
  const { el, control } = rig({}, cam, { projection });
  assert.equal(control.projection, projection);
  const half = () => 4 / 2 / projection.zoom;
  const grabbed = under(cam, 250, 420, half());
  closeVec(screen(cam, grabbed), [250, 420], PX, 'setup');
  gesture(
    el,
    control,
    [
      [250, 420],
      [300, 380],
    ],
    { button: 2 },
  );
  closeVec(screen(cam, grabbed), [300, 380], PX, 'orthographic pan');

  // Wheel zoom changes the projection size, not the distance, and keeps the cursor point on its pixel.
  const distance = control.getDistance(),
    point = under(cam, 620, 140, half()),
    zoom = projection.zoom;
  wheel(el, -200, 620, 140);
  close(projection.zoom, zoom * 2 ** 0.4, 1e-9, 'zoom by 2^(200/500)');
  close(control.getDistance(), distance, 1e-9, 'distance unchanged');
  closeVec(screen(cam, point), [620, 140], PX, 'cursor point fixed');
  // Zoom limits.
  control.maxZoom = 3;
  for (let i = 0; i < 20; i++) wheel(el, -200, 620, 140);
  close(projection.zoom, 3, 1e-12, 'maxZoom');
  // reset restores the zoom with the camera.
  control.reset();
  close(projection.zoom, 1.5, 0);
  control.dispose();
  projection.dispose();

  // A default (size follows distance) orthographic projection zooms by distance about the cursor point.
  const c2 = camera({ position: [0, 3, 8] }),
    p2 = new CameraProjection({ mode: 'orthographic' });
  p2.attach(c2);
  c2.update(W / H, true);
  const r = rig({}, c2),
    q = under(c2, 150, 450, perspectiveHalf(c2)),
    d = r.control.getDistance();
  wheel(r.el, 150, 150, 450);
  close(r.control.getDistance(), d * 2 ** 0.3, 1e-9);
  closeVec(screen(c2, q), [150, 450], PX);
  r.control.dispose();
  p2.dispose();
});

test('arcball: zoom to cursor keeps the cursor point fixed; distance limits', () => {
  const { el, cam, control } = rig();
  control.rotate([1, 1, 0], 0.5);
  control.update();
  const point = under(cam, 620, 150, perspectiveHalf(cam)),
    d = control.getDistance();
  wheel(el, -200, 620, 150);
  close(control.getDistance(), d * 2 ** -0.4, 1e-9, 'wheel in');
  closeVec(screen(cam, point), [620, 150], PX, 'cursor point fixed');

  // Middle drag zooms about the press point.
  const p2 = under(cam, 200, 300, perspectiveHalf(cam));
  gesture(
    el,
    control,
    [
      [200, 300],
      [200, 400],
    ],
    { button: 1 },
  );
  closeVec(screen(cam, p2), [200, 300], PX, 'dolly drag about the press point');

  // Pinch spreads two fingers: closer, about the midpoint.
  const before = control.getDistance(),
    mid = under(cam, 400, 300, perspectiveHalf(cam)),
    touch = (type, id, x, y) => pointer(el, type, x, y, { pointerId: id, pointerType: 'touch' });
  touch('pointerdown', 11, 350, 300);
  touch('pointerdown', 12, 450, 300);
  assert.equal(control.state, 'touch-dolly-pan');
  touch('pointermove', 12, 550, 300);
  touch('pointermove', 11, 250, 300);
  touch('pointerup', 11, 250, 300);
  touch('pointerup', 12, 550, 300);
  close(control.getDistance(), before / 3, 1e-9, 'spread x3 is a third of the distance');
  closeVec(screen(cam, mid), [400, 300], PX, 'midpoint fixed');

  control.minDistance = 4;
  control.maxDistance = 12;
  for (let i = 0; i < 30; i++) wheel(el, -300, 100, 500);
  close(control.getDistance(), 4, 1e-9, 'minDistance');
  for (let i = 0; i < 30; i++) wheel(el, 300, 700, 100);
  close(control.getDistance(), 12, 1e-9, 'maxDistance');
  // Limits that exclude the current distance apply on the next update.
  control.maxDistance = 8;
  control.update();
  close(control.getDistance(), 8, 1e-9);
  control.dispose();
});

test('arcball: damping eases out after release, keeps spinning, and comes to rest', () => {
  const { el, cam, control } = rig({ enableDamping: true });
  pointer(el, 'pointerdown', 380, 300);
  pointer(el, 'pointermove', 420, 300);
  control.update(1 / 60);
  pointer(el, 'pointerup', 420, 300);
  const angle = () => Math.atan2(-cam.position[0], cam.position[2]);
  let previous = angle(),
    frames = 0;
  const steps = [];
  assert.ok(control.update(1 / 60), 'keeps turning after release');
  for (; frames < 2000 && control.update(1 / 60); frames++) {
    const now = angle();
    steps.push(now - previous);
    previous = now;
  }
  assert.ok(steps.length > 50 && steps.every((v) => v > 0), 'keeps turning the same way');
  // Each step is smaller than the one before, except the last, which takes the sub-threshold rest at once.
  for (let i = 1; i < steps.length - 1; i++) assert.ok(steps[i] < steps[i - 1], `slowing at ${i}`);
  assert.ok(frames < 2000, 'comes to rest');
  assert.equal(control.update(1 / 60), false);
  close(angle(), 2 * Math.asin(20 / 300), 1e-12, 'total turn equals the undamped drag');
  close(len(cam.position), 10, 1e-9);

  // Frame-rate independent: 30 fps reaches the same place.
  const r = rig({ enableDamping: true });
  pointer(r.el, 'pointerdown', 380, 300);
  pointer(r.el, 'pointermove', 420, 300);
  pointer(r.el, 'pointerup', 420, 300);
  run(r.control, 0.5, 30);
  const s = rig({ enableDamping: true });
  pointer(s.el, 'pointerdown', 380, 300);
  pointer(s.el, 'pointermove', 420, 300);
  pointer(s.el, 'pointerup', 420, 300);
  run(s.control, 0.5, 60);
  closeVec(r.cam.position, s.cam.position, 1e-9);
  // Grabbing again stops the spin.
  pointer(s.el, 'pointerdown', 400, 300);
  assert.equal(s.control.update(1 / 60), false);
  for (const c of [control, r.control, s.control]) c.dispose();
});

test('arcball: enable flags, enabled, saveState and reset', () => {
  const { el, cam, control, events } = rig({ enableRotate: false, enablePan: false, enableZoom: false });
  gesture(el, control, [
    [300, 300],
    [500, 200],
  ]);
  gesture(
    el,
    control,
    [
      [300, 300],
      [500, 200],
    ],
    { button: 2 },
  );
  gesture(
    el,
    control,
    [
      [300, 300],
      [500, 200],
    ],
    { button: 1 },
  );
  assert.equal(wheel(el, -100, 400, 300).defaultPrevented, false, 'wheel left to the page');
  closeVec(cam.position, [0, 0, 10], 0);
  assert.deepEqual(events, []);
  // Only rotation disabled: shift + left (pan) still works, left does not rotate.
  control.enablePan = true;
  gesture(el, control, [
    [300, 300],
    [350, 300],
  ]);
  closeVec(cam.position, [0, 0, 10], 0);
  gesture(
    el,
    control,
    [
      [300, 300],
      [350, 300],
    ],
    { shiftKey: true },
  );
  assert.ok(cam.position[0] < 0 && cam.target[0] < 0, 'panned');

  control.enableRotate = true;
  control.enabled = false;
  gesture(el, control, [
    [300, 300],
    [500, 200],
  ]);
  assert.ok(cam.position[2] === 10, 'disabled');
  control.enabled = true;
  // Disabling mid-drag ends the gesture.
  pointer(el, 'pointerdown', 300, 300);
  assert.equal(control.state, 'rotate');
  control.enabled = false;
  pointer(el, 'pointermove', 320, 300);
  assert.equal(control.state, 'none');
  assert.equal(events.at(-1), 'end');
  control.enabled = true;
  assert.equal(el.dispatch('contextmenu').defaultPrevented, true);

  control.saveState();
  const saved = { position: [...cam.position], target: [...cam.target] };
  gesture(el, control, [
    [300, 300],
    [500, 100],
    [700, 100],
  ]);
  assert.notDeepEqual(cam.up, [0, 1, 0]);
  control.reset();
  closeVec(cam.position, saved.position, 0);
  closeVec(cam.target, saved.target, 0);
  closeVec(cam.up, [0, 1, 0], 0);
  control.dispose();
});
