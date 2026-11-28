// A synchronous createRenderPipeline leaves its link to the driver's threads (KHR_parallel_shader_compile) instead of
// reading LINK_STATUS at once, which waits for the link (KB-COMPAT-SYNCLINK1). In demos/ten-thousand-trees on ANGLE
// Direct3D 11 that read made the GPU process's workers compile one program at a time for 15 s while the page waited.
// The count here is of LINK_STATUS reads made before the driver reports a link done, a work count; no time is asserted.
// The link is still checked: at the first draw, by the pop of the scope the pipeline was made in, or by itself soon
// after the driver finishes, and a refused program is reported to that scope or as an uncaptured error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

const LINK_STATUS = 0x8b82,
  COMPLETION_STATUS_KHR = 0x91b1;

/** A stand-in WebGL2 whose links finish when `finish()` is called; `refuse` makes every link fail. */
async function stand({ parallel = true } = {}) {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((_, i) => [0x1000 + i, 4096]));
  const state = { linked: false, refuse: false, reads: 0, early: 0 };
  const context = {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    VERTEX_SHADER: 0x8b31,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    LINK_STATUS,
    INVALID_INDEX: 0xffffffff,
    getProgramParameter(_program, pname) {
      if (pname === COMPLETION_STATUS_KHR) return state.linked;
      if (pname !== LINK_STATUS) return 0;
      state.reads++;
      if (!state.linked) state.early++;
      return !state.refuse;
    },
    getUniformBlockIndex: () => 0xffffffff,
    getProgramInfoLog: () => (state.refuse ? 'L0001: refused by the stand-in' : ''),
    getShaderInfoLog: () => '',
    getError: () => 0,
    isContextLost: () => false,
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
  // The device's own probe programs read theirs at creation: count only what pipelines read.
  Object.assign(state, { reads: 0, early: 0 });
  const errors = [];
  device.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error)));
  return { device, state, errors, finish: () => (state.linked = true) };
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

/** Waits up to `tasks` timer turns for `done()` (the layer polls the driver every few milliseconds). */
async function until(done, tasks = 200) {
  for (let i = 0; i < tasks && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  return done();
}

test('pipelines made together read no LINK_STATUS before the driver reports their links done', async () => {
  const s = await stand();
  for (let i = 0; i < 4; i++) pipeline(s.device, i / 4);
  assert.equal(s.state.reads, 0, 'no link status is read while the driver links');
  await until(() => false, 5);
  assert.equal(s.state.reads, 0, 'polling the completion status reads no link status');
  s.finish();
  assert.ok(await until(() => s.device.linking.size === 0), 'every deferred link is checked once the driver is done');
  assert.equal(s.state.reads, 4);
  assert.equal(s.state.early, 0);
  assert.deepEqual(s.errors, []);
});

test('a refused program made in a validation scope reports to that scope once its link is known', async () => {
  const s = await stand();
  s.state.refuse = true;
  s.device.pushErrorScope('validation');
  pipeline(s.device, 0.5);
  let popped = false;
  const scoped = s.device.popErrorScope().then((error) => ((popped = true), error));
  await until(() => false, 5);
  assert.equal(popped, false, 'the pop waits for the link');
  assert.equal(s.state.early, 0, 'and does not wait for it by reading LINK_STATUS');
  s.finish();
  const error = await scoped;
  assert.equal(error?.name, 'GPUValidationError');
  assert.match(error.message, /refused the translated program: L0001/);
  assert.deepEqual(s.errors, [], 'reported to its scope only');
});

test('a refused program made outside any scope is an uncaptured error once its link is known', async () => {
  const s = await stand();
  s.state.refuse = true;
  pipeline(s.device, 0.25);
  s.device.pushErrorScope('validation');
  // A scope opened after the pipeline was made does not take its error.
  const later = s.device.popErrorScope();
  s.finish();
  assert.equal(await later, null);
  assert.ok(await until(() => s.errors.length === 1));
  assert.match(s.errors[0].message, /refused the translated program/);
});

test('a synchronous compute pipeline reads no LINK_STATUS until its first dispatch', async () => {
  const s = await stand();
  await s.device.loadCompute();
  const module = s.device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { data[id.x] = id.x * 3u; }`,
  });
  const compute = s.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  assert.notEqual(compute.built?.tier, 'cpu', 'the kernel runs as a draw');
  assert.equal(s.state.reads, 0, 'no link status is read when the pipeline is made');
});

test('without KHR_parallel_shader_compile the link is checked when the pipeline is made', async () => {
  const s = await stand({ parallel: false });
  s.finish();
  pipeline(s.device, 0.75);
  assert.equal(s.state.reads, 1);
  assert.equal(s.device.linking.size, 0);
});
