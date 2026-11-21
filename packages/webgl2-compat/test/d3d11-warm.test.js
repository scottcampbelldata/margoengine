// KB-VPT-LOBES-COMPAT: ANGLE's Direct3D 11 back end compiles a program's pixel shader at link for its first colour output
// only and compiles it again, synchronously on the browser's GPU thread, at the first draw into more colour targets. An
// async pipeline resolved at link, so the first frame of the staged voxel path tracer (26 programs with several targets)
// waited 206 s for those compiles inside its render signal, which fired late with the page's thread held. An async
// pipeline there now draws once into 1 x 1 throwaway targets of its own layout, and resolves when the GPU has passed
// that draw. KB6016e (2026-11-21): that draw must rasterize (with rasterizer discard on the compile still came at the
// first real draw), and a program with no colour target compiles at its first draw too, so it is warmed as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

const D3D11 = 'ANGLE (NVIDIA, NVIDIA RTX A6000 (0x00002230) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const VULKAN = 'ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA RTX A6000 (0x00002230)), NVIDIA)';
const GL = {
  RASTERIZER_DISCARD: 0x8c89,
  COLOR_ATTACHMENT0: 0x8ce0,
  NONE: 0,
  TEXTURE_2D: 0x0de1,
  RGBA8: 0x8058,
  RGBA8UI: 0x8d7c,
  RGBA8I: 0x8d8e,
  DRAW_FRAMEBUFFER: 0x8ca9,
  UNIFORM_BUFFER: 0x8a11,
  STATIC_DRAW: 0x88e4,
  TIMEOUT_EXPIRED: 0x911b,
  ALREADY_SIGNALED: 0x911a,
  SYNC_FLUSH_COMMANDS_BIT: 1,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
  TRIANGLES: 4,
  RENDERBUFFER: 0x8d41,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  SCISSOR_TEST: 0x0c11,
};

/** A device on a stand-in context that reports `renderer` and logs the calls a warm draw makes. */
async function device(renderer) {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, 4096]));
  const log = [],
    on = new Set(),
    state = { signalled: false };
  const context = {
    ...enums,
    ...GL,
    FRAGMENT_SHADER: 0x8b30,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    checkFramebufferStatus: () => 0x8cd5,
    getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null),
    getParameter: (p) => (p === 0x1f01 ? renderer : (values.get(p) ?? '')),
    getShaderPrecisionFormat: (_shader, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
    enable: (cap) => on.add(cap),
    disable: (cap) => on.delete(cap),
    // Whether the draw rasterizes: rasterizer discard and the scissor test off.
    drawArrays: (...args) => log.push(['draw', !on.has(GL.RASTERIZER_DISCARD) && !on.has(GL.SCISSOR_TEST), ...args]),
    drawBuffers: (buffers) => log.push(['drawBuffers', ...buffers]),
    texStorage2D: (_target, _levels, format) => log.push(['texStorage2D', format]),
    framebufferTexture2D: (_target, point) => log.push(['attach', point]),
    renderbufferStorage: (_target, format) => log.push(['renderbufferStorage', format]),
    framebufferRenderbuffer: (_target, point) => log.push(['attach', point]),
    fenceSync: () => ({ fence: true }),
    clientWaitSync: () => (state.signalled ? GL.ALREADY_SIGNALED : GL.TIMEOUT_EXPIRED),
  };
  const gl = new Proxy(context, { get: (target, key) => (key in target ? target[key] : () => ({})) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const d = await adapter.requestDevice();
  log.length = 0;
  return { device: d, log, state };
}

const code = `
struct O {@location(0) a:vec4u, @location(2) b:vec4f}
@vertex fn v()->@builtin(position) vec4f {return vec4f(0,0,0,1);}
@fragment fn f()->O {var o:O; o.a=vec4u(1); o.b=vec4f(1); return o;}
@fragment fn one()->@location(0) vec4f {return vec4f(1);}
@fragment fn none() {}
@fragment fn depth(@builtin(position) q:vec4f) {if (q.x > 1e9) {discard;}}`;

const pipeline = (d, entryPoint, targets, depthStencil) => {
  const module = d.createShaderModule({ code });
  return d.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'v' },
    fragment: { module, entryPoint, targets },
    depthStencil,
  });
};
const turns = (n) => new Promise((resolve) => setTimeout(resolve, n));

