// Node checks of the CPU side of @margoengine/pixel: camera maths, parallax, zoom bounds, option errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CameraProjection } from '@margoengine/cameras';
import { LayerCompositor, PixelCamera } from '../dist/index.js';

const camera = (options = {}) => new PixelCamera({ width: 16, height: 8, ...options });
const coded = (code) => (error) => error.code === code;

test('scroll splits into whole pixels and the rest, and moves only at a whole pixel', () => {
  const c = camera();
  for (const [x, pixel, sub] of [
    [0, 0, 0],
    [0.5, 0, 0.5],
    [0.99, 0, 0.99],
    [1, 1, 0],
    [2.25, 2, 0.25],
    [-0.5, -1, 0.5],
    [-1, -1, 0],
  ]) {
    c.x = x;
    const scroll = c.scroll();
    assert.equal(scroll.x, pixel, `x ${x}`);
    assert.ok(Math.abs(scroll.subX - sub) < 1e-9, `rest of ${x}`);
  }
});

test('ten steps of 0.1 reach pixel 1, though they add up to just under 1', () => {
  const c = camera();
  for (let i = 0; i < 10; i++) c.x += 0.1;
  assert.ok(c.x < 1);
  assert.equal(c.pixelX(), 1);
  assert.equal(c.scroll().subX, 0);
});

test('parallax scales the scroll per axis; 0 stays put', () => {
  const c = camera({ x: 10, y: 6 });
  assert.equal(c.pixelX(0.5), 5);
  assert.equal(c.pixelY(0.5), 3);
  assert.equal(c.pixelX(0), 0);
  assert.equal(c.pixelY([1, 0]), 0);
  assert.equal(c.pixelX([0.25, 0]), 2);
  assert.ok(Math.abs(c.scroll(0.25).subX - 0.5) < 1e-9);
  assert.equal(c.pixelX(-1), -10);
});

test('unitsPerPixel turns world units into pixels', () => {
  const c = camera({ x: 7, unitsPerPixel: 2 });
  assert.equal(c.pixelX(), 3);
  assert.ok(Math.abs(c.scroll().subX - 0.5) < 1e-9);
});

