import test from 'node:test';
import assert from 'node:assert/strict';
import { StencilBuffer } from '../src/stencil-buffer.ts';
import { SceneTarget } from '../../shared/msaa.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

function scene(samples = 4) {
  const h = gpuHarness();
  h.engine.gpu.limits = { maxTextureDimension2D: 8192 };
  h.context.descriptor = {
    multisample: { count: samples },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
  };
  const plugin = StencilBuffer.attach(h.engine);
  return { ...h, plugin };
}

for (const samples of [1, 4])
  test(`stencil target promotes ${samples}x scene depth and restores the caller's attachments`, () => {
    const h = scene(samples),
      c = h.context,
      original = { depth: c.depth, descriptor: c.descriptor, color: c.color, format: c.format };
    let promoted;
    h.engine.frameGraph.add({
      name: 'inspect:stencil',
      order: 1,
      execute(view) {
        promoted = view.depth;
        assert.equal(view.depth.texture.format, 'depth24plus-stencil8');
        assert.equal(view.depth.texture.sampleCount, samples);
        assert.equal(view.depth.texture.width, 128);
        assert.equal(view.depth.texture.height, 96);
        assert.equal(view.descriptor.depthStencil.format, 'depth24plus-stencil8');
        assert.equal(view.descriptor.depthStencil.depthCompare, 'greater-equal');
        assert.equal(view.descriptor.depthStencil.depthWriteEnabled, true);
        assert.notEqual(view.descriptor, original.descriptor);
        assert.equal(original.descriptor.depthStencil.format, 'depth32float');
        assert.equal(view.color, original.color);
        assert.equal(view.format, original.format);
      },
    });
    try {
      h.engine.frameGraph.execute(c);
      assert.deepEqual({ depth: c.depth, descriptor: c.descriptor, color: c.color, format: c.format }, original);
      assert.equal(promoted.texture.usage, GPUTextureUsage.RENDER_ATTACHMENT);
    } finally {
      h.plugin.dispose();
    }
    assert.equal(promoted.texture.destroyed, true);
    assert.equal(h.engine.hasPlugin(h.plugin.name), false);
  });

test('stencil targets reuse warm resources and replace depth when dimensions or sample counts change', () => {
  const h = scene(),
    c = h.context,
    observed = [];
  h.engine.frameGraph.add({
    name: 'inspect:reuse',
    order: 1,
    execute(view) {
      observed.push({ depth: view.depth, descriptor: view.descriptor });
    },
  });
  try {
    h.engine.frameGraph.execute(c);
    h.engine.frameGraph.execute(c);
    assert.equal(observed[1].depth, observed[0].depth);
    assert.equal(observed[1].descriptor, observed[0].descriptor);
    assert.equal(h.counts.textures, 1);
    assert.equal(h.counts.views, 1);
    c.width = 256;
    h.engine.frameGraph.execute(c);
    assert.equal(observed[0].depth.texture.destroyed, true);
    assert.equal(observed[2].depth.texture.width, 256);
    c.descriptor = { ...c.descriptor, multisample: { count: 1 } };
    h.engine.frameGraph.execute(c);
    assert.equal(observed[2].depth.texture.destroyed, true);
    assert.equal(observed[3].depth.texture.sampleCount, 1);
    assert.equal(h.counts.textures, 3);
  } finally {
    h.plugin.dispose();
  }
  assert.ok(h.resources.every((texture) => texture.destroyed));
});

test('existing stencil attachments retain their depth, descriptor and zero extra allocations', () => {
  const h = scene(),
    c = h.context;
  c.descriptor = { ...c.descriptor, depthStencil: { ...c.descriptor.depthStencil, format: 'depth32float-stencil8' } };
  const descriptor = c.descriptor,
    depth = c.depth;
  h.engine.frameGraph.add({
    name: 'inspect:native-stencil',
    order: 1,
    execute(view) {
      assert.equal(view.depth, depth);
      assert.equal(view.descriptor, descriptor);
    },
  });
  try {
    h.engine.frameGraph.execute(c);
    assert.equal(h.counts.textures, 0);
    assert.equal(h.counts.views, 0);
  } finally {
    h.plugin.dispose();
  }
});

test('post capture sees the promoted format and restores the outer stencil attachment before final restoration', () => {
  const h = gpuHarness(),
    c = h.context,
    original = { depth: c.depth, descriptor: c.descriptor };
  c.device.limits = { maxTextureDimension2D: 8192 };
  let capture, outer;
  h.engine.frameGraph.add({
    name: 'post:test:capture',
    order: -100,
    execute(view) {
      outer = view.depth;
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        color = view.device.createTexture({ size: [128, 96], format: view.format, usage }),
        depth = view.device.createTexture({ size: [128, 96], format: view.descriptor.depthStencil.format, usage });
      capture = new SceneTarget(view.device, color, depth, 4);
      capture.begin(view);
    },
  });
  const plugin = StencilBuffer.attach(h.engine);
  h.engine.frameGraph.add({
    name: 'post:test:draw',
    order: 1,
    execute(view) {
      assert.equal(view.depth.texture.format, 'depth24plus-stencil8');
      assert.equal(view.descriptor.depthStencil.format, 'depth24plus-stencil8');
      assert.notEqual(view.depth, outer);
    },
  });
  h.engine.frameGraph.add({
    name: 'post:test:restore',
    order: 30,
    execute(view) {
      capture.resolve(view.encoder, true);
      capture.restore(view);
      assert.equal(view.depth, outer);
      assert.equal(view.descriptor.depthStencil.format, 'depth24plus-stencil8');
    },
  });
  try {
    h.engine.frameGraph.execute(c);
    assert.equal(c.depth, original.depth);
    assert.equal(c.descriptor, original.descriptor);
    assert.equal(h.pipelines[0].depthStencil.format, 'depth24plus-stencil8');
  } finally {
    capture?.dispose();
    plugin.dispose();
    for (const resource of h.resources) resource.destroy();
  }
});

