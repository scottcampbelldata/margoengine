import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection, fitBox } from '../dist/index.js';

// GAP-FILM-FITBOX: core's fitToBoundingBox frames the bounding sphere, so a long, flat or deep model covers a small
// part of a 16:9 shot (a car side-on: 13 % of the frame against 48 % here); fitBox moves the eye along its own view
// until the tighter axis touches the padded frame.

const corners = (b) => {
  const out = [];
  for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) out.push([x, y, z]);
  return out;
};
const ndc = (m, p) => {
  const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return [c[0] / c[3], c[1] / c[3], c[3]];
};
/** Largest |x| and |y| of the box's corners on screen, from the camera's own matrix. */
const extent = (camera, bounds, aspect) => {
  camera.update(aspect, true);
  let x = 0,
    y = 0;
  for (const p of corners(bounds)) {
    const [cx, cy, w] = ndc(camera.matrix, p);
    assert.ok(w > 0, 'every corner is in front of the eye');
    x = Math.max(x, Math.abs(cx));
    y = Math.max(y, Math.abs(cy));
  }
  return { x, y };
};
// camera.matrix is float32: compare screen positions to 1e-6.
const EPS = 1e-6;
const tree = [-1, 0, -1, 1, 8, 1],
  car = [-2.3, 0, -1, 2.3, 1.5, 1],
  wide = 16 / 9;
/** The share of the frame covered by the rectangle round the box's corners on screen. */
const cover = (camera, bounds, aspect) => {
  const { x, y } = extent(camera, bounds, aspect);
  return x * y;
};

test('fitBox frames a tall tree in 16:9 so its height touches the padded frame', () => {
  for (const [position, target] of [
    [
      [0, 4, 20],
      [0, 4, 0],
    ],
    [
      [7, 9, 15],
      [0.5, 3, -1],
    ],
    [
      [-12, 2, -9],
      [0, 5, 0],
    ],
  ]) {
    const sphere = new Camera({ position, target, fov: 40 });
    sphere.fitToBoundingBox(tree.slice(0, 3), tree.slice(3), { aspect: wide, duration: 0, padding: 1.1 });
    const old = extent(sphere, tree, wide);

    const fit = fitBox({ position, target, fov: 40 }, tree, { aspect: wide, padding: 1.1 });
    const camera = new Camera({ position: fit.position, target: fit.target, fov: 40 });
    const now = extent(camera, tree, wide);
    assert.ok(
      now.x <= 1 / 1.1 + EPS && now.y <= 1 / 1.1 + EPS,
      `every corner inside the padded frame (${now.x}, ${now.y})`,
    );
    assert.ok(Math.abs(Math.max(now.x, now.y) - 1 / 1.1) < EPS, 'the tighter axis touches the padded frame');
    assert.ok(now.y > old.y, `the tree fills more of the frame than the sphere fit (${now.y} against ${old.y})`);

    // Same view direction as asked.
    const asked = target.map((v, i) => v - position[i]),
      got = fit.target.map((v, i) => v - fit.position[i]),
      cos = asked.reduce((s, v, i) => s + v * got[i], 0) / (Math.hypot(...asked) * Math.hypot(...got));
    assert.ok(cos > 1 - 1e-12, 'the view direction stays');
    assert.ok(fit.nearest > 0 && fit.nearest <= fit.distance, 'nearest corner depth is reported');
  }
});

test('fitBox fills a 16:9 frame with a car side-on, where the bounding sphere leaves it small', () => {
  const position = [0, 1, 10],
    target = [0, 0.7, 0],
    sphere = new Camera({ position, target, fov: 40 });
  sphere.fitToBoundingBox(car.slice(0, 3), car.slice(3), { aspect: wide, duration: 0, padding: 1.1 });
  const fit = fitBox({ position, target, fov: 40 }, car, { aspect: wide, padding: 1.1 }),
    camera = new Camera({ position: fit.position, target: fit.target, fov: 40 }),
    before = cover(sphere, car, wide),
    after = cover(camera, car, wide);
  assert.ok(after > 3 * before, `covers ${after} of the frame against ${before}`);
  assert.ok(Math.abs(extent(camera, car, wide).x - 1 / 1.1) < EPS, 'the length touches the padded frame');
});

test('fitBox centres the slack axis: a wide, flat box binds on width and is centred vertically', () => {
  const slab = [-10, 0, -1, 10, 1, 1],
    fit = fitBox({ position: [0, 0.5, 30], target: [0, 0.5, 0], fov: 50 }, slab, { aspect: 1, padding: 1 }),
    camera = new Camera({ position: fit.position, target: fit.target, fov: 50 });
  camera.update(1, true);
  let top = -Infinity,
    bottom = Infinity,
    right = 0;
  for (const p of corners(slab)) {
    const [x, y] = ndc(camera.matrix, p);
    top = Math.max(top, y);
    bottom = Math.min(bottom, y);
    right = Math.max(right, Math.abs(x));
  }
  assert.ok(Math.abs(right - 1) < EPS, 'the width touches the frame');
  assert.ok(Math.abs(top + bottom) < EPS, 'equal slack above and below');
});

