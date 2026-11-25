// KB-COMPAT-FRAMEALLOC1 part 5: submit and the canvas presents keep their lists between frames instead of making them
// each submit. What a submit, a present queue and a command buffer used twice did before must still hold.
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

/** A command buffer of one pass with `draws` draws on a fresh target. */
function buffer(d, draws) {
  const color = d.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 0x10 }),
    encoder = d.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    });
  pass.end();
  return encoder.finish();
}

test('submit takes an array, any iterable and a list with a spent command buffer in it', async () => {
  const d = await device(),
    errors = [];
  d.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error.message)));
  const before = d.passes.run;
  d.queue.submit([buffer(d), buffer(d)]);
  assert.equal(d.passes.run - before, 2);
  d.queue.submit(new Set([buffer(d)]));
  assert.equal(d.passes.run - before, 3);
  const spent = buffer(d);
  d.queue.submit([spent]);
  d.queue.submit([spent, buffer(d)]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(d.passes.run - before, 5, 'the spent buffer was refused, the new one ran');
  assert.deepEqual(errors, ['A command buffer can be submitted once']);
  // The list the queue keeps holds no command buffer after a submit.
  assert.ok(d.queue.submitting.every((cb) => cb === undefined));
});

test('a submit that fails on a destroyed resource runs nothing and the next submit is clean', async () => {
  const d = await device(),
    errors = [];
  d.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error.message)));
  const target = d.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 0x10 }),
    encoder = d.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [{ view: target.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    })
    .end();
  const doomed = encoder.finish();
  target.destroy();
  const before = d.passes.run;
  d.queue.submit([doomed, buffer(d)]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(d.passes.run, before, 'neither buffer ran');
  assert.match(errors[0], /uses .*destroyed/);
  d.queue.submit([buffer(d)]);
  assert.equal(d.passes.run, before + 1);
  assert.ok(d.queue.submitting.every((cb) => cb === undefined));
});

test('flushPresents shows each queued canvas once, in order, and drops what showing queues', async () => {
  const d = await device(),
    shown = [],
    a = { present: () => shown.push('a') },
    b = { present: () => (shown.push('b'), d.queuePresent(c)) },
    c = { present: () => shown.push('c') };
  d.queuePresent(a);
  d.queuePresent(b);
  d.queuePresent(a);
  d.flushPresents();
  assert.deepEqual(shown, ['a', 'b']);
  d.flushPresents();
  assert.deepEqual(shown, ['a', 'b'], 'c, queued while b showed, was dropped');
  d.queuePresent(c);
  d.flushPresents();
  assert.deepEqual(shown, ['a', 'b', 'c']);
  assert.equal(d.presentCount, 0);
});
