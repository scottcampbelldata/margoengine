// device.passes: the render passes the layer replayed and the draws that drew something, work counts a package tests
// its own route with (the voxel path tracer's WebGL2 route, docs/limits.md). A draw of nothing is not counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

/** A device on a stand-in context (no drawing). */
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
        type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
    },
    gl = new Proxy(context, { get: (t, k) => (k in t ? t[k] : () => ({})) });
  return (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice();
}

test('device.passes counts replayed passes and the draws that draw something', async () => {
  const d = await device(),
    r = d.replayer;
  assert.deepEqual(d.passes, { run: 0, draws: 0 });
  r.beginPass({ colors: [] });
  r.endPass();
  assert.equal(d.passes.run, 1);
  // No pipeline is set on the stand-in, so a counted draw reaches the GL call no further.
  r.ready = () => null;
  r.draw(3, 1, 0, 0);
  r.draw(0, 1, 0, 0);
  r.draw(3, 0, 0, 0);
  r.drawIndexed(0, 1, 0, 0, 0);
  assert.equal(d.passes.draws, 1);
});