test('an interrupted frame recovers its original depth on reuse without overwriting a fresh renderer context', () => {
  const h = scene(),
    c = h.context,
    descriptor = c.descriptor,
    depth = c.depth;
  const removeFailure = h.engine.frameGraph.add({
    name: 'interrupt:frame',
    order: 1,
    execute() {
      throw new Error('interrupted frame');
    },
  });
  try {
    assert.throws(() => h.engine.frameGraph.execute(c), /interrupted frame/);
    removeFailure();
    h.engine.frameGraph.execute(c);
    assert.equal(c.depth, depth);
    assert.equal(c.descriptor, descriptor);
    const removeAgain = h.engine.frameGraph.add({
      name: 'interrupt:again',
      order: 1,
      execute() {
        throw new Error('again');
      },
    });
    assert.throws(() => h.engine.frameGraph.execute(c), /again/);
    removeAgain();
    const freshDepth = {};
    c.depth = freshDepth;
    c.descriptor = descriptor;
    h.engine.frameGraph.execute(c);
    assert.equal(c.depth, freshDepth);
    assert.equal(c.descriptor, descriptor);
  } finally {
    h.plugin.dispose();
  }
});

test('failed replacement leaves the previous target alive and cleans up a texture whose view failed', () => {
  const h = scene(),
    c = h.context;
  try {
    h.engine.frameGraph.execute(c);
    const previous = h.resources[0],
      create = c.device.createTexture.bind(c.device);
    c.width = 256;
    c.device.createTexture = (description) => {
      const texture = create(description);
      texture.createView = () => {
        throw new Error('view allocation failed');
      };
      return texture;
    };
    assert.throws(() => h.engine.frameGraph.execute(c), /view allocation failed/);
    assert.equal(previous.destroyed, false);
    assert.equal(h.resources[1].destroyed, true);
    c.device.createTexture = create;
    h.engine.frameGraph.execute(c);
    assert.equal(previous.destroyed, true);
    assert.equal(h.resources[2].destroyed, false);
  } finally {
    h.plugin.dispose();
  }
});

test('device restoration releases old textures and creates the next target on the replacement device', () => {
  const h = scene(),
    replacement = gpuHarness(),
    c = h.context;
  replacement.engine.gpu.limits = { maxTextureDimension2D: 8192 };
  try {
    h.engine.frameGraph.execute(c);
    const old = h.resources[0];
    h.engine.gpu = replacement.engine.gpu;
    c.device = replacement.engine.gpu;
    h.plugin.onDeviceRestored(h.engine);
    assert.equal(old.destroyed, true);
    h.engine.frameGraph.execute(c);
    assert.equal(replacement.counts.textures, 1);
    assert.equal(replacement.resources[0].format, 'depth24plus-stencil8');
  } finally {
    h.plugin.dispose();
  }
  assert.equal(replacement.resources[0].destroyed, true);
});

test('stencil attachment setup rejects unsupported engines and disposed instances', () => {
  const h = gpuHarness();
  h.engine.gpu = null;
  assert.throws(() => StencilBuffer.attach(h.engine), {
    name: 'MargoError',
    code: 'unsupported',
    message: /StencilBuffer.*WebGPU; use a WebGPU engine/,
  });
  assert.equal(h.engine.hasPlugin('materials:stencil-buffer'), false);
  const plugin = new StencilBuffer();
  plugin.dispose();
  assert.throws(() => plugin.setup(gpuHarness().engine), {
    name: 'MargoError',
    code: 'disposed',
    message: /StencilBuffer is disposed; create a new StencilBuffer/,
  });
  plugin.dispose();
});

test('stencil attachment ownership errors identify the required replacement without changing its owner', () => {
  const h = scene(),
    foreign = gpuHarness();
  try {
    assert.throws(() => h.plugin.setup(foreign.engine), {
      name: 'MargoError',
      code: 'attached',
      message: /StencilBuffer already belongs to another engine; create a new StencilBuffer/,
    });
    h.plugin.setup(h.engine);
    h.engine.frameGraph.execute(h.context);
    assert.equal(h.counts.textures, 1);
    assert.equal(foreign.counts.textures, 0);
  } finally {
    h.plugin.dispose();
  }
});

test('invalid scene dimensions and sample counts name the settings the caller must fix', () => {
  const h = scene(),
    c = h.context;
  try {
    c.descriptor.multisample.count = 2;
    assert.throws(() => h.engine.frameGraph.execute(c), {
      name: 'RangeError',
      message: /StencilBuffer.*; set the scene sample count to 1 or 4/,
    });
    c.descriptor.multisample.count = 4;
    c.width = 0;
    assert.throws(() => h.engine.frameGraph.execute(c), {
      name: 'RangeError',
      message: /StencilBuffer dimensions.*; use positive integers within the device texture dimension limit/,
    });
    assert.equal(h.counts.textures, 0);
  } finally {
    h.plugin.dispose();
  }
});
