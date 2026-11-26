// packages/shared/scene-pass.js: the attachment objects a joined scene pass keeps, and the pass begun on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginScenePass, sceneAttachments } from '../packages/shared/scene-pass.js';

const context = (format) => {
  const calls = [];
  return {
    calls,
    color: { name: 'colour view' },
    depth: { name: 'depth view' },
    descriptor: { depthStencil: { format } },
    attach: (...args) => calls.push(['attach', ...args]),
    encoder: { beginRenderPass: (descriptor) => (calls.push(['begin', descriptor]), 'pass') },
  };
};

test('each owner gets its own attachment objects, which a frame points at the scene targets and reuses', () => {
  const mine = sceneAttachments(),
    other = sceneAttachments();
  assert.notEqual(mine.color, other.color);
  assert.notEqual(mine.depth, other.depth);
  for (const format of ['depth24plus-stencil8', 'depth32float']) {
    const c = context(format),
      stencil = format.includes('stencil') ? ['load', 'store'] : [undefined, undefined];
    assert.equal(beginScenePass(c, mine.color, mine.depth), 'pass');
    assert.deepEqual(mine.color, { view: c.color, loadOp: 'load', storeOp: 'store', resolveTarget: undefined });
    assert.deepEqual([mine.depth.view, mine.depth.depthLoadOp, mine.depth.depthStoreOp], [c.depth, 'load', 'store']);
    assert.deepEqual([mine.depth.stencilLoadOp, mine.depth.stencilStoreOp], stencil);
    assert.deepEqual(c.calls[0], ['attach', mine.color, mine.depth, true]);
    assert.equal(c.calls[1][1].colorAttachments[0], mine.color);
    assert.equal(c.calls[1][1].depthStencilAttachment, mine.depth);
  }
  assert.equal(other.color.view, undefined);
});
