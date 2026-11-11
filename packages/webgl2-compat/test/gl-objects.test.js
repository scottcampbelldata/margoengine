// Regression (lane FA, 2026-11-10, ANGLE on Vulkan, NVIDIA RTX A6000): the layer left the GL programs and vertex
// arrays of every render pipeline, and the shared storage textures of bind groups, for the browser to delete when it
// collected their JS wrappers. A collection lands at a moment of the browser's own, possibly in the middle of a replay,
// and a voxel path tracer rebuilt three times made 95 programs, deleted none, and rendered wrong in about 17 % of
// renders on ANGLE Vulkan (fragment output 7 of the live programs corrupted for about half a second). Keeping every
// WebGL object reachable gave 0 wrong in 26. Now the device holds every object it makes and deletes each one itself:
// on destroy() of its resource, at the end of a submission after the resource was collected, or when the device is
// destroyed; a pipeline made again with the same GLSL reuses its program.
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { COMPAT_LIMITS } from '../dist/index.js';
import { CompatBindGroup, createCompatGPU } from '../dist/device.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const GPUBufferUsageLike = { INDEX: 0x10, VERTEX: 0x20, COPY_DST: 0x08 };

/** A recording stand-in context: every create* makes a fresh object, every delete* is logged. */
function recordingContext() {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, 4096]));
  const deleted = [];
  const context = {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    VERTEX_SHADER: 0x8b31,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    LINK_STATUS: 0x8b82,
    INVALID_INDEX: 0xffffffff,
    TEXTURE_2D: 0x0de1,
    RGBA32UI: 0x8d70,
    deleted,
    getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null),
    getParameter: (p) => (p === 0x1f01 ? 'Stand-in renderer' : (values.get(p) ?? '')),
    getShaderPrecisionFormat: (_shader, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
    getProgramParameter: () => true,
    getUniformBlockIndex: () => 0xffffffff,
    getUniformLocation: () => null,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    isContextLost: () => false,
    getInternalformatParameter: () => Int32Array.of(4),
    fenceSync: () => ({ kind: 'Sync' }),
    deleteSync: (o) => deleted.push(o),
  };
  for (const kind of ['Buffer', 'Texture', 'Framebuffer', 'Renderbuffer', 'Sampler', 'Program', 'Shader', 'VertexArray', 'Query']) {
    context[`create${kind}`] = () => ({ kind });
    context[`delete${kind}`] = (o) => deleted.push(o);
  }
  // Every other enum gets a number of its own; every other call (state, uploads, draws) returns an empty object.
  const other = new Map();
  return new Proxy(context, {
    get: (target, key) =>
      key in target
        ? target[key]
        : typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)
          ? (other.get(key) ?? other.set(key, 0x9000 + other.size).get(key))
          : () => ({}),
  });
}

async function recordingDevice() {
  const gl = recordingContext();
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  return { gl, device: await adapter.requestDevice() };
}

const WGSL = (n) => `@vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, ${n}.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`;
const pipeline = (device, n = 0, format = 'float32x2') =>
  device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: device.createShaderModule({ code: WGSL(n) }),
      entryPoint: 'vs',
      buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format }] }],
    },
    fragment: { module: device.createShaderModule({ code: WGSL(n) }), entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
/** Collects in jobs of their own (WeakRef.deref() keeps its target alive until the end of the job that called it). */
const settle = async (until) => {
  for (let n = 0; n < 50; n++) {
    await tick();
    gc();
    await tick();
    if (until()) return;
  }
};
const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

test('every WebGL object the device makes is deleted by the device; destroy() leaves created equal to deleted', async () => {
  const { gl, device } = await recordingDevice();
  device.createBuffer({ size: 256, usage: GPUBufferUsageLike.VERTEX | GPUBufferUsageLike.COPY_DST });
  device.createBuffer({ size: 64, usage: GPUBufferUsageLike.INDEX });
  device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x14 });
  device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10, sampleCount: 4 });
  device.createSampler({});
  const kept = [pipeline(device, 1), pipeline(device, 2)];
  const { created, deleted } = device.glObjects;
  assert.ok(sum(created) > 0, 'the device counted what it made');
  assert.equal(created.Program, 2);
  assert.equal(created.VertexArray, 2);
  device.destroy();
  assert.deepEqual({ ...device.glObjects.deleted }, { ...device.glObjects.created }, 'created == deleted after destroy');
  assert.equal(gl.deleted.length, sum(deleted), 'each delete reached the context once');
  assert.ok(kept.length);
});

