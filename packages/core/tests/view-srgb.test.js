// KB-VIEW-SRGB1: a view drawn into an `-srgb` texture stored core's colours encoded twice (background #808080 stored
// 188). Core's shader, its clear colour and every package's pipeline write display colour, and an `-srgb` attachment
// encodes what is written to it once more (WebGPU, "Render pass color attachments": values are converted to the
// attachment view's format). Core now draws such a target through a view in its non-srgb twin format (WebGPU
// "createView()": a format of the texture's `viewFormats`), so the pass, its pipelines, the 4x colour it resolves from
// and the clear colour are those of the twin and the bytes stored are the sRGB encoding. Any other target, and the
// canvas, are drawn as before. The real-GPU check is view-srgb.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuDrawHarness } from '../../../tests/support/core-draw-gpu.js';

const grey = 128 / 255;
// One whole view into a caller's texture of `format`; returns what core asked of it and drew with.
const drawInto = (h, format) => {
  const asked = [],
    seen = {},
    first = h.passes.length,
    color = {
      format,
      sampleCount: 1,
      width: 64,
      height: 32,
      createView: (...descriptor) => {
        asked.push(descriptor);
        return { caller: format, view: descriptor[0]?.format };
      },
    };
  h.frame(
    (draw, c) => {
      c.view = { ...c.view, clear: { color: '#808080' } };
      seen.format = c.format;
      seen.target = c.view.target.color;
      draw();
    },
    { rect: [0, 0, 64, 32], index: 0, count: 1, id: 't', target: { color } },
  );
  // The frame's passes: with 4x MSAA a later one may resolve the colour the first one cleared.
  const passes = h.passes.slice(first).map((pass) => pass.descriptor.colorAttachments[0]);
  return { asked, seen, color, passes };
};

test('an -srgb view target is drawn through a view in its non-srgb twin format; any other in its own', (t) => {
  for (const samples of [1, 4]) {
    const h = gpuDrawHarness(t, samples),
      pipelines = [],
      make = h.device.createRenderPipeline;
    h.device.createRenderPipeline = (descriptor) => {
      pipelines.push(descriptor.fragment.targets[0].format);
      return make(descriptor);
    };
    for (const [format, twin] of [
      ['rgba8unorm-srgb', 'rgba8unorm'],
      ['bgra8unorm-srgb', 'bgra8unorm'],
      ['rgba8unorm', 'rgba8unorm'],
      ['rgba16float', 'rgba16float'],
    ]) {
      const label = `${format}, ${samples} sample(s)`,
        made = h.device.textures.length,
        { asked, seen, color, passes } = drawInto(h, format);
      assert.deepEqual(asked, [[{ format: twin }]], `${label}: one view, in ${twin}`);
      assert.equal(seen.format, twin, `${label}: the pass context's format, which every pipeline is built for`);
      assert.equal(seen.target, color, `${label}: the view still names the caller's texture`);
      // Core's own pipeline for a format that is not the canvas's (bgra8unorm in this harness).
      if (twin !== 'bgra8unorm') assert.equal(pipelines.at(-1), twin, `${label}: core's pipeline`);
      // The clear colour is the bytes as given: display colour, as on the canvas (never decoded for the frame's own
      // target, so nothing encodes it twice).
      assert.deepEqual(passes[0].clearValue, [grey, grey, grey, 1], `${label}: the clear colour`);
      const resolved = samples > 1 ? passes.find((pass) => pass.resolveTarget).resolveTarget : passes[0].view;
      assert.deepEqual(resolved, { caller: format, view: twin }, `${label}: the caller's texture, through that view`);
      // With 4x MSAA core's own multisampled colour, which resolves into the view, has the view's format.
      if (samples > 1)
        assert.equal(h.device.textures.slice(made).find((texture) => texture.format !== 'depth32float').format, twin);
    }
    assert.ok(!pipelines.some((format) => format.endsWith('-srgb')), `no -srgb pipeline: ${pipelines}`);
  }
});

test('the canvas is drawn in its own format through its default view', (t) => {
  const h = gpuDrawHarness(t);
  let format;
  h.frame((draw, c) => {
    format = c.format;
    draw();
  });
  assert.equal(format, 'bgra8unorm');
  assert.deepEqual(h.passes.at(-1).descriptor.colorAttachments[0].view, { canvas: true });
});
