import test from 'node:test';
import assert from 'node:assert/strict';
import { VolumetricFog } from '../dist/volumetric.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function rig() {
  const h = optionalGPU(),
    c = h.context,
    device = h.engine.gpu;
  h.engine.plugins = new Map();
  h.engine.lighting = { direction: [0, 1, 0, 1], radiance: [1, 1, 1, 0.1] };
  device.limits.maxTextureDimension3D = 512;
  const depth = device.createTexture({
    size: [c.width, c.height],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const fog = new VolumetricFog({ grid: [8, 8, 8], depth: () => depth });
  h.engine.use(fog);
  for (const method of ['beginRenderPass', 'beginComputePass']) {
    const begin = c.encoder[method];
    c.encoder[method] = (...args) => ({ ...begin(...args), setViewport() {}, setScissorRect() {} });
  }
  return {
    ...h,
    fog,
    depth,
    frame(id, index = 0) {
      c.view = id ? { id, viewport: [0, 0, c.width, c.height], index, count: 2 } : undefined;
      h.engine.frameGraph.execute(c);
      return fog.texture;
    },
  };
}

test('volumetric fog gives each view its own volume and invalidates every resized or restored history', () => {
  const h = rig();
  try {
    const a = h.frame('a'),
      b = h.frame('b');
    assert.notEqual(a, b, 'views must not reproject each other’s froxels');
    assert.equal(h.frame('a'), a);
    h.fog.options.grid = [4, 4, 4];
    assert.equal(h.frame('b').width, 4);
    assert.equal(h.frame('a').width, 4);
    assert.ok(a.destroyed && b.destroyed);
    h.fog.onDeviceRestored(h.engine);
    assert.equal(h.fog.texture, undefined);
    h.frame('a');
    const kept = h.frame('b');
    h.fog.onPreUpdate(1 / 60);
    h.frame('a');
    h.fog.onPreUpdate(1 / 60);
    assert.ok(kept.destroyed, 'a view not drawn for a frame releases its volume');
  } finally {
    h.fog.dispose();
    h.depth.destroy();
    assert.ok(h.resources.every((r) => r.destroyed));
  }
});

test('volumetric fog retries partial volume and group allocations without leaking or using an incomplete group set', () => {
  for (const [method, at] of [
    ['createTexture', 2],
    ['createBindGroup', 2],
    ['createBindGroup', 5],
  ]) {
    const h = rig(),
      device = h.engine.gpu,
      original = device[method];
    let calls = 0;
    device[method] = (...args) => {
      if (++calls === at) throw new Error('injected fog allocation failure');
      return original(...args);
    };
    try {
      assert.throws(() => h.frame(), /injected fog allocation failure/);
      device[method] = original;
      assert.ok(h.frame());
      assert.ok(h.frame());
    } finally {
      device[method] = original;
      h.fog.dispose();
      h.depth.destroy();
      assert.ok(
        h.resources.every((r) => r.destroyed),
        `${method} ${at} leaked a resource`,
      );
    }
  }
});

test('volumetric wind advances once per engine frame and has the same phase in later views', () => {
  const h = rig(),
    writes = [],
    write = h.engine.gpu.queue.writeBuffer;
  h.fog.options.wind = [2, 0, -1];
  h.engine.gpu.queue.writeBuffer = (buffer, offset, values) => {
    if (values.length === 76) writes.push([...values.subarray(64, 67)]);
    write(buffer, offset, values);
  };
  try {
    h.context.delta = 0.1;
    h.frame('a');
    h.context.delta = 0;
    h.frame('b');
    assert.deepEqual(writes, [
      [Math.fround(0.2), 0, Math.fround(-0.1)],
      [Math.fround(0.2), 0, Math.fround(-0.1)],
    ]);
  } finally {
    h.fog.dispose();
    h.depth.destroy();
  }
});

test('volumetric fog composites over loaded scene colour for ordinary and first and later views', () => {
  const h = rig(),
    begin = h.context.encoder.beginRenderPass,
    loads = [];
  h.context.encoder.beginRenderPass = (descriptor) => {
    loads.push(descriptor.colorAttachments[0].loadOp);
    return begin(descriptor);
  };
  try {
    h.fog.options.density = 0;
    h.frame();
    h.frame('a');
    h.frame('b', 1);
    assert.deepEqual(loads, ['load', 'load', 'load']);
  } finally {
    h.fog.dispose();
    h.depth.destroy();
  }
});
