// KB-COMPAT-FBSTATUS1: the layer read checkFramebufferStatus once per new framebuffer and once per new texture's
// zeroing. Each read waits for the GPU process to run every command before it, and ten-thousand-trees' first frame made
// 2,473 of them (1.7 s of its longest task on ANGLE Direct3D 11). Completeness is a function of what is attached (GL ES
// 3.0.6 section 4.4.4; WebGL 2.0 adds equal sizes and one image per colour point), so the layer now checks once per
// attachment signature: kind, internal format, size and point. The counts here are of status reads; no time is
// asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

const COMPLETE = 0x8cd5,
  INCOMPLETE_ATTACHMENT = 0x8cd6,
  RENDER_ATTACHMENT = 0x10,
  TEXTURE_BINDING = 0x04;

/** A device on a stand-in context that counts status reads and answers `state.status`. */
async function stand() {
  const state = { checks: 0, status: COMPLETE },
    values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, 4096])),
    context = {
      ...Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i])),
      HIGH_FLOAT: 0x8df2,
      FRAMEBUFFER_COMPLETE: COMPLETE,
      checkFramebufferStatus: () => (state.checks++, state.status),
      getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null),
      isContextLost: () => false,
      getError: () => 0,
      getParameter: (p) => values.get(p) ?? '',
      getShaderPrecisionFormat: (_s, type) =>
        type === 0x8df2
          ? { precision: 23, rangeMin: 127, rangeMax: 127 }
          : { precision: 0, rangeMin: 31, rangeMax: 30 },
    };
  const constants = new Map(),
    gl = new Proxy(context, {
      get: (c, key) =>
        key in c
          ? c[key]
          : typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)
            ? (constants.get(key) ?? constants.set(key, 0x9000 + constants.size).get(key))
            : () => ({}),
    });
  const device = await (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice(),
    errors = [];
  device.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error.message)));
  state.checks = 0;
  return { device, state, errors };
}

/**
 * Makes the textures `make` answers (the layer zeroes each as it allocates it) and clears each in a render pass of its
 * own, all in one submit; answers the status reads made.
 */
function clearAll(s, make) {
  const from = s.state.checks,
    textures = make(),
    e = s.device.createCommandEncoder();
  for (const t of textures)
    e.beginRenderPass({
      colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store' }],
    }).end();
  s.device.queue.submit([e.finish()]);
  return s.state.checks - from;
}

const target = (s, size, format = 'rgba8unorm') =>
  s.device.createTexture({
    size,
    format,
    usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
  });

test('framebuffers of one attachment signature read checkFramebufferStatus once', async () => {
  const s = await stand();
  assert.equal(
    clearAll(s, () => Array.from({ length: 6 }, () => target(s, [8, 8]))),
    2,
    "one read for the textures' zeroing, one for their six framebuffers",
  );
  assert.equal(
    clearAll(s, () => [target(s, [8, 8]), target(s, [8, 8])]),
    0,
    'later ones of that signature read none',
  );
  assert.equal(
    clearAll(s, () => [target(s, [16, 8])]),
    1,
    'another size is another framebuffer signature, the same zeroing',
  );
  assert.equal(
    clearAll(s, () => [target(s, [8, 8], 'rgba16float')]),
    2,
    'another format is another signature for both',
  );
  assert.deepEqual(s.errors, []);
  s.device.destroy();
});

test('an incomplete signature is read once and still reported for every framebuffer that has it', async () => {
  const s = await stand();
  s.state.status = INCOMPLETE_ATTACHMENT;
  assert.equal(
    clearAll(s, () => [target(s, [4, 4], 'r32float'), target(s, [4, 4], 'r32float')]),
    2,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(s.errors.length, 2, 'each framebuffer reports');
  for (const m of s.errors) assert.match(m, /complete WebGL2 framebuffer \(status 0x8cd6\)/);
  s.device.destroy();
});
