import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function rig(samples) {
  const h = optionalGPU(),
    c = h.context,
    device = h.engine.gpu;
  c.descriptor = { ...c.descriptor, multisample: { count: samples } };
  const create = device.createBindGroup,
    begin = c.encoder.beginRenderPass;
  let sampled, output;
  device.createBindGroup = (descriptor) => {
    for (const entry of descriptor.entries) {
      assert.ok(entry.resource, `water binding ${entry.binding} is missing`);
      assert.ok(!entry.resource.texture?.destroyed, `water binding ${entry.binding} uses a destroyed texture`);
    }
    return create(descriptor);
  };
  c.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    if (descriptor.colorAttachments?.length === 2) {
      output = (descriptor.colorAttachments[1].resolveTarget ?? descriptor.colorAttachments[1].view).texture;
    }
    return {
      ...pass,
      setViewport() {},
      setScissorRect() {},
      setBindGroup(index, group) {
        assert.ok(group, 'water draw needs a complete bind group');
        if (index === 0 && group.entries?.length === 8)
          sampled = group.entries.find((e) => e.binding === 2).resource.texture;
      },
    };
  };
  const water = new Water({ segments: 4 });
  h.engine.use(water);
  return {
    ...h,
    water,
    // A plain frame runs plugin updates; a view draws inside the current frame (updates run once per frame).
    frame(id) {
      c.view = id ? { id, viewport: [0, 0, c.width, c.height], index: 0, count: 1 } : undefined;
      if (id) {
        Object.assign(c, { color: h.originalColor, depth: h.originalDepth, format: 'bgra8unorm' });
        h.engine.frameGraph.execute(c);
      } else h.frame();
      assert.ok(sampled && output && sampled !== output, 'foam must read and write different textures');
      return { sampled, output };
    },
  };
}

test('water confines its surface draw to an offset view viewport and scissor', () => {
  const h = rig(1),
    begin = h.context.encoder.beginRenderPass,
    draws = [];
  h.context.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    if (descriptor.colorAttachments?.length !== 2) return pass;
    const record = {};
    draws.push(record);
    return {
      ...pass,
      setViewport: (...value) => {
        record.viewport = value;
      },
      setScissorRect: (...value) => {
        record.scissor = value;
      },
    };
  };
  try {
    h.context.view = { id: 'right', viewport: [64, 0, 64, 96], scissor: [70, 4, 50, 80], index: 1, count: 2 };
    h.engine.frameGraph.execute(h.context);
    assert.deepEqual(draws, [{ viewport: [64, 0, 64, 96, 0, 1], scissor: [70, 4, 50, 80] }]);
  } finally {
    h.water.dispose();
  }
});

for (const samples of [1, 4]) {
  test(`water rebuilds live foam after ${samples}x resize and device restoration`, async () => {
    const h = rig(samples);
    try {
      const first = h.frame();
      h.water.onDeviceRestored(h.engine);
      assert.ok(first.sampled.destroyed && first.output.destroyed);
      const restored = h.frame();
      assert.notEqual(restored.sampled, first.sampled);
      h.context.width = 64;
      const resized = h.frame();
      assert.equal(resized.sampled.width, 64);
      assert.ok(restored.sampled.destroyed && restored.output.destroyed);
      const counts = { ...h.counts };
      for (let i = 0; i < 5; i++) h.frame();
      for (const key of ['textures', 'groups', 'views']) assert.equal(h.counts[key], counts[key]);
    } finally {
      h.water.dispose();
      await null;
      assert.ok(h.resources.every((r) => r.destroyed));
    }
  });

  test(`water keeps independent ${samples}x foam history and parity for each view through restoration`, async () => {
    const h = rig(samples);
    try {
      const a = h.frame('a'),
        b = h.frame('b');
      assert.notEqual(a.sampled, b.sampled, 'each view owns its foam history');
      assert.equal(h.frame('a').sampled, a.output, 'a reads its previous output');
      assert.equal(h.frame('b').sampled, b.output, 'b reads its previous output');
      h.water.onDeviceRestored(h.engine);
      assert.ok([a.sampled, a.output, b.sampled, b.output].every((t) => t.destroyed));
      const restored = h.frame('b');
      assert.notEqual(restored.sampled, b.sampled);
      h.frame('a');
      h.water.onPreUpdate(1 / 60);
      h.frame('a');
      h.water.onPreUpdate(0);
      assert.equal(restored.sampled.destroyed, false, 'a pick (delta 0) keeps every view');
      h.water.onPreUpdate(1 / 60);
      assert.ok(restored.sampled.destroyed, 'a view not drawn for a frame releases its foam');
    } finally {
      h.water.dispose();
      await null;
      assert.ok(h.resources.every((r) => r.destroyed));
    }
  });
}
