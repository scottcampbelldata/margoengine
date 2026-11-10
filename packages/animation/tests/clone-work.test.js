// Batch 161 job 4: the CPU work of one cloneModel copy of RobotExpressive (p-skeleton-clone's task, 50 copies a call),
// counted. The copy writes node transforms with no arrays per node, and gltf-pro groups the primitives by node in one
// pass instead of one filter of every primitive per primitive node; the copies come out the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneModel } from '../dist/skeleton-utils.js';
import { engine, model } from './support/models.js';
import { PBRModel } from '../../gltf-pro/dist/index.js';
import { animatorGLB } from '../../../tests/support/animator-rig.js';

const robot = new URL('../../../examples/assets/robot-expressive.glb', import.meta.url),
  sources = globalThis[Symbol.for('margoengine.mesh-sources.v1')],
  lanes = ['x', 'y', 'z', 'sx', 'sy', 'sz', 'qx', 'qy', 'qz', 'qw'];

/** Runs `run` with counters on the node setters (arrays passed) and on Array.prototype.filter over primitive lists. */
async function counted(mesh, primitives, run) {
  const proto = Object.getPrototypeOf(mesh),
    saved = { setPosition: proto.setPosition, setScale: proto.setScale, setQuaternion: proto.setQuaternion },
    filter = Array.prototype.filter,
    counts = { setPosition: 0, setScale: 0, setQuaternion: 0, arrays: new Set(), filters: 0 };
  for (const name of Object.keys(saved))
    proto[name] = function (value) {
      counts[name]++;
      counts.arrays.add(value);
      return saved[name].call(this, value);
    };
  Array.prototype.filter = function (...args) {
    if (this.length === primitives && this.every((p) => p && typeof p === 'object' && 'nodeIndex' in p))
      counts.filters++;
    return filter.apply(this, args);
  };
  try {
    return { result: await run(), counts };
  } finally {
    Object.assign(proto, saved);
    Array.prototype.filter = filter;
  }
}

test('a RobotExpressive copy writes its nodes with no arrays per node and groups primitives in one pass', async () => {
  const e = await engine(1024),
    source = model(e, animatorGLB(robot));
  // A pose that is not the file's: copies must take the source's current transforms, visibility and weights.
  source.nodes[3].setQuaternion([0.1, 0.2, 0.3, 0.9]).setPosition([0.5, -1, 2]).setScale([1.5, 0.75, 2]);
  source.nodes[5].visible = false;
  const morphed = source.primitives.find((p) => p.weights.length);
  morphed.weights.fill(0.25);
  const nodes = source.nodes.length,
    primitives = source.primitives.length,
    // The constructor alone (each copy runs it): it places every node from its glTF definition.
    { result: bare, counts: base } = await counted(source.root, primitives, () => new PBRModel(e, source.asset)),
    { result: clone, counts } = await counted(source.root, primitives, () => cloneModel(source));
  bare.dispose();
  // Work counts beyond the constructor (the parent: a position, a scale and a quaternion array per node and the
  // root, and one filter of all 19 primitives per node that has primitives).
  assert.equal(counts.setPosition - base.setPosition, 0, 'setPosition calls of the copy');
  assert.equal(counts.setScale - base.setScale, 0, 'setScale calls of the copy');
  assert.equal(counts.setQuaternion - base.setQuaternion, nodes + 1, 'one quaternion write per node and the root');
  assert.equal(counts.arrays.size - base.arrays.size, 1, 'arrays passed to the node setters by the copy');
  assert.equal(base.filters, 0, 'filter passes over the primitives in the constructor');
  assert.equal(counts.filters, 0, 'filter passes over the primitives in a copy');
  // The same copy as the parent's: a model built the same way and copied as the parent did (a position, a scale and a
  // quaternion array through the setters per node) holds the same store lanes, Euler lanes and visibility, bit for bit.
  const t = e.store.transforms,
    reference = new PBRModel(e, source.asset);
  for (const [from, to] of [[source.root, reference.root], ...source.nodes.map((n, i) => [n, reference.nodes[i]])]) {
    const a = from.id;
    to.setPosition([t.x[a], t.y[a], t.z[a]])
      .setScale([t.sx[a], t.sy[a], t.sz[a]])
      .setQuaternion([t.qx[a], t.qy[a], t.qz[a], t.qw[a]]);
    to.visible = from.visible;
  }
  for (const [i, node] of [[-1, reference.root], ...reference.nodes.entries()]) {
    const copy = i < 0 ? clone.root : clone.nodes[i];
    for (const lane of lanes) assert.ok(Object.is(t[lane][copy.id], t[lane][node.id]), `node ${i} ${lane}`);
    for (let c = 0; c < 3; c++)
      assert.ok(Object.is(e.store.rotations[copy.id * 3 + c], e.store.rotations[node.id * 3 + c]), `node ${i} euler`);
    assert.equal(copy.visible, node.visible);
  }
  reference.dispose();
  // The same scene structure: each copied node hangs under the copy of its source parent.
  const index = (m, id) => (id === m.root.id ? -1 : id === -1 ? -2 : m.nodes.findIndex((n) => n.id === id));
  source.nodes.forEach((node, i) =>
    assert.equal(index(clone, e.store.parents[clone.nodes[i].id]), index(source, e.store.parents[node.id]), `parent ${i}`),
  );
  assert.equal(e.store.parents[clone.root.id], -1, 'clone root unparented');
  clone.primitives.forEach((p, i) => {
    assert.equal(p.vertices, source.primitives[i].vertices, 'packed vertices shared');
    assert.deepEqual(p.weights, source.primitives[i].weights);
  });
  // The per-node mesh sources hold the same primitives, in model order, as filtering per node did.
  for (const m of [source, clone])
    for (const node of new Set(m.primitives.map((p) => p.node))) {
      const own = sources.get(node);
      assert.deepEqual(
        own.primitives,
        m.primitives.filter((p) => p.node === node),
      );
      assert.equal(own.primitives.length, m.primitives.filter((p) => p.node === node).length);
    }
  clone.dispose();
  source.dispose();
  e.dispose();
});

test('a copy of a node whose store scale is zero still throws core setScale error', async () => {
  const e = await engine(1024),
    source = model(e, animatorGLB(robot));
  e.store.transforms.sx[source.nodes[2].id] = 0;
  let expected;
  try {
    source.nodes[2].setScale([0, 1, 1]);
  } catch (error) {
    expected = error;
  }
  await assert.rejects(
    cloneModel(source),
    (error) => error.constructor === expected.constructor && error.message === expected.message,
  );
  source.dispose();
  e.dispose();
});