test('a pipeline made again with the same GLSL and vertex layout reuses its program and VAO', async () => {
  const { device } = await recordingDevice();
  const a = pipeline(device, 3),
    b = pipeline(device, 3),
    other = pipeline(device, 3, 'float32x3');
  assert.equal(a.program, b.program);
  assert.equal(a.vao, b.vao);
  assert.equal(a.cache, b.cache, 'per-program uniform and VAO caches are shared with the program');
  assert.notEqual(other.program, a.program, 'another vertex layout gets its own program and VAO');
  assert.equal(device.glObjects.created.Program, 2);
  assert.equal(device.programs.count, 2);
  device.destroy();
});

test('programs of collected pipelines are deleted at the end of a submission, beyond the idle bound only', async () => {
  const { gl, device } = await recordingDevice();
  const live = pipeline(device, 999);
  (() => {
    for (let n = 0; n < 70; n++) pipeline(device, n);
  })();
  assert.equal(device.glObjects.created.Program, 71);
  await settle(() => device.objects.dirty);
  assert.equal(device.glObjects.deleted.Program, 0, 'nothing is deleted at collection time');
  device.queue.submit([]);
  assert.equal(device.glObjects.deleted.Program, 70 - 64, 'the oldest idle programs beyond 64 go at the submission');
  assert.ok(!gl.deleted.includes(live.program), 'a live pipeline keeps its program');
  // Made again: the idle program is reused, not compiled again.
  pipeline(device, 69);
  assert.equal(device.glObjects.created.Program, 71);
  device.destroy();
  assert.deepEqual({ ...device.glObjects.deleted }, { ...device.glObjects.created });
});

test('a delete asked for during a replay waits for the end of the replay', async () => {
  const { gl, device } = await recordingDevice();
  const texture = gl.createTexture();
  device.objects.replaying++;
  gl.deleteTexture(texture);
  assert.ok(!gl.deleted.includes(texture), 'not deleted inside the replay');
  device.objects.replaying--;
  device.collect();
  assert.ok(gl.deleted.includes(texture));
  device.destroy();
});

/** A bind group with one storage binding, made as the device makes it, so storageTexture() makes the shared texture. */
function sharedGroup(device) {
  const group = Object.create(CompatBindGroup.prototype);
  Object.assign(group, {
    device,
    layout: { entries: [{ binding: 0, buffer: { type: 'storage', hasDynamicOffset: false } }] },
    entries: new Map([[0, { kind: 'buffer', buffer: { size: 64, version: 0, destroyed: true }, offset: 0, size: 64 }]]),
    shared: null,
  });
  assert.ok(group.storageTexture(), 'the group made its shared texture');
  return group;
}

// Regression (lane L, 2026-11-10, M6 Mac mini): the shared texture's cleanup once held the context strongly, and a real
// context reaches its device (the canvas's context-lost listener), so no device that made such a group was collected.
test('a device whose bind group made a shared storage texture can be collected', async () => {
  let ref;
  await (async () => {
    const { gl, device } = await recordingDevice();
    gl.device = device; // a real context reaches the device through its canvas's event listeners
    sharedGroup(device);
    ref = new WeakRef(device);
  })();
  await settle(() => ref.deref() === undefined);
  assert.equal(ref.deref(), undefined, 'the cleanup kept the device alive');
});

test('a dropped bind group of a live device deletes its shared texture at the next submission', async () => {
  const { gl, device } = await recordingDevice();
  const texture = (() => sharedGroup(device).shared.texture)();
  await settle(() => device.objects.dirty);
  assert.ok(!gl.deleted.includes(texture), 'never at collection time');
  device.queue.submit([]);
  assert.ok(gl.deleted.includes(texture));
  device.destroy();
});
