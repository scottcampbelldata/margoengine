// KB-QUALITY-WARMSERIAL1: @margoengine/quality/warm warmed ten-thousand-trees on this layer one pipeline per round (45
// rounds, each waiting for one async link, a warm draw and a fence), so the page took 33 s to start where the
// synchronous first frame, which linked every program side by side, took 18 s. With KHR_parallel_shader_compile the
// queue now carries a link hold (Symbol.for('margoengine.queue.holdsLinks')): while it is on, a submit that may use a
// program still linking waits in the queue, with the writes and submits after it in order, until each of those
// programs has linked and drawn once, so a whole warm frame links side by side and replays without a waiting read.
// Every count here is of work (links started, LINK_STATUS reads before the driver reports a link done, draws); no time
// is asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

const LINK_STATUS = 0x8b82,
  COMPLETION_STATUS_KHR = 0x91b1,
  HOLDS_LINKS = Symbol.for('margoengine.queue.holdsLinks');

/** A stand-in WebGL2 whose links finish when `finish()` is called; it logs draws and buffer writes in order. */
async function stand({ parallel = true, clock = null } = {}) {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((_, i) => [0x1000 + i, 4096]));
  const state = { linked: false, links: 0, reads: 0, early: 0 },
    log = [];
  const context = {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    VERTEX_SHADER: 0x8b31,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    LINK_STATUS,
    INVALID_INDEX: 0xffffffff,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    checkFramebufferStatus: () => 0x8cd5,
    linkProgram: () => state.links++,
    getProgramParameter(_program, pname) {
      if (pname === COMPLETION_STATUS_KHR) return state.linked;
      if (pname !== LINK_STATUS) return 0;
      state.reads++;
      if (!state.linked) state.early++;
      return true;
    },
    getUniformBlockIndex: () => 0xffffffff,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    getError: () => 0,
    isContextLost: () => false,
    // With a clock (see sliced), each draw takes 30 ms of it and each fence poll is logged.
    drawArrays: () => (log.push('draw'), clock && (clock.now += 30)),
    drawArraysInstanced: () => (log.push('draw'), clock && (clock.now += 30)),
    clientWaitSync: () => (clock && log.push('fence'), 0x911a),
    bufferSubData: () => log.push('write'),
    getExtension(name) {
      if (name === 'KHR_parallel_shader_compile') return parallel ? { COMPLETION_STATUS_KHR } : null;
      return name === 'EXT_color_buffer_float' ? {} : null;
    },
    getParameter: (p) => (p === 0x1f01 ? 'Stand-in renderer' : (values.get(p) ?? '')),
    getShaderPrecisionFormat: (_shader, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
  };
  // Any other GL constant gets a number of its own; any other call does nothing.
  const constants = new Map();
  const gl = new Proxy(context, {
    get: (c, key) =>
      key in c
        ? c[key]
        : typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)
          ? (constants.get(key) ?? constants.set(key, 0x9000 + constants.size).get(key))
          : () => ({}),
  });
  const device = await (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice();
  // The device's own probe programs link and draw at creation: count only what the test makes.
  Object.assign(state, { links: 0, reads: 0, early: 0 });
  log.length = 0;
  const errors = [];
  device.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error)));
  return { device, state, log, errors, finish: () => (state.linked = true) };
}

/** A render pipeline whose fragment writes `red`, so each `red` is a program of its own. */
function pipeline(device, red) {
  const module = device.createShaderModule({
    code: `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i), 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(${red.toFixed(2)}, 0.0, 0.0, 1.0); }`,
  });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
}

/** One command buffer drawing a triangle with each of `pipelines` into `target`. */
function frame(device, target, pipelines) {
  const encoder = device.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
  for (const p of pipelines) {
    pass.setPipeline(p);
    pass.draw(3);
  }
  pass.end();
  return encoder.finish();
}

/** Waits up to `tasks` timer turns for `done()` (the layer polls the driver every few milliseconds). */
async function until(done, tasks = 200) {
  for (let i = 0; i < tasks && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  return done();
}

const setup = (device) => ({
  target: device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 }),
  buffer: device.createBuffer({ size: 16, usage: 0x48 }),
});

