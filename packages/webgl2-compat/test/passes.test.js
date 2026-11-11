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

// AMD GPU hunt row 34: a cached framebuffer is attached again on its first use in each frame (the ANGLE Metal upload
// workaround), and each attach also called checkFramebufferStatus, which waits for the GPU process to run every command
// before it: once per render target per frame, 14.9 s of a 15.7 s profile of the biomes flythrough on a Radeon 680M.
test('a cached framebuffer is attached again each frame but checked for completeness once, when made', async () => {
  const d = await device(),
    r = d.replayer,
    counts = { check: 0, attach: 0 },
    check = d.gl.checkFramebufferStatus;
  d.gl.checkFramebufferStatus = (target) => (counts.check++, check(target));
  // One colour subresource as the replayer makes them for a pass's attachment.
  const sub = { key: 't1.0', owner: { framebuffers: new Set() }, info: { kind: 'color' }, level: 0 },
    target = { ...sub, attach: () => counts.attach++ };
  const fbo = r.single(target);
  assert.deepEqual(counts, { check: 1, attach: 1 }, 'made, attached and checked');
  assert.equal(r.single(target), fbo);
  assert.deepEqual(counts, { check: 1, attach: 1 }, 'the same frame reuses it as it is');
  for (let frame = 0; frame < 3; frame++) {
    d.frame++;
    assert.equal(r.single(target), fbo);
  }
  assert.deepEqual(counts, { check: 1, attach: 4 }, 'attached again in each new frame, never checked again');
  // An incomplete framebuffer is still reported, once, when it is made.
  const errors = [];
  d.gl.checkFramebufferStatus = () => (counts.check++, 0x8cd6);
  d.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error.message)));
  r.single({ ...sub, key: 't2.0', attach: () => counts.attach++ });
  d.frame++;
  r.single({ ...sub, key: 't2.0', attach: () => counts.attach++ });
  // The layer dispatches uncapturederror in a task of its own, as WebGPU does.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(counts.check, 2);
  assert.equal(errors.length, 1, 'reported once');
  assert.match(errors[0], /complete WebGL2 framebuffer \(status 0x8cd6\)/);
});
