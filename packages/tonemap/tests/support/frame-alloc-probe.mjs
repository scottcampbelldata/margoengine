// Runs in its own process with --expose-gc (tests/frame-alloc.test.js at the repository root gives the reasons for
// the other V8 flags): heap bytes per call of the grading pass a Tonemap with its default options records each frame
// (in a PostStack it is the whole of the effect's frame), on the post-processing stand-in device, which hands back the
// same pass and keeps no record per call, so every byte left is the effect's own. Prints JSON
// { bytes: [heap bytes per call, five windows] }. MARGO_PROBE_ROOT points it at another checkout.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { heapWindows } from '../../../../tests/support/heap-windows.mjs';
import { gpuHarness } from '../../../../tests/support/postfx-gpu.js';

const root = process.env.MARGO_PROBE_ROOT ?? resolve(import.meta.dirname, '../../../..'),
  { Tonemap } = await import(pathToFileURL(resolve(root, 'packages/tonemap/dist/index.js')).href),
  h = gpuHarness(),
  effect = Tonemap.attach(h.engine),
  paint = effect.paint;
// One frame through the engine records the arguments its grading pass takes; the probe then repeats that call.
let args;
effect.paint = (...a) => {
  args = a;
  return paint.apply(effect, a);
};
h.frame();
effect.paint = paint;
const run = (calls) => {
  for (let i = 0; i < calls; i++) effect.paint(...args);
};
run(20_000);
console.log(JSON.stringify({ bytes: heapWindows(run) }));
