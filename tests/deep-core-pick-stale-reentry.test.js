// a pick resolved null when any mesh anywhere was
// created or removed during its readback, so a scene that spawns meshes every frame could never pick. Only a mesh that
// took the hit slot after the pick started must not answer. a plugin that picks in onPreUpdate re-entered the pick's
// own update without limit, and a pick asked for during a frame ran inside that frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/geometry.js';

/** A WebGPU-like renderer whose readbacks settle when the test calls `settle()`; it answers the first instance's id. */
async function rig() {
  const gates = [],
    renderer = {
      backend: 'webgpu',
      add() {},
      remove() {},
      dispose() {},
      render() {},
      pick(_camera, _lighting, batches) {
        const ids = [...batches].flatMap((b) => Array.from({ length: b.count }, (_, i) => b.instances[i * 24 + 23]));
        return new Promise((resolve) => gates.push(() => resolve(ids[0] ?? -1)));
      },
    },
    canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 },
    engine = new Engine(canvas, await TransformStore.create(8), renderer, undefined, null);
  const settle = async () => {
    while (!gates.length) await null;
    gates.shift()();
  };
  return { engine, settle, gates };
}

test('a pick answers its mesh when unrelated meshes are created and removed during the readback', async () => {
  const { engine, settle } = await rig();
  try {
    const shape = box(),
      target = engine.createMesh().setGeometry(shape);
    const pending = engine.pick(50, 50);
    engine.createMesh().dispose();
    const spawned = engine.createMesh().setGeometry(shape);
    await settle();
    assert.equal(await pending, target, 'the picked mesh, not null');
    spawned.dispose();
  } finally {
    engine.dispose();
  }
});

test('a pick whose hit slot was freed and taken by a new mesh during the readback resolves null', async () => {
  const { engine, settle } = await rig();
  try {
    const shape = box(),
      target = engine.createMesh().setGeometry(shape),
      slot = target.id;
    const pending = engine.pick(50, 50);
    target.dispose();
    const reused = engine.createMesh().setGeometry(shape);
    assert.equal(reused.id, slot, 'the new mesh takes the freed slot');
    await settle();
    assert.equal(await pending, null, 'a mesh created after the pick started never answers it');
  } finally {
    engine.dispose();
  }
});

test('a plugin that picks in onPreUpdate does not re-enter it, and every pick resolves', async () => {
  const { engine, settle } = await rig();
  let depth = 0,
    deepest = 0,
    calls = 0;
  const picks = [];
  try {
    const target = engine.createMesh().setGeometry(box());
    engine.use({
      name: 'hover',
      setup() {},
      onPreUpdate() {
        depth++;
        deepest = Math.max(deepest, depth);
        // One hover pick per update, for the first three updates: enough to show nesting without an endless chain.
        if (++calls <= 3) picks.push(engine.pick(50, 50));
        depth--;
      },
    });
    engine.render({ culling: false });
    picks.push(engine.pick(50, 50));
    assert.equal(deepest, 1, 'onPreUpdate never runs inside itself');
    for (let i = 0; i < 4; i++) await settle();
    const results = await Promise.all(picks);
    assert.equal(results.length, 4);
    for (const result of results) assert.equal(result, target);
    assert.equal(deepest, 1);
  } finally {
    engine.dispose();
  }
});

test('a pick asked for during a frame starts after that frame, not inside it', async () => {
  const { engine, settle, gates } = await rig();
  try {
    const target = engine.createMesh().setGeometry(box());
    let pending,
      asked = false,
      during = -1;
    engine.use({
      name: 'clicker',
      setup() {},
      onPreUpdate() {
        if (asked) return;
        asked = true;
        pending = engine.pick(50, 50);
        during = gates.length;
      },
    });
    engine.render({ culling: false });
    assert.equal(during, 0, 'no readback started inside the frame');
    await settle();
    assert.equal(await pending, target);
  } finally {
    engine.dispose();
  }
});
