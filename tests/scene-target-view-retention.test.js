// SceneTarget's actual encoder descriptors on the existing recorder. Native
// multi-view HDR evidence is separate; these checks do not fabricate pixels.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneTarget } from '../packages/shared/msaa.js';
import { optionalGPU } from './support/optional-gpu.js';

function harness(samples = 4) {
  const h = optionalGPU(),
    c = h.context,
    device = h.engine.gpu,
    passes = [],
    color = device.createTexture({ size: [128, 96], format: 'rgba16float' }),
    depth = device.createTexture({ size: [128, 96], format: 'depth32float' }),
    target = new SceneTarget(device, color, depth, samples),
    original = { color: c.color, depth: c.depth, descriptor: c.descriptor },
    begin = c.encoder.beginRenderPass;
  c.encoder.beginRenderPass = (descriptor) => {
    const attachment = descriptor.colorAttachments?.[0];
    if (attachment?.resolveTarget?.texture === color)
      passes.push({
        colorLoad: attachment.loadOp,
        colorStore: attachment.storeOp,
        depthLoad: descriptor.depthStencilAttachment?.depthLoadOp,
        depthStore: descriptor.depthStencilAttachment?.depthStoreOp,
      });
    return { ...begin(descriptor), setViewport() {}, setScissorRect() {} };
  };
  return {
    ...h,
    color,
    depth,
    passes,
    frame(view, final = true) {
      c.view = view;
      target.begin(c);
      target.resolve(c.encoder, final);
      target.restore(c);
      assert.equal(c.color, original.color);
      assert.equal(c.depth, original.depth);
      assert.equal(c.descriptor, original.descriptor);
      assert.equal(color.destroyed, false, 'resolved color is borrowed');
      assert.equal(depth.destroyed, false, 'resolved depth is borrowed');
    },
    close() {
      target.dispose();
      h.cleanup();
    },
  };
}

const views = [
  { id: 'left', viewport: [0, 0, 64, 96], index: 0 },
  { id: 'right', viewport: [64, 0, 64, 96], index: 1 },
  { id: 'full-before-overlay', viewport: [0, 0, 128, 96], index: 0 },
  { id: 'scissor', viewport: [0, 0, 128, 96], scissor: [16, 8, 64, 64], index: 0 },
];

for (const view of views)
  test('final MSAA resolve retains other view regions for ' + view.id, () => {
    const h = harness();
    try {
      h.frame(view);
      assert.equal(h.passes.length, 1);
      assert.deepEqual(h.passes[0], {
        colorLoad: 'load',
        colorStore: 'store',
        depthLoad: 'load',
        depthStore: 'store',
      });
    } finally {
      h.close();
    }
  });

test('ordinary final resolve keeps its discard policy without a view', () => {
  const h = harness();
  try {
    h.frame();
    assert.deepEqual(h.passes, [
      { colorLoad: 'load', colorStore: 'discard', depthLoad: 'load', depthStore: 'discard' },
    ]);
  } finally {
    h.close();
  }
});

test('stacked resolves retain samples without new resources and ordinary frames recover discard', () => {
  const h = harness();
  try {
    h.frame();
    const allocations = { textures: h.counts.textures, pipelines: h.pipelines.length, groups: h.groups.length };
    h.frame(views[0]);
    h.frame(views[1]);
    h.frame(views[0]);
    h.frame();
    assert.deepEqual(
      h.passes.map((p) => [p.colorStore, p.depthStore]),
      [
        ['discard', 'discard'],
        ['store', 'store'],
        ['store', 'store'],
        ['store', 'store'],
        ['discard', 'discard'],
      ],
    );
    assert.deepEqual(
      { textures: h.counts.textures, pipelines: h.pipelines.length, groups: h.groups.length },
      allocations,
      'view changes reuse the same attachments and resolve pipelines',
    );
  } finally {
    h.close();
  }
});

test('nonfinal resolve preserves its store policy for ordinary and viewed contexts', () => {
  const h = harness();
  try {
    h.frame(undefined, false);
    h.frame(views[0], false);
    assert.equal(h.passes.length, 2);
    for (const pass of h.passes) {
      assert.equal(pass.colorLoad, 'load');
      assert.equal(pass.colorStore, 'store');
      assert.equal(pass.depthStore, undefined, 'nonfinal color resolve does not own depth');
    }
  } finally {
    h.close();
  }
});

test('single-sample view captures still perform no multisample resolve', () => {
  const h = harness(1);
  try {
    for (const view of views) h.frame(view);
    assert.equal(h.passes.length, 0);
    assert.equal(h.counts.render, 0);
  } finally {
    h.close();
  }
});