test('on ANGLE Direct3D 11 an async pipeline with two colour targets compiles its draw before it resolves', async () => {
  const { device: d, log, state } = await device(D3D11);
  try {
    let resolved = false;
    const made = pipeline(d, 'f', [{ format: 'rgba32uint' }, null, { format: 'rgba16float' }]).then((p) => {
      resolved = true;
      return p;
    });
    await turns(30);
    assert.equal(resolved, false, 'the pipeline waits for the GPU to pass its warm draw');
    assert.deepEqual(log, [
      ['texStorage2D', GL.RGBA8UI],
      ['attach', GL.COLOR_ATTACHMENT0],
      ['texStorage2D', GL.RGBA8],
      ['attach', GL.COLOR_ATTACHMENT0 + 2],
      ['drawBuffers', GL.COLOR_ATTACHMENT0, GL.NONE, GL.COLOR_ATTACHMENT0 + 2],
      ['draw', true, GL.TRIANGLES, 0, 3],
    ]);
    state.signalled = true;
    assert.ok(await made);
    assert.equal(log.filter(([name]) => name === 'draw').length, 1, 'one warm draw');
    // The same program made again is warm already: no second draw, no wait.
    await pipeline(d, 'f', [{ format: 'rgba32uint' }, null, { format: 'rgba16float' }]);
    assert.equal(log.filter(([name]) => name === 'draw').length, 1, 'a program is warmed once');
  } finally {
    d.destroy();
  }
});

// KB6016e (2026-11-21): the same back end pays the compile at the first draw for a single colour output too (link
// complete after 58 to 74 ms, the first draw 194 to 346 ms more), so a 1-output program is warmed as well.
test('on ANGLE Direct3D 11 an async pipeline with one colour target compiles its draw before it resolves', async () => {
  const { device: d, log, state } = await device(D3D11);
  try {
    let resolved = false;
    const made = pipeline(d, 'one', [{ format: 'rgba8unorm' }]).then((p) => {
      resolved = true;
      return p;
    });
    await turns(30);
    assert.equal(resolved, false, 'the pipeline waits for the GPU to pass its warm draw');
    assert.deepEqual(log, [
      ['texStorage2D', GL.RGBA8],
      ['attach', GL.COLOR_ATTACHMENT0],
      ['drawBuffers', GL.COLOR_ATTACHMENT0],
      ['draw', true, GL.TRIANGLES, 0, 3],
    ]);
    state.signalled = true;
    assert.ok(await made);
  } finally {
    d.destroy();
  }
});

// KB6016e (2026-11-21): a depth-only program (a fragment stage with no colour output) pays the compile at its first
// draw there as well (link 45 to 53 ms, first draw 128 to 174 ms more), so it draws once into a 1 x 1 depth-stencil
// buffer before it resolves.
test('on ANGLE Direct3D 11 a depth-only async pipeline compiles its draw before it resolves', async () => {
  const { device: d, log, state } = await device(D3D11);
  try {
    let resolved = false;
    const made = pipeline(d, 'depth', [], {
      format: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'less',
    }).then((p) => {
      resolved = true;
      return p;
    });
    await turns(30);
    assert.equal(resolved, false, 'the pipeline waits for the GPU to pass its warm draw');
    assert.deepEqual(log, [
      ['renderbufferStorage', GL.DEPTH24_STENCIL8],
      ['attach', GL.DEPTH_STENCIL_ATTACHMENT],
      ['drawBuffers', GL.NONE],
      ['draw', true, GL.TRIANGLES, 0, 3],
    ]);
    state.signalled = true;
    assert.ok(await made);
  } finally {
    d.destroy();
  }
});

test('another backend resolves at link with no warm draw', async () => {
  for (const [renderer, entryPoint, targets] of [
    [VULKAN, 'one', [{ format: 'rgba8unorm' }]],
    [VULKAN, 'f', [{ format: 'rgba32uint' }, null, { format: 'rgba16float' }]],
    [VULKAN, 'none', [null]],
  ]) {
    const { device: d, log } = await device(renderer);
    try {
      assert.ok(await pipeline(d, entryPoint, targets));
      assert.deepEqual(
        log.filter(([name]) => name === 'draw'),
        [],
        `${renderer} ${entryPoint}`,
      );
    } finally {
      d.destroy();
    }
  }
});
