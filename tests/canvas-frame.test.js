// scripts/support/canvas-frame.js: a WebGPU canvas read after the task that drew its frame must throw on every run.
// The terrain overlays check read its canvas after a mapAsync and saw transparent black whenever the browser presented
// in between (2026-11-10, only on a busy machine). Regression: packages/terrain/test/overlays.browser.mjs reads through
// readCanvas and threw on every run with the old order (read after the probe).
import assert from 'node:assert/strict';
import test from 'node:test';
import { frameIsCurrent, readCanvas, watchCanvas } from '../scripts/support/canvas-frame.js';

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const fakeCanvas = () => {
  const context = { getCurrentTexture: () => 'texture' },
    canvas = { width: 2, height: 2, context, getContext: (type) => (type === 'webgpu' ? context : null) };
  return canvas;
};

test('a WebGPU canvas frame is current until its task ends, and readCanvas refuses it after', async () => {
  const canvas = fakeCanvas();
  assert.throws(() => frameIsCurrent(canvas), /watchCanvas/);
  watchCanvas(canvas);
  watchCanvas(canvas); // a second call does not wrap the wrapper
  assert.equal(frameIsCurrent(canvas), false, 'no frame drawn yet');
  assert.equal(canvas.context.getCurrentTexture(), 'texture');
  assert.equal(frameIsCurrent(canvas), true);
  await Promise.resolve();
  assert.equal(frameIsCurrent(canvas), true, 'a microtask is still the same task');
  await nextTask();
  assert.equal(frameIsCurrent(canvas), false, 'the task that drew the frame has ended');
  assert.throws(() => readCanvas(canvas), /read after the task that drew the frame ended/);
  canvas.context.getCurrentTexture();
  assert.equal(frameIsCurrent(canvas), true, 'a new frame is current again');
});

test('watchCanvas refuses a canvas without a webgpu context', () => {
  assert.throws(() => watchCanvas({ getContext: () => null }), /webgpu context/);
});
