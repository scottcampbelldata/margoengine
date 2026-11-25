// KB-COMPAT-FRAMEALLOC1 part 4: an encoder's commands are a tape (src/device/tape.ts), not a closure each. The replay
// must do what the closures did: the same calls, in order, with the same numbers, for every way a caller may give them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

async function device() {
  const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, 4096])),
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
      getProgramParameter: () => true,
      getShaderParameter: () => true,
      getActiveUniformBlockParameter: () => 0,
      getUniformBlockIndex: () => 0,
      getAttribLocation: () => 0,
    },
    made = new Map(),
    // Every other upper-case name is a distinct GL enum number; every other name a call that returns a new object.
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

/** Logs each call the replayer gets from a tape, with its arguments (a typed or plain list as an array). */
function spy(d) {
  const log = [],
    r = d.replayer;
  for (const name of [
    'setPipeline',
    'setVertexBuffer',
    'setIndexBuffer',
    'draw',
    'drawIndexed',
    'setViewport',
    'setScissor',
    'setBlendConstant',
    'setStencilReference',
    'beginQuery',
    'endQuery',
    'executeBundles',
    'endPass',
  ]) {
    r[name] = (...args) => log.push([name, ...args.map((a) => (ArrayBuffer.isView(a) ? [...a] : a))]);
  }
  r.setBindGroup = (index, group, offsets, from = 0, count = offsets.length) =>
    log.push(['setBindGroup', index, group, [...offsets].slice(from, from + count)]);
  r.beginPass = (desc) =>
    log.push([
      'beginPass',
      desc.colors.length,
      desc.colors.map((c) => c && [c.depthSlice, [...c.clearValue], c.loadOp, c.storeOp]),
      desc.depth && [desc.depth.depthClearValue, desc.depth.depthReadOnly, desc.depth.stencilClearValue],
    ]);
  return log;
}

test('a recorded pass replays every command in order with its numbers', async () => {
  const d = await device(),
    log = spy(d),
    color = d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 }),
    depth = d.createTexture({ size: [4, 4], format: 'depth24plus', usage: 0x10 }),
    vertex = d.createBuffer({ size: 64, usage: 0x20 }),
    index = d.createBuffer({ size: 64, usage: 0x10 }),
    layout = d.createBindGroupLayout({ entries: [] }),
    group = d.createBindGroup({ layout, entries: [] }),
    encoder = d.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: color.createView(), clearValue: { r: 1, g: 0.5, b: 0.25, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 0.5, depthReadOnly: false },
    });
  pass.setBindGroup(0, group);
  pass.setBindGroup(1, group, [16, 32]);
  pass.setBindGroup(2, group, new Set([48]));
  pass.setBindGroup(3, group, Uint32Array.of(9, 64, 128, 7), 1, 2);
  pass.setVertexBuffer(1, vertex, 8, 16);
  pass.setVertexBuffer(2, null);
  pass.setIndexBuffer(index, 'uint16', 4);
  pass.setIndexBuffer(index, 'uint32');
  pass.setViewport(1, 2, 3, 4, 0.25, 0.75);
  pass.setScissorRect(5, 6, 7, 8);
  pass.setBlendConstant([0.1, 0.2, 0.3, 0.4]);
  pass.setBlendConstant({ r: 1, g: 2, b: 3, a: 4 });
  pass.setStencilReference(9);
  pass.draw(3, 2, 1, 4);
  pass.drawIndexed(6, 3, 2, -5, 1);
  pass.end();
  d.queue.submit([encoder.finish()]);
  assert.deepEqual(log, [
    ['beginPass', 1, [[0, [1, 0.5, 0.25, 0], 'clear', 'store']], [0.5, false, 0]],
    ['setBindGroup', 0, group, []],
    ['setBindGroup', 1, group, [16, 32]],
    ['setBindGroup', 2, group, [48]],
    ['setBindGroup', 3, group, [64, 128]],
    ['setVertexBuffer', 1, vertex, 8],
    ['setVertexBuffer', 2, null, 0],
    ['setIndexBuffer', index, 'uint16', 4],
    ['setIndexBuffer', index, 'uint32', 0],
    ['setViewport', 1, 2, 3, 4, 0.25, 0.75],
    ['setScissor', 5, 6, 7, 8],
    ['setBlendConstant', 0.1, 0.2, 0.3, 0.4],
    ['setBlendConstant', 1, 2, 3, 4],
    ['setStencilReference', 9],
    ['draw', 3, 2, 1, 4],
    ['drawIndexed', 6, 3, 2, -5, 1],
    ['endPass'],
  ]);
});