test('fitBox centres a box seen from above on its looser axis (KB-FITBOX-CENTRE1)', () => {
  // A flat plate at 25 degrees elevation: its near and far edges sit at different depths, so equal slack at the top and
  // bottom frustum planes put its screen centre 24.8 px above the middle of a 1280x720 frame.
  const plate = [-1, 0, -1, 1, 0.05, 1],
    view = (az, el, r) => [
      r * Math.cos(el) * Math.sin(az),
      0.025 + r * Math.sin(el),
      r * Math.cos(el) * Math.cos(az),
    ];
  for (const [az, el, bounds] of [
    [45, 25, plate],
    [10, 60, plate],
    [-30, 15, [-2.3, 0, -1, 2.3, 1.5, 1]],
    [120, 35, [-1, 0, -1, 1, 8, 1]],
  ]) {
    const position = view((az * Math.PI) / 180, (el * Math.PI) / 180, 10),
      target = [0, 0.025, 0],
      fit = fitBox({ position, target, fov: 30 }, bounds, { aspect: wide, padding: 1.25 }),
      camera = new Camera({ position: fit.position, target: fit.target, fov: 30 });
    camera.update(wide, true);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const p of corners(bounds)) {
      const [x, y] = ndc(camera.matrix, p);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    assert.ok(Math.abs(x0 + x1) < EPS, `centred across at ${az}/${el} (${x0}, ${x1})`);
    assert.ok(Math.abs(y0 + y1) < EPS, `centred up and down at ${az}/${el} (${y0}, ${y1})`);
    assert.ok(Math.abs(Math.max(x1, y1) - 1 / 1.25) < EPS, 'the tighter axis still touches the padded frame');
    assert.ok(x1 <= 1 / 1.25 + EPS && y1 <= 1 / 1.25 + EPS, 'every corner inside the padded frame');
  }
});

test('CameraProjection.fit framing box animates to the fitBox view in perspective', () => {
  const camera = new Camera({ position: [0, 4, 20], target: [0, 4, 0], fov: 40 }),
    p = new CameraProjection({ mode: 'perspective' });
  p.attach(camera);
  const expected = fitBox({ position: camera.position, target: camera.target, fov: 40 }, tree, {
    aspect: wide,
    padding: 1.2,
  });
  p.fit(tree, { aspect: wide, duration: 0.5, padding: 1.2, framing: 'box' });
  p.onPreUpdate(0.25);
  assert.ok(
    Math.abs(camera.position[2] - 20) > 1e-6 && Math.abs(camera.position[2] - expected.position[2]) > 1e-6,
    'mid-way',
  );
  p.onPreUpdate(0.25);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(camera.position[i] - expected.position[i]) < EPS * 30);
    assert.ok(Math.abs(camera.target[i] - expected.target[i]) < EPS * 30);
  }
  const now = extent(camera, tree, wide);
  assert.ok(Math.abs(now.y - 1 / 1.2) < EPS, 'the tree height touches the padded frame');
  // The default stays the bounding sphere, as core.
  const sphere = new Camera({ position: [0, 4, 20], target: [0, 4, 0], fov: 40 }),
    reference = new Camera({ position: [0, 4, 20], target: [0, 4, 0], fov: 40 }),
    q = new CameraProjection({ mode: 'perspective' });
  q.attach(sphere);
  q.fit(tree, { aspect: wide, duration: 0 });
  reference.fitToBoundingBox(tree.slice(0, 3), tree.slice(3), { aspect: wide, duration: 0, padding: 1.1 });
  reference.update(wide, true);
  sphere.update(wide, true);
  assert.deepEqual([...sphere.position], [...reference.position]);
});

test('fitBox and framing refuse bad input with a help link', () => {
  const view = { position: [0, 0, 5], target: [0, 0, 0], fov: 45 };
  assert.throws(() => fitBox(view, [1, 0, 0, 0, 1, 1]), /Invalid fitBox.*errors#camera/);
  assert.throws(() => fitBox(view, [0, 0, 0, 1, 1]), RangeError);
  assert.throws(() => fitBox({ ...view, fov: 180 }, tree), RangeError);
  assert.throws(() => fitBox(view, tree, { padding: 0.5 }), RangeError);
  assert.throws(() => fitBox({ ...view, target: [0, 0, 5] }, tree), /position and target must differ/);
  assert.throws(() => fitBox({ ...view, up: [0, 0, 1] }, tree), /parallel to up/);
  assert.throws(() => fitBox(view, [1, 1, 1, 1, 1, 1]), /single point/);
  const p = new CameraProjection({ mode: 'perspective' });
  p.attach(new Camera({ position: [0, 0, 5], target: [0, 0, 0] }));
  assert.throws(() => p.fit(tree, { framing: 'cube' }), /framing.*errors#camera/);
});
