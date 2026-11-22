// KB-COMPAT-FIRSTTASK1: the compute part of the layer is loaded when requestDevice answers, so the first compute submit of
// a scene is not held in the queue (its task's frames and canvas present used to run in a later task).
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

async function device() {
  const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, 4096])),
    made = new Map(),
    context = {
      ...Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i])),
      HIGH_FLOAT: 0x8df2,
      FRAMEBUFFER_COMPLETE: 0x8cd5,
      checkFramebufferStatus: () => 0x8cd5,
      getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null),
      getParameter: (p) => values.get(p) ?? '',
      getShaderPrecisionFormat: (_s, type) =>
        type === 0x8df2
          ? { precision: 23, rangeMin: 127, rangeMax: 127 }
          : { precision: 0, rangeMin: 31, rangeMax: 30 },
    },
    gl = new Proxy(context, {
      get: (t, k) => {
        if (k in t) return t[k];
        if (!made.has(k))
          made.set(k, typeof k === 'string' && /^[A-Z0-9_]+$/.test(k) ? 0x9000 + made.size : () => ({}));
        return made.get(k);
      },
    });
  return (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice();
}

test('requestDevice answers with the compute runtime loaded, so a first compute submit runs at once', async () => {
  const d = await device();
  assert.ok(d.computeRuntime, 'the compute part had not loaded when requestDevice answered');
  const encoder = d.createCommandEncoder();
  encoder.beginComputePass().end();
  const queue = d.queue;
  queue.submit([encoder.finish()]);
  assert.equal(queue.waiting, null, 'the first compute submit waited in the queue');
});
