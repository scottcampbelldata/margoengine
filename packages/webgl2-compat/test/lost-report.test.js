// A GPU reset is the device's loss, never the layer's own link failure or an incomplete framebuffer
// (KB-COMPAT-LOSSREPORT1). Chrome answers the synchronous query that waited for the reset as a lost context does
// (LINK_STATUS false with an empty log, checkFramebufferStatus FRAMEBUFFER_UNSUPPORTED, getError NO_ERROR) but sets
// isContextLost() only in a later task: measured on an RTX A6000 under ANGLE Direct3D 11, a link failed at 5,482 ms
// with isContextLost() false, and the next task saw the context lost. The stand-in context here answers the same way.
// On a live context the same failures are still reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

const task = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A stand-in context. `reset()` makes it answer as Chrome does in the task that met a GPU reset: every link fails and
 * every framebuffer is FRAMEBUFFER_UNSUPPORTED, while isContextLost() stays false until a task queued at the reset runs.
 * `broken` makes it fail the same way on a live context (a real layer bug or incomplete framebuffer).
 */
async function stand() {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((_, i) => [0x1000 + i, 4096]));
  const state = { lost: false, failing: false, samples: [4, 1] };
  const failed = () => {
    if (state.failing === 'reset' && !state.queued) {
      state.queued = true;
      setTimeout(() => (state.lost = true), 0);
    }
    return state.failing !== false;
  };
  const context = {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    LINK_STATUS: 0x8b82,
    DRAW_FRAMEBUFFER: 0x8ca9,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    RENDERBUFFER: 0x8d41,
    SAMPLES: 0x80a9,
    RGBA8: 0x8058,
    R32UI: 0x8236,
    RGBA8_SNORM: 0x8f97,
    checkFramebufferStatus: () => (failed() ? 0x8cdd : 0x8cd5),
    // A lost context answers every query with null; a live one lists a format's sample counts.
    getInternalformatParameter: () => (failed() || state.lost ? null : new Int32Array(state.samples)),
    getProgramParameter: () => !failed(),
    getProgramInfoLog: () => (state.failing === 'broken' ? 'L0001: a real link error' : ''),
    getError: () => 0,
    isContextLost: () => state.lost,
    getExtension(name) {
      if (name === 'WEBGL_lose_context') return { loseContext: () => (state.lost = true) };
      return name === 'EXT_color_buffer_float' ? {} : null;
    },
    getParameter: (p) => (p === 0x1f01 ? 'Stand-in renderer' : (values.get(p) ?? '')),
    getShaderPrecisionFormat: (_shader, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
  };
  const gl = new Proxy(context, { get: (c, key) => (key in c ? c[key] : () => ({})) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error)));
  let lost = null;
  device.lost.then((info) => (lost = info.reason));
  return {
    device,
    errors,
    lost: () => lost,
    reset: () => (state.failing = 'reset'),
    broken: () => (state.failing = 'broken'),
    lose: () => (state.lost = true),
    samples: (counts) => (state.samples = counts),
  };
}

/** A colour attachment the replayer's framebuffer cache accepts. */
const attachment = () => ({ key: 'a', owner: { framebuffers: new Set() }, attach() {} });
const helperSource = 'out vec4 c;\nvoid main() { c = vec4(1.0); }';

test("a GPU reset met by the layer's own program link loses the device, with no throw and no error", async () => {
  const s = await stand();
  s.reset();
  assert.doesNotThrow(() => s.device.replayer.helper('lost-report', helperSource));
  await task();
  await task();
  assert.equal(s.lost(), 'unknown');
  assert.deepEqual(s.errors, []);
});

test('a GPU reset met by a framebuffer status loses the device; its scope resolves null', async () => {
  const s = await stand();
  s.device.pushErrorScope('validation');
  s.reset();
  s.device.replayer.makeFramebuffer([attachment()], 1, null, null);
  assert.equal(await s.device.popErrorScope(), null);
  await task();
  assert.equal(s.lost(), 'unknown');
  // Uncaptured too.
  const t = await stand();
  t.reset();
  t.device.replayer.makeFramebuffer([attachment()], 1, null, null);
  await task();
  await task();
  assert.equal(t.lost(), 'unknown');
  assert.deepEqual(t.errors, []);
});

/** A 4x colour target of `format`, as a frame's own attachments are made. */
const multisampled = (device, format = 'rgba8unorm') =>
  device.createTexture({ size: [4, 4], format, sampleCount: 4, usage: 0x10 });

test('a 4x texture made at a reset or on a lost context is not refused as unsupported (KB-COMPAT-LOSTMSAA1)', async () => {
  for (const loss of ['reset', 'lose']) {
    const s = await stand();
    s[loss]();
    assert.doesNotThrow(() => multisampled(s.device), loss);
    assert.deepEqual(s.errors, [], loss);
  }
});

test('on a live context a format without 4x samples is still refused', async () => {
  const s = await stand();
  // An integer format lists no 4x count; a format with no renderbuffer answers null.
  s.samples([]);
  assert.throws(() => multisampled(s.device, 'r32uint'), /4x multisampled r32uint textures/);
  const t = await stand();
  t.broken();
  assert.throws(() => multisampled(t.device, 'rgba8snorm'), /4x multisampled rgba8snorm textures/);
});

test('an async pipeline that failed at a reset resolves on the lost device', async () => {
  const s = await stand();
  s.reset();
  s.device.replayer.helper('lost-report', helperSource);
  const pipeline = {};
  assert.equal(await s.device.settlePipeline(pipeline, 'WebGL2 refused the translated program: '), pipeline);
  assert.equal(s.lost(), 'unknown');
});

test('on a live context a link failure and an incomplete framebuffer are still reported', async () => {
  const s = await stand();
  s.broken();
  s.device.replayer.helper('lost-report', helperSource);
  s.device.pushErrorScope('validation');
  s.device.replayer.makeFramebuffer([attachment()], 1, null, null);
  const scoped = await s.device.popErrorScope();
  assert.equal(scoped?.name, 'GPUValidationError');
  assert.match(scoped.message, /status 0x8cdd/);
  await task();
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].name, 'GPUInternalError');
  assert.match(s.errors[0].message, /own lost-report program did not link \(a bug: report it\): L0001/);
  // The broken program is reported once, not again at every use.
  s.device.replayer.helper('lost-report', helperSource);
  await task();
  assert.equal(s.errors.length, 1);
  await assert.rejects(s.device.settlePipeline({}, 'refused'), { name: 'GPUPipelineError' });
  assert.equal(s.lost(), null);
});
