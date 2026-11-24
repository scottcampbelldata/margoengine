// BiomeView.attach awaits several imports and builds parts between them. An abort (or any failure) in between must
// dispose everything built so far, then rethrow the reason (KB-BIOMES-ATTACH-ABORT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';
import { BiomeWorld } from '../dist/index.js';
import { BiomeView } from '../dist/view.js';

// A signal that reads as aborted from its `after`th `aborted` read on, so the abort lands between two chosen awaits.
const signalAbortingAt = (after, reason) => {
  const signal = new AbortController().signal;
  let reads = 0;
  Object.defineProperty(signal, 'aborted', { get: () => ++reads > after });
  Object.defineProperty(signal, 'reason', { get: () => reason });
  return signal;
};

const watchDispose = () => {
  const real = BiomeView.prototype.dispose, disposed = [];
  BiomeView.prototype.dispose = function () { if (!disposed.includes(this)) disposed.push(this); return real.call(this); };
  return { disposed, restore: () => { BiomeView.prototype.dispose = real; } };
};

const configs = [
  ['terrain only', { objects: false, water: false, canopy: 0, horizon: true }],
  ['plant states and wet ground', {
    water: false, canopy: 0, far: false, radius: 300,
    wetness: { record: () => undefined, origin: [0, 0], size: [64, 64] },
  }],
];

for (const [label, options] of configs)
  test(`an abort while BiomeView.attach loads its parts (${label}) disposes what it built and rethrows the reason`, { timeout: 240000 }, async () => {
    const adapter = await nodeLifetimeAdapter(), spy = watchDispose();
    try {
      const { engine } = await adapter.create();
      const world = await BiomeWorld.create({ size: [512, 512], workers: 0 });
      let aborted = 0;
      // Every read count from "right after the first import" on: wherever the abort lands, the built view is disposed.
      for (let after = 2; after <= 9; after++) {
        const reason = new Error(`abort after ${after} reads`), before = spy.disposed.length;
        const outcome = await BiomeView.attach(engine, world, { ...options, signal: signalAbortingAt(after, reason) })
          .then((view) => view, (error) => error);
        if (outcome instanceof BiomeView) { outcome.dispose(); continue; }
        aborted++;
        assert.equal(outcome, reason, `after ${after} reads: the abort reason is rethrown`);
        assert.equal(spy.disposed.length - before, 1, `after ${after} reads: the built view was disposed`);
        assert.equal(engine.sceneOf(spy.disposed.at(-1).terrain), undefined, `after ${after} reads: its terrain left the scene`);
      }
      assert.ok(aborted >= 1, 'at least one read count aborted mid-attach');
      assert.deepEqual([...engine.scene.plugins.keys()].filter((n) => n.startsWith('biomes-view:')), []);
      world.dispose();
      engine.dispose();
    } finally { spy.restore(); adapter.close(); }
  });