/** A pass of one cleared colour target, with a pipeline-free draw list. */
async function scene() {
  const d = await device(),
    log = spy(d),
    color = d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 }),
    layout = d.createBindGroupLayout({ entries: [] }),
    group = d.createBindGroup({ layout, entries: [] }),
    desc = {
      colorAttachments: [{ view: color.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    };
  return { d, log, color, group, desc };
}

test('the pass descriptor is copied when the pass begins: a caller may change theirs', async () => {
  const { d, log, desc } = await scene(),
    encoder = d.createCommandEncoder(),
    pass = encoder.beginRenderPass(desc);
  desc.colorAttachments[0].clearValue[0] = 0.75;
  desc.colorAttachments[0].loadOp = 'load';
  pass.end();
  d.queue.submit([encoder.finish()]);
  assert.deepEqual(log[0], ['beginPass', 1, [[0, [0, 0, 0, 1], 'clear', 'store']], undefined]);
});

test("a command buffer's tape goes to the next encoder once the buffer has replayed, and replays the next frame afresh", async () => {
  const { d, log, group, desc } = await scene(),
    frame = (draws) => {
      const encoder = d.createCommandEncoder(),
        pass = encoder.beginRenderPass(desc);
      pass.setBindGroup(0, group, [4 * draws]);
      for (let i = 0; i < draws; i++) pass.draw(3 + i);
      pass.end();
      return encoder;
    },
    first = frame(3),
    tape = first.tape;
  d.queue.submit([first.finish()]);
  assert.equal(log.filter(([name]) => name === 'draw').length, 3);
  log.length = 0;
  // The next encoder takes the finished buffer's tape, emptied: no object of the last frame is held.
  const second = frame(1);
  assert.equal(second.tape, tape, 'the tape is reused');
  assert.equal(tape.ol, 2, "its pass snapshot and its bind group only: none of the first frame's objects is held");
  d.queue.submit([second.finish()]);
  assert.deepEqual(log, [
    ['beginPass', 1, [[0, [0, 0, 0, 1], 'clear', 'store']], undefined],
    ['setBindGroup', 0, group, [4]],
    ['draw', 3, 1, 0, 0],
    ['endPass'],
  ]);
  assert.equal(tape.ol, 0);
  assert.ok(
    tape.objs.every((o) => o === undefined),
    'a pooled tape keeps no object alive',
  );
});

test('a long frame grows its tape and replays every command', async () => {
  const { d, log, group, desc } = await scene(),
    encoder = d.createCommandEncoder(),
    pass = encoder.beginRenderPass(desc);
  for (let i = 0; i < 1500; i++) {
    pass.setBindGroup(i % 4, group, [i, i + 1, i + 2]);
    pass.draw(i, 1, i, 0);
  }
  pass.end();
  d.queue.submit([encoder.finish()]);
  assert.equal(log.length, 1 + 3000 + 1);
  assert.deepEqual(log[1 + 2 * 1499], ['setBindGroup', 1499 % 4, group, [1499, 1500, 1501]]);
  assert.deepEqual(log[2 + 2 * 1499], ['draw', 1499, 1, 1499, 0]);
});

test('a render bundle keeps its own tape and replays in every pass that executes it', async () => {
  const { d, log, group, desc } = await scene(),
    bundleEncoder = d.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
  bundleEncoder.setBindGroup(0, group, [8]);
  bundleEncoder.draw(5);
  const bundle = bundleEncoder.finish();
  for (let frame = 0; frame < 2; frame++) {
    const encoder = d.createCommandEncoder(),
      pass = encoder.beginRenderPass(desc);
    pass.executeBundles([bundle]);
    pass.end();
    d.queue.submit([encoder.finish()]);
  }
  const names = log.map(([name]) => name);
  assert.deepEqual(names, ['beginPass', 'executeBundles', 'endPass', 'beginPass', 'executeBundles', 'endPass']);
  assert.equal(log[1][1][0], bundle);
});

test('a command encoder finished twice reports it and the second command buffer is empty', async () => {
  const { d, log, group, desc } = await scene(),
    errors = [];
  d.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error.message)));
  const encoder = d.createCommandEncoder(),
    pass = encoder.beginRenderPass(desc);
  pass.draw(3);
  pass.end();
  const first = encoder.finish(),
    second = encoder.finish();
  d.queue.submit([first]);
  d.queue.submit([second]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /already called/);
  assert.deepEqual(
    log.map(([name]) => name),
    ['beginPass', 'draw', 'endPass'],
    'only the first buffer drew',
  );
  // The pool holds the tape once, not twice: two encoders never share one.
  const a = d.createCommandEncoder(),
    b = d.createCommandEncoder();
  assert.notEqual(a.tape, b.tape);
});

