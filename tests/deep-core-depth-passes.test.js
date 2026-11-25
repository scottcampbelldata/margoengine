// setParent counted only the new parent's
// ancestors, so moving a subtree could build a chain deeper than the kernel's 64 and every later render threw.
// FrameGraph.add stored a spread copy of the pass, so a class-instance pass lost execute and prepare (they live on the
// prototype) and an object-literal pass ran with `this` bound to the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { FrameGraph } from '../packages/core/dist/plugin.js';
import { box } from '../packages/core/dist/geometry.js';

const renderer = () => ({ backend: 'webgpu', add() {}, remove() {}, dispose() {}, render() {} });
const canvas = () => ({ width: 4, height: 4, clientWidth: 4, clientHeight: 4 });

/** A chain of `n` meshes, each the parent of the next; returns them from the root down. */
function chain(engine, n) {
  const meshes = [engine.createMesh().setGeometry(box())];
  for (let i = 1; i < n; i++) meshes.push(engine.createMesh(meshes[i - 1]).setGeometry(box()));
  return meshes;
}

test('setParent counts the moved subtree, so no chain passes depth 64', async () => {
  const engine = new Engine(canvas(), await TransformStore.create(160), renderer(), undefined, null);
  try {
    const a = chain(engine, 40),
      b = chain(engine, 40);
    engine.render({ culling: false });
    assert.throws(
      () => b[0].setParent(a[39]),
      (error) => error instanceof RangeError && /Parent depth: 64/.test(error.message),
    );
    assert.equal(engine.store.parents[b[0].id], -1, 'the hierarchy is unchanged');
    assert.ok(a[39].kids === undefined || a[39].kids.size === 0);
    engine.render({ culling: false });

    const c = chain(engine, 30),
      d = chain(engine, 30);
    d[0].setParent(c[29]);
    assert.equal(engine.store.parents[d[0].id], c[29].id, 'a 30 under 30 move is accepted');
    engine.render({ culling: false });
    // Depth 64 exactly is the kernel's limit: 32 under 32 ends at 64 meshes and is accepted, 33 under 32 is not.
    const e = chain(engine, 32),
      f = chain(engine, 33);
    assert.throws(() => f[0].setParent(e[31]), /Parent depth: 64/);
    f[32].dispose();
    f[0].setParent(e[31]);
    engine.render({ culling: false });
  } finally {
    engine.dispose();
  }
});

test("a frame graph runs the caller's own pass objects, class instances included", () => {
  class Counter {
    name = 'counter';
    order = 1;
    calls = 0;
    prepared = 0;
    execute() {
      this.calls++;
    }
    prepare() {
      this.prepared++;
    }
  }
  const instance = new Counter(),
    literal = {
      name: 'literal',
      order: 2,
      calls: 0,
      execute() {
        this.calls++;
      },
    },
    graph = new FrameGraph(),
    context = { backend: 'webgl2', draw() {} };
  graph.add(instance);
  const remove = graph.add(literal);
  graph.prepare(context);
  graph.execute(context);
  assert.equal(instance.calls, 1, 'the class instance ran on itself');
  assert.equal(instance.prepared, 1, 'its prototype prepare ran');
  assert.equal(literal.calls, 1, "the object literal ran with this bound to the caller's object");
  remove();
  graph.execute(context);
  assert.equal(literal.calls, 1, 'a removed pass does not run');
  assert.equal(instance.calls, 2);
  graph.withOwner('plugin', () => graph.add({ ...literal, name: 'owned', calls: 0 }));
  graph.removeOwner('plugin');
  graph.execute(context);
  assert.equal(instance.calls, 3, 'removeOwner leaves passes without that owner');
});