test('zoom is a whole number inside its bounds, and anything else throws RangeError', () => {
  const c = camera({ zoom: 3, minZoom: 2, maxZoom: 5 });
  assert.equal(c.zoom, 3);
  assert.equal(c.autoFit, false);
  for (const bad of [1.5, 2.0001, 1, 6, 0, -2, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(
      () => {
        c.zoom = bad;
      },
      RangeError,
      `zoom ${bad}`,
    );
  assert.equal(c.zoom, 3, 'a refused zoom changes nothing');
  assert.throws(() => camera({ zoom: 2.5 }), RangeError);
});

test('fit takes the largest whole number that fits, inside the bounds', () => {
  const c = camera();
  assert.equal(c.autoFit, true);
  assert.equal(c.fit(64, 32), 4);
  assert.equal(c.fit(67, 35), 4);
  assert.equal(c.fit(64, 31), 3);
  assert.equal(c.fit(10, 4), 1, 'never below minZoom, even when it does not fit');
  assert.equal(camera({ maxZoom: 3 }).fit(1000, 1000), 3);
  assert.equal(camera({ minZoom: 2 }).fit(16, 8), 2);
  assert.equal(c.autoFit, true, 'fit keeps fitting');
  c.zoom = 2;
  assert.equal(c.autoFit, false, 'setting a zoom stops it');
  assert.throws(() => c.fit(0, 10), RangeError);
});

test('invalid sizes, positions and parallax throw RangeError with a help link', () => {
  for (const options of [
    { width: 0 },
    { width: 1.5 },
    { height: -1 },
    { unitsPerPixel: 0 },
    { unitsPerPixel: Number.POSITIVE_INFINITY },
    { minZoom: 0 },
    { maxZoom: 0 },
    { minZoom: 4, maxZoom: 2 },
  ])
    assert.throws(() => camera(options), /errors#pixel-options/, JSON.stringify(options));
  const c = camera();
  c.x = Number.NaN;
  assert.throws(() => c.pixelX(), RangeError);
  c.x = 0;
  c.y = Number.POSITIVE_INFINITY;
  assert.throws(() => c.scroll(), RangeError);
  c.y = 0;
  assert.throws(() => c.pixelX(Number.NaN), RangeError);
  assert.throws(() => new PixelCamera(), RangeError);
});

test('projection frames the same whole pixels through CameraProjection, y up', () => {
  const c = camera({ x: 3.7, y: 2.2, unitsPerPixel: 0.5 }),
    bounds = c.projection();
  // 3.7 / 0.5 is 7.4 pixels, 2.2 / 0.5 is 4.4: pixels 7 and 4, at 0.5 units each.
  assert.deepEqual(bounds, { mode: 'orthographic', left: 3.5, right: 11.5, top: -2, bottom: -6, zoom: 1 });
  const projection = new CameraProjection(bounds);
  assert.equal(projection.fixedOrthographic, true);
  const P = new Float64Array(16),
    view = { near: 0.1, far: 100, position: [0, 0, 10], target: [0, 0, 0], fov: 50, up: [0, 1, 0] };
  projection.attach(view);
  view.project(P, 2, true);
  // The left edge lands on clip x -1 and the top edge on clip y 1.
  assert.ok(Math.abs(3.5 * P[0] + P[12] + 1) < 1e-12);
  assert.ok(Math.abs(-2 * P[5] + P[13] - 1) < 1e-12);
  assert.equal(c.projection(0).left, 0, 'parallax 0 stays put');
});

test('compositor and layers: defaults, options and errors, with no GPU', () => {
  const compositor = new LayerCompositor({ camera: { width: 16, height: 8 } });
  assert.equal(compositor.camera.width, 16);
  const shared = camera();
  assert.equal(new LayerCompositor({ camera: shared }).camera, shared);
  assert.match(compositor.name, /^pixel-\d+$/);
  assert.equal(new LayerCompositor({ camera: shared, name: 'hud' }).name, 'hud');
  const layer = compositor.addLayer();
  assert.deepEqual(
    [layer.width, layer.height, layer.anchor, layer.parallax, layer.opacity, layer.blend, layer.rotation, layer.z],
    [16, 8, 'view', 1, 1, 'normal', 0, 0],
  );
  assert.equal(layer.visible, true);
  assert.equal(compositor.addLayer({ width: 32, height: 2 }).width, 32);
  assert.throws(() => new LayerCompositor({}), TypeError);
  assert.throws(() => new LayerCompositor({ camera: shared, order: Number.NaN }), RangeError);
  assert.throws(() => compositor.addLayer({ width: 0 }), RangeError);
  assert.throws(() => compositor.addLayer({ height: 1.5 }), RangeError);
  assert.throws(() => compositor.addLayer({ anchor: 'screen' }), RangeError);
  assert.throws(() => layer.write({ width: 1, height: 1, data: new Uint8Array(3) }), RangeError);
  assert.throws(() => layer.write({ width: 17, height: 8, data: new Uint8Array(17 * 8 * 4) }), RangeError);
  assert.throws(() => layer.texture, coded('state'));
  assert.throws(() => layer.target(), coded('state'));
  assert.equal(compositor.removeLayer(layer), true);
  assert.equal(compositor.removeLayer(layer), false);
  assert.throws(() => layer.texture, coded('disposed'));
  assert.throws(() => layer.write({ width: 1, height: 1, data: new Uint8Array(4) }), coded('disposed'));
  compositor.dispose();
  assert.equal(compositor.layers.length, 0);
  assert.throws(() => compositor.addLayer(), coded('disposed'));
  assert.throws(() => compositor.setup({ backend: 'webgpu' }), coded('disposed'));
  assert.throws(() => new LayerCompositor({ camera: shared }).setup({ backend: 'webgl2' }), coded('unsupported'));
});

test('a layer camera is live: whole pixels only, at its parallax, in the shape a sprite layer reads', () => {
  const compositor = new LayerCompositor({ camera: { width: 16, height: 8, unitsPerPixel: 2 } }),
    layer = compositor.addLayer({ parallax: 0.5 });
  const seen = layer.camera;
  compositor.camera.x = 9;
  // 9 units is 4.5 pixels, 2.25 at this parallax: pixel 2, which is 4 units.
  assert.equal(seen.x, 4);
  assert.equal(seen.zoom, 0.5);
  layer.parallax = 1;
  assert.equal(seen.x, 8);
});
