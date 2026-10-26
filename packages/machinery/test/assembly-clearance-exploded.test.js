// Behaviour of the assembly, clearance and exploded entries, imported by their package subpaths as a consumer does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box, engineRuntime } from '@margoengine/core/extension';
import { AssemblyIndex } from '@margoengine/machinery/assembly';
import { measureClearance } from '@margoengine/machinery/clearance';
import { ExplodedView } from '@margoengine/machinery/exploded';

async function scene(capacity = 16) {
  return new Engine(
    { width: 200, height: 200, clientWidth: 200, clientHeight: 200 },
    await TransformStore.create(capacity),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}
const named = (engine, name, parent) => {
  const mesh = engine.createMesh(parent);
  mesh.name = name;
  return mesh;
};

test('AssemblyIndex finds parts by wildcard name and tag, scoped to a root, and hides a subtree', async () => {
  const engine = await scene();
  try {
    const left = named(engine, 'Left arm'),
      right = named(engine, 'Right arm'),
      boltA = named(engine, 'Bolt M4', left),
      boltB = named(engine, 'Bolt M6', right),
      plate = named(engine, 'Plate', left),
      index = new AssemblyIndex(engine);
    const names = (found) => found.map((mesh) => mesh.name).sort();
    assert.deepEqual(names(index.findChildrenByName('Bolt*')), ['Bolt M4', 'Bolt M6']);
    assert.deepEqual(names(index.findChildrenByName('Bolt*', left)), ['Bolt M4']);
    assert.deepEqual(names(index.findChildrenByName('Plate')), ['Plate']);
    // Regular expression characters in a pattern are literal text.
    assert.deepEqual(index.findChildrenByName('Bolt M.'), []);
    index.tag(boltA, 'fastener');
    index.tag(boltB, 'fastener');
    index.tag(plate, 'sheet');
    assert.equal(index.findByTag('fastener').length, 2);
    assert.deepEqual(names(index.findByTag('fastener', right)), ['Bolt M6']);
    assert.deepEqual(index.findByTag('unknown'), []);
    index.untag(boltB, 'fastener');
    assert.deepEqual(names(index.findByTag('fastener')), ['Bolt M4']);
    index.setSubtreeVisible(left, false);
    assert.equal(left.visible, false);
    index.setSubtreeVisible(left, true);
    assert.equal(left.visible, true);
    // A renamed mesh is found under its new name after refresh(); a disposed one drops out of names and tags.
    boltA.name = 'Screw';
    index.refresh();
    assert.deepEqual(
      index.findChildrenByName('Bolt*').map((mesh) => mesh.name),
      ['Bolt M6'],
    );
    assert.deepEqual(names(index.findChildrenByName('Screw')), ['Screw']);
    boltA.dispose();
    index.refresh();
    assert.deepEqual(index.findChildrenByName('Screw'), []);
    assert.deepEqual(index.findByTag('fastener'), []);
  } finally {
    engine.dispose();
  }
});

test('AssemblyIndex rejects bad tags and patterns, and a root from another engine, with messages that name the fix', async () => {
  const engine = await scene(),
    other = await scene();
  try {
    const part = named(engine, 'Part'),
      foreign = named(other, 'Foreign'),
      index = new AssemblyIndex(engine);
    assert.throws(() => index.tag(part, ''), {
      name: 'TypeError',
      message: /^Assembly tag must be a non-empty string/,
    });
    assert.throws(() => index.tag(part, 'x'.repeat(257)), TypeError);
    assert.throws(() => index.tag(foreign, 'tag'), TypeError);
    assert.throws(() => index.findChildrenByName('x'.repeat(257)), {
      name: 'TypeError',
      message: /^Name pattern must be/,
    });
    assert.throws(() => index.findChildrenByName(7), TypeError);
    assert.throws(() => index.findChildrenByName('Part', foreign), {
      name: 'TypeError',
      message: /^Assembly root belongs to another engine; pass a mesh/,
    });
    assert.throws(() => index.setSubtreeVisible(foreign, false), TypeError);
    foreign.dispose();
    assert.throws(() => index.setSubtreeVisible(foreign, false), /disposed/);
  } finally {
    other.dispose();
    engine.dispose();
  }
});

test('measureClearance reports gap, touching, interference and closest points for boxes', async () => {
  const engine = await scene(),
    near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
  try {
    const a = engine.createMesh().setGeometry(box()),
      b = engine.createMesh().setGeometry(box()).setPosition([3, 0, 0]);
    engine.render();
    let result = measureClearance(a, b);
    near(result.distance, 2);
    assert.equal(result.interfering, false);
    near(result.pointA[0], 0.5);
    near(result.pointB[0], 2.5);
    b.setPosition([1, 0, 0]);
    engine.render();
    result = measureClearance(a, b);
    assert.deepEqual([result.distance, result.interfering], [0, false]);
    b.setPosition([0.5, 0, 0]);
    engine.render();
    result = measureClearance(a, b, 'aabb');
    assert.deepEqual([result.distance, result.interfering], [0, true]);
    // A box turned 45 degrees about Z is closer along X with an oriented box (OBB) than its axis-aligned bounds are.
    b.setPosition([3, 0, 0]).setRotation([0, 0, Math.PI / 4]);
    engine.render();
    near(measureClearance(a, b, 'obb').distance, 2.5 - Math.SQRT1_2);
    near(measureClearance(a, b, 'aabb').distance, 2.5 - Math.SQRT1_2);
  } finally {
    engine.dispose();
  }
});

test('measureClearance rejects unknown bounds, meshes without geometry, shear for OBB and disposed meshes', async () => {
  const engine = await scene();
  try {
    const a = engine.createMesh().setGeometry(box()),
      b = engine.createMesh().setGeometry(box()).setPosition([3, 0, 0]),
      empty = engine.createMesh();
    engine.render();
    assert.throws(() => measureClearance(a, b, 'sphere'), {
      name: 'TypeError',
      message: /^Clearance bounds must be 'aabb' or 'obb'/,
    });
    assert.throws(() => measureClearance(a, empty), { name: 'TypeError', message: /requires geometry/ });
    const parent = engine.createMesh().setScale([2, 1, 1]);
    b.setParent(parent);
    b.setRotation([0, 0, Math.PI / 4]);
    engine.render();
    assert.throws(() => measureClearance(a, b), /shear/);
    assert.ok(Number.isFinite(measureClearance(a, b, 'aabb').distance));
    b.dispose();
    assert.throws(() => measureClearance(a, b), /disposed/);
  } finally {
    engine.dispose();
  }
});

test('ExplodedView moves parts along their offsets, writes only when amount changes and restores on zero', async () => {
  const engine = await scene();
  try {
    const first = engine.createMesh().setPosition([1, 0, 0]),
      second = engine.createMesh(),
      view = ExplodedView.attach(engine, [
        { node: first, offset: [4, 0, 0] },
        { node: second, offset: [0, 2, 0] },
      ]);
    assert.equal(view.amount, 0);
    engine.render();
    assert.deepEqual([first.position.x, second.position.y], [1, 0]);
    view.amount = 0.5;
    engine.render();
    assert.deepEqual([first.position.x, second.position.y], [3, 1]);
    // At rest the view writes nothing: a position set by hand survives a frame while the amount is unchanged.
    first.setPosition([9, 0, 0]);
    engine.render();
    assert.equal(first.position.x, 9);
    view.amount = 1;
    engine.render();
    assert.deepEqual([first.position.x, second.position.y], [5, 2]);
    view.amount = 0;
    engine.render();
    assert.deepEqual([first.position.x, second.position.y], [1, 0]);
    view.dispose();
    view[Symbol.dispose]();
  } finally {
    engine.dispose();
  }
});

test('ExplodedView rejects an amount outside 0..1, bad offsets, foreign nodes and positions beyond float32', async () => {
  const engine = await scene(),
    other = await scene();
  try {
    const runtime = engineRuntime(engine),
      node = engine.createMesh(),
      view = ExplodedView.attach(engine, [{ node, offset: [1, 0, 0] }]);
    view.amount = 1.1;
    assert.throws(() => engine.render(), RangeError);
    view.amount = Number.NaN;
    assert.throws(() => engine.render(), RangeError);
    assert.throws(() => new ExplodedView([{ node, offset: [1, 0] }]).setup(runtime), {
      name: 'TypeError',
      message: /^Invalid exploded part: node must belong to this engine/,
    });
    assert.throws(() => new ExplodedView([{ node, offset: [Number.NaN, 0, 0] }]).setup(runtime), TypeError);
    assert.throws(() => new ExplodedView([{ node: other.createMesh(), offset: [1, 0, 0] }]).setup(runtime), TypeError);
    engine.removePlugin(view.name);
    const huge = engine.createMesh().setPosition([3e38, 0, 0]),
      overflow = new ExplodedView([{ node: huge, offset: [3e38, 0, 0] }]);
    engine.use(overflow);
    overflow.amount = 1;
    const saved = huge.position.x;
    assert.throws(() => overflow.onPreUpdate(), {
      name: 'RangeError',
      message: /^Exploded position is not finite in float32; reduce/,
    });
    assert.equal(huge.position.x, saved);
  } finally {
    other.dispose();
    engine.dispose();
  }
});
