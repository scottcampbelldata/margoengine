// Depth video to points: the pinhole unprojection worked out by hand on small frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { depthVideoPoints, DepthVideoCloud } from '../dist/depth-video.js';

/** A side-by-side frame: colour left (`w` x `h`), depth right, from per-pixel functions. */
function frame(w, h, rgb, depth, { layout = 'side-by-side' } = {}) {
  const fw = layout === 'side-by-side' ? w * 2 : w,
    fh = layout === 'top-bottom' ? h * 2 : h,
    data = new Uint8Array(fw * fh * 4).fill(255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = rgb(x, y),
        d = depth(x, y),
        [dx, dy] = layout === 'side-by-side' ? [x + w, y] : [x, y + h];
      data.set([c[0], c[1], c[2], 255], (y * fw + x) * 4);
      data.set(d, (dy * fw + dx) * 4);
    }
  return { width: fw, height: fh, data };
}
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} against ${b}`);
// 90 degree vertical field of view on a 4 x 4 picture: fy = 2 / tan(45) = 2 pixels per metre of x at z = 1.
const options = { fov: 90, near: 1, far: 3, maxJump: 0 };

test('side-by-side gray depth unprojects through the pinhole: a pixel one step right and above the centre', () => {
  const f = frame(4, 4, (x, y) => [x * 10, y * 10, 99], () => [128, 0, 0, 255]);
  const out = depthVideoPoints(f, options);
  // gray 128 of 255 between near 1 and far 3: z = 1 + 128/255 * 2.
  const z = 1 + (128 / 255) * 2;
  assert.equal(out.count, 16);
  assert.equal(out.width, 4);
  // Pixel (3, 0): x = (3.5 - 2) z / fx with fx = fy = 2, y = (2 - 0.5) z / fy.
  const i = 3;
  near(out.positions[i * 3], (1.5 * z) / 2);
  near(out.positions[i * 3 + 1], (1.5 * z) / 2);
  near(out.positions[i * 3 + 2], -z);
  assert.deepEqual([...out.colors.slice(i * 3, i * 3 + 3)], [30, 0, 99]);
});

test('a stored 0 is a hole, invert swaps near and far, millimetres and rg16 are read as 16 bits', () => {
  const holes = depthVideoPoints(frame(2, 2, () => [1, 2, 3], (x) => [x ? 255 : 0, 0, 0, 255]), options);
  assert.equal(holes.count, 2);
  near(holes.positions[2], -3);
  const inverted = depthVideoPoints(frame(2, 2, () => [1, 2, 3], () => [255, 0, 0, 255]), { ...options, invert: true });
  near(inverted.positions[2], -1);
  const mm = depthVideoPoints(frame(2, 2, () => [0, 0, 0], () => [0x07, 0xd0, 0, 255]), { ...options, encoding: 'millimeters' }); // 2000 mm
  near(mm.positions[2], -2);
  const rg = depthVideoPoints(frame(2, 2, () => [0, 0, 0], () => [0x80, 0x00, 0, 255]), { ...options, encoding: 'rg16' });
  near(rg.positions[2], -(1 + (0x8000 / 65535) * 2));
  const outside = depthVideoPoints(frame(2, 2, () => [0, 0, 0], () => [0x27, 0x10, 0, 255]), { ...options, encoding: 'millimeters' }); // 10 m
  assert.equal(outside.count, 0);
});

test('flying pixels along a depth jump are dropped, stride subsamples, explicit intrinsics override fov', () => {
  // The right column is 1 m further than the left: with maxJump 0.1 both columns border a jump.
  const f = frame(4, 4, () => [0, 0, 0], (x) => [x < 2 ? 64 : 192, 0, 0, 255]);
  assert.equal(depthVideoPoints(f, { ...options, maxJump: 0.05 }).count, 8);
  assert.equal(depthVideoPoints(f, { ...options, maxJump: 0 }).count, 16);
  assert.equal(depthVideoPoints(f, { ...options, stride: 2 }).count, 4);
  const k = depthVideoPoints(f, { ...options, intrinsics: { fx: 1, fy: 1, cx: 0, cy: 0 } });
  near(k.positions[0], (0.5 * (1 + (64 / 255) * 2)) / 1);
});

test('top-bottom and separate layouts', () => {
  const top = frame(2, 2, () => [5, 6, 7], () => [255, 0, 0, 255], { layout: 'top-bottom' });
  assert.equal(depthVideoPoints(top, { ...options, layout: 'top-bottom' }).count, 4);
  const colour = { width: 2, height: 2, data: new Uint8Array(16).fill(9) };
  const depth = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) };
  const sep = depthVideoPoints(colour, { ...options, layout: 'separate' }, depth);
  assert.equal(sep.count, 4);
  near(sep.positions[2], -3);
  assert.throws(() => depthVideoPoints(colour, { ...options, layout: 'separate' }), /second argument/);
});

test('options and pictures are validated', () => {
  const f = frame(2, 2, () => [0, 0, 0], () => [9, 0, 0, 255]);
  assert.throws(() => depthVideoPoints(f, { near: 2, far: 1 }), /near/);
  assert.throws(() => depthVideoPoints(f, { fov: 0 }), /fov/);
  assert.throws(() => depthVideoPoints(f, { stride: 0 }), /stride/);
  assert.throws(() => depthVideoPoints(f, { layout: 'diagonal' }), /layout/);
  assert.throws(() => depthVideoPoints(f, { encoding: 'float' }), /encoding/);
  assert.throws(() => depthVideoPoints({ width: 4, height: 4, data: new Uint8Array(4) }), /empty or shorter/);
  assert.throws(() => depthVideoPoints({ width: 3, height: 2, data: new Uint8Array(24) }), /even/);
});

test('DepthVideoCloud keeps its point count and hides holes with size 0', () => {
  const video = new DepthVideoCloud({ width: 2, height: 2, ...options });
  assert.equal(video.count, 4);
  assert.equal(video.cloud.count, 4);
  const shown = video.update(frame(2, 2, (x) => [x * 100, 0, 0], (x) => [x ? 255 : 0, 0, 0, 255]));
  assert.equal(shown, 2);
  assert.deepEqual([...video.cloud.sizes], [0, 1, 0, 1]);
  assert.equal(video.cloud.positions[5], -3);
  assert.equal(video.update(frame(2, 2, () => [0, 0, 0], () => [128, 0, 0, 255])), 4);
  assert.deepEqual([...video.cloud.sizes], [1, 1, 1, 1]);
  assert.throws(() => video.update(frame(4, 4, () => [0, 0, 0], () => [1, 0, 0, 255])), /made for 2 x 2/);
  assert.throws(() => new DepthVideoCloud({ width: 0, height: 2 }), /width/);
  video[Symbol.dispose]();
});
