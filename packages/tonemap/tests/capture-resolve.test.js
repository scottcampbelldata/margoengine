// Batch 164 rows 9.7 and 13.15: Tonemap's final capture resolve copied the 4x scene depth into its private 1x depth
// texture every frame, although nothing reads that texture after the final resolve: a 4x capture's depth readers bind
// its multisampled depth, a mid-frame reader resolves first, and the capture stops being the scene target right after.
// The steady frame now skips that copy: one depth-only pass and its draw fewer at 4x, every other command identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { harness } from '../../post/test/support.js';

const calls = (log, name) => log.filter((e) => e[0] === name);

for (const samples of [1, 4])
  test(`Tonemap ${samples}x final resolve skips the unread 1x depth copy, other commands identical`, () => {
    const h = harness({ samples }),
      tonemap = new Tonemap();
    const begin = h.view.begin;
    h.view.begin = () => begin(0); // Same camera and uniforms on both paths.
    const first = h.gpu.record(() => {
      h.engine.use(tonemap);
      h.frame();
    });
    const frame = () => h.gpu.record(() => h.frame()),
      optimized = frame(),
      target = tonemap.captureTarget,
      resolve = target.resolve;
    // Historical path: the final resolve also refreshes the private 1x depth texture.
    target.resolve = (encoder, final) => resolve.call(target, encoder, final);
    frame(); // Builds the historical copy's pipeline outside the compared frame.
    const baseline = frame();
    target.resolve = resolve;
    const removed = samples === 4 ? 1 : 0;
    assert.equal(calls(baseline, 'beginRenderPass').length - calls(optimized, 'beginRenderPass').length, removed);
    assert.equal(calls(baseline, 'pass.draw').length - calls(optimized, 'pass.draw').length, removed);
    // Drop the historical depth-only pass (begin, pipeline, group, draw, end) and compare the rest call for call.
    const depthView = target.resolvedDepthView,
      start = samples === 1 ? -1 : baseline.findIndex((e) => e[0] === 'beginRenderPass' && e[1].depthStencilAttachment?.view === h.gpu.snap(depthView));
    assert.equal(start >= 0, samples === 4, 'the historical frame copies depth into the private 1x texture');
    const rest = start < 0 ? baseline : [...baseline.slice(0, start), ...baseline.slice(start + 5)];
    if (start >= 0) assert.equal(baseline[start + 4][0], 'pass.end');
    assert.deepEqual(optimized, rest, 'every remaining command, binding, draw and upload is identical');
    // Nothing reads the texture the removed pass wrote: no bind group made since setup and no steady-frame call.
    const texture = h.gpu.snap(target.resolvedDepth),
      view = h.gpu.snap(depthView);
    for (const entry of [...first.filter((e) => e[0] === 'group'), ...rest]) {
      const text = JSON.stringify(entry);
      assert.ok(!text.includes(`"${view}"`) && !text.includes(`"${texture}"`), `${entry[0]} reads the 1x depth`);
    }
    h.engine.removePlugin(tonemap.name);
  });
