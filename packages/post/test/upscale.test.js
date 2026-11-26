import test from 'node:test';
import assert from 'node:assert/strict';
import { SpatialUpscale } from '@margoengine/post/upscale';
import { analyse, axisLength, easu, frame, kernel, lobe, rcas } from './upscale-math.js';
import { harness, modules, written } from './support.js';

const image = (w, h, f) => {
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      out.set([v, v, v, 1], 4 * (y * w + x));
    }
  return out;
};
const red = (img, w, x, y) => img[4 * (y * w + x)];

test('edge analysis: the gradient points across a step and feature length tells a step from a thin line', () => {
  // Vertical step, dark left: the gradient is +x, the length 1 (black, white, white has no reversal).
  assert.deepEqual(analyse(1, 1, 1, 0, 1), [1, 0, 1]);
  // A one-texel bright line between dark: full reversal on its axis, flat along it, so length 0 (a small kernel).
  assert.equal(axisLength(0, 1, 0), 0);
  assert.equal(analyse(1, 1, 1, 0, 0)[2], 0);
  // A half reversal sits between them; a flat run is 0.
  assert.equal(axisLength(0, 1, 0.5), 0.25);
  assert.equal(axisLength(0.3, 0.3, 0.3), 0);
  // A diagonal gradient widens the kernel across the edge by sqrt 2, a long feature doubles it along the edge.
  const f = frame(1, 1, 1);
  assert.ok(Math.abs(f.across - Math.SQRT2) < 1e-12 && f.along === 2 && f.r2 === 4);
  const axial = frame(0, -3, 0);
  assert.deepEqual([axial.g, axial.across, axial.along, axial.r2], [[0, -1], 1, 1, 2]);
});

test('kernel: 1 at the centre, zero at one texel and at the window, a negative lobe only with the wide window', () => {
  assert.equal(kernel(0, 4), 1);
  assert.equal(kernel(1, 4), 0);
  assert.equal(kernel(4, 4), 0);
  assert.equal(kernel(5, 4), 0);
  assert.ok(kernel(2.25, 4) < -0.05, 'wide window keeps a real negative lobe at 1.5 texels');
  assert.ok(kernel(1.5, 2) > -0.03, 'narrow window keeps the lobe small');
});

test('EASU: a flat image stays flat, a step stays inside its range and is sharper than bilinear', () => {
  const flat = easu(
    image(6, 6, () => 0.4),
    6,
    6,
    9,
    9,
  );
  for (let i = 0; i < flat.length; i += 4) assert.ok(Math.abs(flat[i] - 0.4) < 1e-6 && flat[i + 3] === 1);
  // A vertical step between x = 3 and 4 of 8, upscaled 2x.
  const w = 8,
    step = easu(
      image(w, 8, (x) => (x < 4 ? 0.1 : 0.9)),
      w,
      8,
      16,
      16,
    );
  let inside = true;
  for (let i = 0; i < step.length; i += 4) inside &&= step[i] >= 0.1 - 1e-6 && step[i] <= 0.9 + 1e-6;
  assert.ok(inside, 'deringing keeps every output inside the input range');
  // Output x = 7 maps to render x 3.25: bilinear gives 0.1 + 0.25 * 0.8 = 0.3; the edge-adaptive kernel keeps it darker.
  const left = red(step, 16, 7, 8),
    right = red(step, 16, 8, 8);
  assert.ok(left < 0.3 - 0.02, `the dark side stays darker than bilinear (${left})`);
  assert.ok(right > 0.7 + 0.02, `the bright side stays brighter than bilinear (${right})`);
  // Far from the edge the step is untouched.
  assert.ok(Math.abs(red(step, 16, 1, 8) - 0.1) < 1e-6 && Math.abs(red(step, 16, 14, 8) - 0.9) < 1e-6);
});

