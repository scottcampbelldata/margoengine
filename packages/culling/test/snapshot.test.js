// SnapshotRendering (@margoengine/culling/snapshot) without a GPU: what keeps a recording and what drops it. The
// pictures and the replayed passes are checked in test/gpu/snapshot-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotRendering } from '../dist/snapshot.js';

/** The plugin set up on a stand-in engine, with a frame function that runs its pass as core would. */
function rig(options) {
  const buffers = { vertex: {}, index: {}, instance: {} },
    engine = { gpu: {}, geometryBuffers: () => buffers, sceneOf: () => undefined },
    plugin = new SnapshotRendering(options),
    passes = [];
  plugin.setup(engine);
  plugin.registerPasses({ add: (pass) => passes.push(pass) });
  const batch = { geometry: { indices: new Uint32Array(36) }, count: 2 };
  const frame = (view = 'main') => {
    const context = { backend: 'webgpu', batches: [batch], view: { id: view } };
    passes[0].execute(context);
    return context;
  };
  /** A frame, then core's part: a draw handed an empty snapshot records a bundle into it. */
  const draw = (view) => {
    const context = frame(view),
      recorded = !context.snapshot.bundle;
    if (recorded) context.snapshot.bundle = {};
    return { recorded, context };
  };
  return { plugin, buffers, batch, frame, draw };
}

test('an unchanged scene replays; rebuilt buffers, a new view and reset record again', () => {
  const { plugin, buffers, draw } = rig();
  assert.equal(draw().recorded, true);
  assert.equal(draw().recorded, false);
  assert.equal(draw().context.indirect, true);
  buffers.vertex = {};
  assert.equal(draw().recorded, true);
  assert.equal(draw('second').recorded, true);
  assert.equal(draw('second').recorded, false);
  plugin.reset();
  assert.equal(draw().recorded, true);
  assert.deepEqual(plugin.stats, { frames: 7, recorded: 4 });
});

test('an instance count keeps an indirect recording and drops a direct one', () => {
  for (const indirect of [true, false]) {
    const { batch, draw } = rig({ indirect });
    draw();
    batch.count = 5;
    assert.equal(draw().recorded, !indirect);
    batch.count = 0;
    assert.equal(draw().recorded, true, 'a batch that stops drawing records again');
  }
});

test('a recording is counted even when a restore or dispose drops it before the next frame', () => {
  for (const drop of [(plugin) => plugin.onDeviceRestored({ gpu: {} }), (plugin) => plugin.dispose()]) {
    const { plugin, draw } = rig();
    draw();
    drop(plugin);
    assert.deepEqual(plugin.stats, { frames: 1, recorded: 1 });
  }
});

test('disabled and disposed plugins hand core no snapshot', () => {
  const { plugin, draw, frame } = rig();
  draw();
  plugin.enabled = false;
  assert.equal(frame().snapshot, undefined);
  plugin.dispose();
  plugin[Symbol.dispose]();
  assert.equal(plugin.disposed, true);
  assert.throws(() => plugin.setup({ gpu: {} }), { code: 'disposed' });
});

test('bad options and an engine with no GPU are refused with the reason', () => {
  assert.throws(() => new SnapshotRendering({ indirect: 1 }), TypeError);
  assert.throws(() => new SnapshotRendering().setup({ gpu: null }), { code: 'unsupported' });
});
