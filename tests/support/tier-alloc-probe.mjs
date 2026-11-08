// Runs in its own process with --expose-gc --max-opt=2: V8 then stops at Maglev, the optimizing tier a function called
// once per frame sits in for its first thousands of frames in a browser (scripts/frame-alloc-browser.mjs measures it
// there). Maglev boxes every fractional number it passes to a call it does not inline (Number.isFinite included) and
// allocates a function's closure context on each call. Prints JSON { bytes: [heap bytes per call, five windows] }.
// Cases: invert (invertMatrixStable of a camera-like matrix), cascades (cascadeSplits + fitCascades of four cascades),
// copyDepth (the three depth copies a post-processed 4x frame makes through SceneTarget, on a stand-in device).
// MARGO_PROBE_ROOT points it at another checkout (to measure a commit before a fix).
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { heapWindows } from './heap-windows.mjs';

const root = process.env.MARGO_PROBE_ROOT ?? resolve(import.meta.dirname, '../..'),
  load = (path) => import(pathToFileURL(resolve(root, path)).href),
  name = process.argv[2];
let call;
if (name === 'invert') {
  const { invertMatrixStable } = await load('packages/math/dist/mat4.js');
  const m = new Float32Array([0.71, -0.41, 0.58, 0, 0, 0.82, 0.58, 0, -0.71, -0.41, 0.58, 0, 0.13, -0.27, -5.83, 1]),
    out = new Float32Array(16),
    workspace = new Float64Array(52);
  call = () => invertMatrixStable(m, out, workspace);
} else if (name === 'cascades') {
  const { cascadeSplits, fitCascades } = await load('packages/shadows/dist/index.js');
  // The driver passes near and far as they are, not read from camera: V8 13's Maglev does not inline cascadeSplits
  // (280 bytes of bytecode, two calls deep here) and boxes a number it loaded from an object field to pass it, two heap
  // numbers (32 B) per call that the probe's own loop would add. With --no-concurrent-recompilation the windows run
  // that loop's on-stack replacement code, which boxes them on every call; the loop's own Maglev code, which arrived
  // later without the flag, read them once per window. They are the caller's bytes either way, not the package's.
  const near = 0.1,
    far = 93.7,
    camera = { position: [3.3, 2.1, 5.7], target: [0.1, 0.4, -0.3], fov: 60, near, far },
    direction = [-0.37, -0.81, -0.45],
    splits = new Float32Array(4),
    matrices = new Float32Array(64),
    ranges = new Float32Array(4),
    result = { matrices, ranges };
  call = () => {
    cascadeSplits(near, far, 0.5, splits, 4);
    fitCascades(camera, 4 / 3, direction, 1024, splits, matrices, ranges, 100, result, 4);
  };
} else if (name === 'copyDepth') {
  const { SceneTarget } = await load('packages/shared/msaa.js');
  globalThis.GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  // The stand-in returns one object per kind, so every byte left is SceneTarget's own (a browser adds a 16 B wrapper
  // per pass, as for every pass).
  const view = {},
    texture = (format) => ({ width: 8, height: 8, format, createView: () => view }),
    pipeline = { getBindGroupLayout: () => ({}) },
    device = {
      features: new Set(['core-features-and-limits']),
      createTexture: ({ format }) => texture(format),
      createShaderModule: () => ({}),
      createRenderPipeline: () => pipeline,
      createBindGroup: () => ({}),
    },
    pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} },
    encoder = { beginRenderPass: () => pass },
    target = new SceneTarget(device, texture('rgba16float'), texture('depth24plus'), 4),
    original = {};
  call = () => {
    target.copyDepth(encoder, view, 1);
    target.copyDepth(encoder, view, 1);
    target.copyDepth(encoder, original, 4, 'depth24plus');
  };
} else throw new TypeError(`Unknown case ${name}`);

const run = (calls) => {
  for (let i = 0; i < calls; i++) call();
};
run(20_000);
console.log(JSON.stringify({ bytes: heapWindows(run) }));