test('RCAS lobe: largest where there is room, none at black or white, never past 0..1', () => {
  assert.equal(lobe([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 1), -0.2);
  // min 0.4, max 0.6: -0.4 / 2.4 = -1/6 limits it, halved by sharpen 0.5.
  assert.ok(Math.abs(lobe([0.4, 0.4, 0.4], [0.6, 0.6, 0.6], 0.5) + 1 / 12) < 1e-12);
  assert.equal(lobe([0, 0.5, 0.5], [0.6, 0.6, 0.6], 1), 0);
  assert.equal(lobe([0.4, 0.4, 0.4], [1, 1, 1], 1), 0);
  // min 0.2, max 0.8: -0.2 / 3.2 = -0.0625 limits it.
  assert.ok(Math.abs(lobe([0.2, 0.2, 0.2], [0.8, 0.8, 0.8], 1) + 0.0625) < 1e-12);
  assert.equal(lobe([0.2, 0.2, 0.2], [0.8, 0.8, 0.8], 0), 0);
  // HDR above 1: no sharpening.
  assert.equal(lobe([0.5, 0.5, 0.5], [2, 2, 2], 1), 0);
  // Any 5-tap neighbourhood in 0..1 sharpens to a value in 0..1, and raises local contrast.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noisy = image(16, 16, () => random()),
    sharp = rcas(noisy, 16, 16, 1);
  for (let i = 0; i < sharp.length; i += 4) assert.ok(sharp[i] >= -1e-6 && sharp[i] <= 1 + 1e-6, `${sharp[i]}`);
  const dot = rcas(
    image(5, 5, (x, y) => (x === 2 && y === 2 ? 0.6 : 0.4)),
    5,
    5,
    1,
  );
  assert.ok(red(dot, 5, 2, 2) > 0.6 && red(dot, 5, 1, 2) < 0.4, 'a dot gains contrast against its ring');
});

test('SpatialUpscale renders at scale, upsamples then sharpens into the frame, and releases everything', async () => {
  const h = harness(),
    effect = SpatialUpscale.attach(h.engine, { scale: 0.5, sharpen: 0.25 });
  const log = h.gpu.record(() => h.frame());
  const code = modules(log);
  assert.ok(code.some((s) => s.includes('fn analyse(') && s.includes('const LINEAR=false;')));
  assert.ok(code.some((s) => s.includes('let bound=max(')));
  const v = written(log, 16);
  assert.ok(Math.abs(v[0] - 0.5) < 0.01 && Math.abs(v[1] - 0.5) < 0.01 && v[2] === 0.25);
  const sizes = log.filter((e) => e[0] === 'texture' && !e[2].sampleCount).map((e) => e[2].size.join('x'));
  assert.deepEqual(sizes, ['640x360', '640x360', '1280x720'], 'render-size colour and depth, the output-size middle');
  effect.options.scale = 2;
  assert.throws(() => h.frame(), RangeError);
  effect.options.scale = 0.67;
  h.frame();
  h.lose();
  h.frame();
  effect.dispose();
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
  assert.equal(h.engine.hasPlugin('spatial-upscale'), false);
});

test('SpatialUpscale validates options and refuses to stack with TAAUpscale', () => {
  for (const o of [{ scale: 0.1 }, { scale: NaN }, { sharpen: -0.1 }, { sharpen: 2 }])
    assert.throws(() => new SpatialUpscale(o), RangeError);
  const h = harness();
  h.engine.use({ name: 'taa-upscale', setup() {} });
  assert.throws(
    () => SpatialUpscale.attach(h.engine),
    (e) => e.code === 'unsupported',
  );
  const disposed = new SpatialUpscale();
  disposed.dispose();
  assert.throws(
    () => h.engine.use(disposed),
    (e) => e.code === 'disposed',
  );
});

test('SpatialUpscale draws a frame of several views at full size and scales a full-canvas view', async () => {
  const h = harness(),
    effect = SpatialUpscale.attach(h.engine, { scale: 0.5 }),
    begin = h.view.begin.bind(h.view),
    sizes = [];
  let view;
  h.view.begin = (index) => {
    begin(index);
    h.view.c.view = view;
  };
  h.engine.use({
    name: 'size-probe',
    setup() {},
    registerPasses(graph) {
      graph.add({ name: 'size-probe', order: 0, execute: (c) => sizes.push([c.width, c.height, c.view?.viewport]) });
    },
  });
  view = { id: 'a', index: 0, count: 2, viewport: [0, 0, 640, 720] };
  const split = h.gpu.record(() => h.frame());
  assert.deepEqual(sizes.pop(), [1280, 720, [0, 0, 640, 720]], 'one of two views is drawn unscaled');
  assert.equal(modules(split).length, 0, 'no upscale pipeline is built for it');
  view = { id: 'b', index: 0, count: 1, viewport: [0, 0, 1280, 720] };
  h.frame();
  assert.deepEqual(sizes.pop(), [640, 360, [0, 0, 640, 360]], 'a full-canvas view shrinks with the render size');
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});
