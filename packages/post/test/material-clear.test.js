import test from 'node:test';
import assert from 'node:assert/strict';
import { PostStack, SSGI, SSR } from '../dist/index.js';
import { harness } from './support.js';

// KB0106: in a partial view SSR and SSGI clear their material targets with a draw, whose colour lives in a 16-byte
// uniform buffer cached per device by post's copy of shared/clear-color.js. Disposal (and the release on resize or
// device restore) left that buffer alive for as long as the device.
const partial = { viewport: [0, 0, 640, 360], scissor: [0, 0, 320, 360], clear: { color: '#336699' } };
const tint = String(new Float32Array([0x33 / 255, 0x66 / 255, 0x99 / 255, 1]));
// The clear colour buffers: the live buffers written with the view's clear colour.
function tracked() {
  const h = harness(),
    tinted = new WeakSet(),
    queue = h.gpu.device.queue,
    write = queue.writeBuffer;
  queue.writeBuffer = function (buffer, offset, data, ...rest) {
    if (data instanceof Float32Array && String(data) === tint) tinted.add(buffer);
    return write.call(this, buffer, offset, data, ...rest);
  };
  h.view.c.view = partial;
  return Object.assign(h, { clears: () => h.live().filter((r) => tinted.has(r)) });
}

for (const [name, Effect] of [['SSR', SSR], ['SSGI', SSGI]])
  test(`${name} frees its partial-view clear colour buffer on resize and dispose`, async () => {
    const h = tracked();
    h.engine.use(new PostStack([new Effect()]));
    h.frame();
    assert.equal(h.clears().length, 1, 'the partial view made one clear colour buffer');
    // Steady frames make no buffer: the colour stays cached while the pass lives.
    const before = h.live().length;
    await null; // the next frame
    h.frame();
    assert.equal(h.live().length, before);
    // A resize releases the sized targets and the material clear with them; the next frame makes one colour again.
    await null;
    h.view.state.width = 640;
    h.frame();
    await null; // released resources are destroyed at the end of the task
    assert.equal(h.clears().length, 1, 'the released clear buffer is destroyed, one is live');
    assert.equal(h.live().length, before);
    h.engine.removePlugin('post:stack');
    await null; // released resources are destroyed at the end of the task
    assert.deepEqual(h.live(), [], 'dispose leaves no buffer behind');
  });

test('SSR and SSGI free their clear colour buffers on device restore', async () => {
  const h = tracked();
  h.engine.use(new PostStack([new SSGI(), new SSR()]));
  h.frame();
  const old = h.clears();
  assert.equal(old.length, 1, 'both passes share the cached colour');
  h.engine.restore();
  await null;
  assert.ok(old.every((b) => b.destroyed), 'restore destroys the clear colour buffer');
  h.frame();
  assert.equal(h.clears().length, 1, 'the next frame makes it again');
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), []);
});