test('an attachment list with a hole replays with its count', async () => {
  const { d, log, color } = await scene(),
    encoder = d.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [
        null,
        { view: color.createView(), clearValue: [1, 1, 1, 1], loadOp: 'clear', storeOp: 'discard' },
      ],
    });
  pass.end();
  d.queue.submit([encoder.finish()]);
  assert.deepEqual(log[0], ['beginPass', 2, [null, [0, [1, 1, 1, 1], 'clear', 'discard']], undefined]);
});

// KB-COMPAT-FRAMEALLOC1 part 6: a compute pass is on the tape too; each dispatch sees the pipeline, the bind groups
// (with their dynamic offsets) and the counts that were set when it was recorded, and a pass starts with none.
test('compute passes replay with the bind groups, offsets and counts current at each dispatch', async () => {
  const d = await device(),
    errors = [],
    calls = [];
  d.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error.message)));
  d.replayer.dispatch = (pipeline, groups, count) =>
    calls.push([pipeline.label, groups.map((g) => g && [g.group.label, [...g.offsets]]), [...count]]);
  const layout = d.createBindGroupLayout({ entries: [] }),
    one = d.createBindGroup({ layout, entries: [], label: 'one' }),
    two = d.createBindGroup({ layout, entries: [], label: 'two' }),
    p = { label: 'p' },
    q = { label: 'q' },
    buffer = d.createBuffer({ size: 16, usage: 0x100 }),
    encoder = d.createCommandEncoder();
  d.queue.writeBuffer(buffer, 0, Uint32Array.of(7, 8, 9, 0));
  let pass = encoder.beginComputePass();
  pass.setPipeline(p);
  pass.setBindGroup(0, one);
  pass.dispatchWorkgroups(2, 3, 4);
  pass.setBindGroup(1, two, [16, 32]);
  pass.setBindGroup(0, one, Uint32Array.of(1, 64, 128), 1, 1);
  pass.dispatchWorkgroups(5);
  pass.setPipeline(q);
  pass.dispatchWorkgroupsIndirect(buffer, 0);
  pass.end();
  // The next pass of the same command buffer starts with no pipeline and no bind group.
  pass = encoder.beginComputePass();
  pass.dispatchWorkgroups(1);
  pass.setPipeline(p);
  pass.setBindGroup(2, two);
  pass.dispatchWorkgroups(1, 1, 1);
  pass.end();
  d.queue.submit([encoder.finish()]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [
    ['p', [['one', []]], [2, 3, 4]],
    [
      'p',
      [
        ['one', [64]],
        ['two', [16, 32]],
      ],
      [5, 1, 1],
    ],
    [
      'q',
      [
        ['one', [64]],
        ['two', [16, 32]],
      ],
      [7, 8, 9],
    ],
    ['p', [null, null, ['two', []]], [1, 1, 1]],
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /without a compute pipeline/);
});

// KB-COMPAT-FRAMEALLOC1 part 10: the label of an encoder, pass encoder, command buffer and texture view is the
// prototype's '' unless one is given (an own field on every unlabelled object was 4 bytes of each a frame makes), and
// a view made without a descriptor shares its texture's default range. Each still reads and sets its label as its own.
test('labels and default view ranges behave as own properties', async () => {
  const d = await device(),
    texture = d.createTexture({ size: [4, 4, 2], format: 'rgba8unorm', usage: 0x04 | 0x10 }),
    plain = d.createCommandEncoder(),
    named = d.createCommandEncoder({ label: 'frame' }),
    a = texture.createView(),
    b = texture.createView({ label: 'b' }),
    layer = texture.createView({ dimension: '2d', baseArrayLayer: 1, arrayLayerCount: 1 }),
    compute = named.beginComputePass({ label: 'reduce' });
  assert.equal(plain.label, '');
  assert.equal(named.label, 'frame');
  assert.equal(compute.label, 'reduce');
  compute.end();
  plain.label = 'later';
  assert.equal(plain.label, 'later');
  assert.equal(d.createCommandEncoder().label, '', 'setting one label leaves the next object unlabelled');
  assert.equal(named.finish().label, 'frame');
  assert.equal(plain.finish({ label: 'buffer' }).label, 'buffer');
  assert.deepEqual([a.label, b.label], ['', 'b']);
  assert.notEqual(a, b);
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, a.id);
  for (const v of [a, b]) {
    assert.equal(v.texture, texture);
    assert.deepEqual(
      [v.format, v.dimension, v.baseMipLevel, v.mipLevelCount, v.baseArrayLayer, v.arrayLayerCount, v.aspect],
      ['rgba8unorm', '2d-array', 0, 1, 0, 2, 'all'],
    );
  }
  assert.deepEqual([layer.dimension, layer.baseArrayLayer, layer.arrayLayerCount], ['2d', 1, 1]);
  assert.throws(() => texture.createView({ baseArrayLayer: 2, arrayLayerCount: 1 }), RangeError);
});
