// Runs in its own process with --expose-gc (tests/frame-alloc.test.js at the repository root gives the reasons for the
// other V8 flags): heap bytes per call of the WebGL2 layer's nearest-depth route (src/compat.ts) recording its reduction
// into an encoder, on a stand-in device and encoder that keep nothing, so every byte left is the route's own.
// Prints JSON { bytes: [heap bytes per call, five windows] }.
import { heapWindows } from '../../../../tests/support/heap-windows.mjs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The route's chunk in dist (its file name carries a content hash).
const dist = new URL('../../dist/', import.meta.url),
  chunk = readdirSync(fileURLToPath(dist)).find((f) => /^compat-.*\.js$/.test(f));
const { NearestRoute } = await import(new URL(chunk, dist).href);

globalThis.GPUTextureUsage = { STORAGE_BINDING: 8, TEXTURE_BINDING: 4 };
const view = {},
  pass = {
    setPipeline() {},
    setBindGroup() {},
    dispatchWorkgroups() {},
    end() {},
  },
  encoder = { beginComputePass: () => pass },
  device = {
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createTexture: (d) => ({ width: d.size[0], height: d.size[1], destroy() {}, createView: () => view }),
  },
  route = new NearestRoute(device),
  nearest = {};
// A 2,048 x 2,048 map of 4 layers: two levels (128, then 8) and the word pass, three dispatches a frame.
const run = (n) => {
  for (let i = 0; i < n; i++) route.encode(encoder, view, 2048, 2048, 4, nearest);
};
run(20000);
process.stdout.write(JSON.stringify({ bytes: heapWindows(run, 1000, 5) }));