test('with the link hold on, a frame links its programs side by side and replays once all can draw', async () => {
  const s = await stand(),
    { target, buffer } = setup(s.device),
    hold = s.device.queue[HOLDS_LINKS];
  assert.equal(typeof hold, 'function', 'the queue carries the link hold');
  hold(true);
  const made = [0, 0.25, 0.5, 0.75].map((red) => pipeline(s.device, red));
  s.device.queue.submit([frame(s.device, target, made)]);
  s.device.queue.writeBuffer(buffer, 0, new Float32Array([1, 2, 3, 4]));
  s.device.queue.submit([frame(s.device, target, made.slice(0, 1))]);
  hold(false);
  let done = false;
  const work = s.device.queue.onSubmittedWorkDone().then(() => (done = true));
  assert.equal(s.state.links, 4, 'all four links started before any finished');
  await until(() => false, 5);
  assert.equal(s.state.early, 0, 'no link status is read while the driver links');
  assert.deepEqual(s.log, [], 'nothing draws or writes while links are pending');
  assert.equal(done, false, 'the held submits are not done');
  s.finish();
  await work;
  assert.deepEqual(s.log, ['draw', 'draw', 'draw', 'draw', 'write', 'draw'], 'draws and writes keep their order');
  assert.equal(s.state.early, 0, 'the replay reads no link status before it is known');
  assert.deepEqual(s.errors, []);
  // Off again: a frame that makes nothing new replays at once.
  s.device.queue.submit([frame(s.device, target, made.slice(1, 2))]);
  assert.equal(s.log.at(-1), 'draw');
  s.device.destroy();
});

test('with the link hold off, the first draw waits for its link as before', async () => {
  const s = await stand(),
    { target } = setup(s.device);
  const made = [0.1, 0.2].map((red) => pipeline(s.device, red));
  s.device.queue.submit([frame(s.device, target, made)]);
  assert.deepEqual(s.log, ['draw', 'draw'], 'the submit replays at once');
  assert.ok(s.state.early > 0, 'and its draws read link status the driver has not reported yet');
  s.device.destroy();
});

test('without KHR_parallel_shader_compile the queue carries no link hold', async () => {
  const s = await stand({ parallel: false });
  assert.equal(s.device.queue[HOLDS_LINKS], undefined);
  s.device.destroy();
});

/** Runs `body` with performance.now() reading `clock.now`, so a replay's slices fall on counted work, not on time. */
async function sliced(body) {
  const clock = { now: 0 },
    now = performance.now;
  performance.now = () => clock.now;
  try {
    await body(clock);
  } finally {
    performance.now = now;
  }
}

/** One command buffer with a render pass per pipeline, each pass drawing one triangle into `target`. */
function passes(device, target, pipelines) {
  const encoder = device.createCommandEncoder();
  for (const p of pipelines) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(p);
    pass.draw(3);
    pass.end();
  }
  return encoder.finish();
}

// The held frame's replay ran in one task: ten-thousand-trees' longest task on ANGLE Direct3D 11 (3.5 s), as every
// read in it that waits for the GPU process paid for all the GPU work before it. It now runs in tasks of about 50 ms,
// a command buffer stopping between render passes, and each task after the first starts after a fence has passed.
test('a held frame replays in slices, between render passes, each after a fence, in order', async () => {
  await sliced(async (clock) => {
    const s = await stand({ clock }),
      { target, buffer } = setup(s.device),
      hold = s.device.queue[HOLDS_LINKS];
    hold(true);
    const made = [0.1, 0.3, 0.5, 0.7].map((red) => pipeline(s.device, red));
    s.device.queue.submit([passes(s.device, target, made)]);
    s.device.queue.writeBuffer(buffer, 0, new Float32Array([1, 2, 3, 4]));
    s.device.queue.submit([passes(s.device, target, made.slice(0, 1))]);
    hold(false);
    assert.deepEqual(s.log, [], 'nothing replays while links are pending');
    s.finish();
    await s.device.queue.onSubmittedWorkDone();
    assert.deepEqual(
      s.log.filter((e) => e !== 'fence'),
      ['draw', 'draw', 'draw', 'draw', 'write', 'draw'],
      'draws and writes keep their order',
    );
    const replay = s.log.slice(0, s.log.lastIndexOf('draw') + 1);
    assert.deepEqual(
      replay,
      ['draw', 'draw', 'fence', 'draw', 'draw', 'fence', 'write', 'draw'],
      'two 30 ms passes a slice, a fence before each later slice',
    );
    assert.equal(s.state.early, 0);
    assert.deepEqual(s.errors, []);
    // Nothing waits: a submit replays inside the call, whole, however long it takes.
    s.log.length = 0;
    s.device.queue.submit([passes(s.device, target, made)]);
    assert.deepEqual(s.log, ['draw', 'draw', 'draw', 'draw']);
    s.device.destroy();
  });
});
