// BatchedLOD: per-item frustum culling and levels of detail for a BatchedMesh. The GPU fake records buffer contents;
// the drawn result is checked on a real GPU by test/batched-lod-browser.mjs. Every reduction is a work count (items,
// triangles, box tests), never a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material } from '../dist/index.js';
import { BatchedMesh } from '../dist/batched.js';
import { BatchedLOD, MAX_BATCHED_LEVELS } from '../dist/batched-lod.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function world() {
  const h = optionalGPU(),
    device = h.engine.gpu;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  let passes = 0;
  const context = {
    backend: 'webgpu',
    device,
    encoder: {
      beginComputePass() {
        passes++;
        return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
      },
    },
  };
  // The engine's camera, placed and with its planes rebuilt, as a frame would.
  const look = (position, target = [0, 0, 0]) => {
    engine.camera.position = position;
    engine.camera.target = target;
    engine.camera.update(1, true);
    return engine.camera;
  };
  return { engine, context, passes: () => passes, look };
}
// Both centred on the origin, so an item's box centre is its translation.
const fine = {
  positions: [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 2, 1, 3],
};
const coarse = {
  positions: [-1, -1, 0, 1, -1, 0, -1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
};
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const flags = (batch) => {
  const items = new Float32Array(batch.gpu.items.data);
  return (id) => items[id * 20 + 19];
};
// A fixed sequence, so every run tests the same boxes.
const random = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed / 2 ** 32);

test('items outside the frustum are not drawn, and come back when the camera turns to them', async () => {
  const { engine, context, look } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 8, maxVertices: 32 }),
    lod = BatchedLOD.attach(engine, batch);
  const ahead = lod.add(coarse),
    behind = lod.add(coarse, { matrix: translate(0, 0, 30) }),
    aside = lod.add(coarse, { matrix: translate(60, 0, 0) });
  lod.update(look([0, 0, 4]));
  assert.deepEqual([lod.levelOf(ahead), lod.levelOf(behind), lod.levelOf(aside)], [0, -1, -1]);
  assert.deepEqual(lod.stats, { items: 3, drawn: 1, culled: 2, triangles: 1, tests: 3 });
  assert.deepEqual([batch.isVisible(ahead), batch.isVisible(behind), batch.isVisible(aside)], [true, false, false]);
  assert.ok(lod.isVisible(behind), 'a culled item is still a shown item');
  batch.mesh.prepareDeformation(context);
  let flag = flags(batch);
  assert.deepEqual([flag(ahead), flag(behind), flag(aside)], [1, 0, 0], 'the compute pass collapses the culled items');
  lod.update(look([0, 0, 4], [0, 0, 30]));
  assert.deepEqual([lod.levelOf(ahead), lod.levelOf(behind), lod.levelOf(aside)], [-1, 0, -1]);
  batch.mesh.prepareDeformation(context);
  flag = flags(batch);
  assert.deepEqual([flag(ahead), flag(behind), flag(aside)], [0, 1, 0]);
  // An item moved into view is drawn again; a hidden item is neither drawn nor counted as culled.
  lod.setMatrix(aside, translate(0, 0, 20)).setVisible(behind, false);
  lod.update(engine.camera);
  assert.deepEqual([lod.levelOf(behind), lod.levelOf(aside)], [-1, 0]);
  assert.deepEqual(lod.stats, { items: 3, drawn: 1, culled: 1, triangles: 1, tests: 3 });
  // Culling off: everything shown draws, with no test.
  lod.culling = false;
  lod.update(engine.camera);
  assert.deepEqual(lod.stats, { items: 3, drawn: 2, culled: 0, triangles: 2, tests: 0 });
});

test('margin keeps an item just outside the view, and the batch root moves every box', async () => {
  const { engine, look } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 8, maxVertices: 32 }),
    tight = BatchedLOD.attach(engine, batch),
    padded = BatchedLOD.attach(engine, batch, { margin: 10 });
  // 60 degrees at distance 4: the view is about 2.3 units to each side at the origin, so x 8 is outside by 4.7.
  const a = tight.add(coarse, { matrix: translate(8, 0, 0) }),
    b = padded.add(coarse, { matrix: translate(8, 0, 0) });
  tight.update(look([0, 0, 4]));
  padded.update(engine.camera);
  assert.deepEqual([tight.levelOf(a), padded.levelOf(b)], [-1, 0]);
  batch.mesh.root.setPosition([-8, 0, 0]);
  engine.store.tick(false);
  tight.update(engine.camera);
  assert.equal(tight.levelOf(a), 0, 'the root brought the item to the origin');
});

test('the hierarchy keeps exactly the items a test of every item keeps, with fewer tests', async () => {
  const { engine, look } = await world(),
    N = 3000,
    make = (bvhItems) =>
      BatchedLOD.attach(
        engine,
        BatchedMesh.attach(engine, new Material(), { maxItems: N + 8, maxVertices: (N + 8) * 3 }),
        { bvhItems },
      );
  const tree = make(0),
    brute = make(Infinity),
    next = random(7),
    place = () => {
      const s = 0.2 + next() * 3;
      return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, (next() - 0.5) * 400, (next() - 0.5) * 60, (next() - 0.5) * 400, 1];
    };
  const ids = [];
  for (let i = 0; i < N; i++) {
    const matrix = place();
    ids.push(tree.add(coarse, { matrix }));
    assert.equal(brute.add(coarse, { matrix }), ids[i]);
  }
  const same = (label) => {
    let kept = 0;
    for (const id of ids)
      if (tree.has(id)) {
        assert.equal(tree.levelOf(id), brute.levelOf(id), `${label}: item ${id}`);
        kept += tree.levelOf(id) === 0;
      }
    assert.equal(tree.stats.drawn, kept);
    assert.deepEqual({ ...tree.stats, tests: 0 }, { ...brute.stats, tests: 0 }, label);
    return kept;
  };
  const views = [
    [
      [0, 5, 0],
      [100, 0, 30],
    ],
    [
      [150, 20, -150],
      [0, 0, 0],
    ],
    [
      [0, 300, 1],
      [0, 0, 0],
    ],
    [
      [-190, 0, 190],
      [-200, 0, 200],
    ],
  ];
  for (const [position, target] of views) {
    tree.update(look(position, target));
    brute.update(engine.camera);
    const kept = same(`view from ${position}`);
    assert.ok(kept > 0 && kept < N, `the view from ${position} keeps some items and drops some (${kept})`);
    assert.equal(brute.stats.tests, N, 'without the hierarchy every item is tested');
    assert.ok(tree.stats.tests < N / 2, `the hierarchy tested ${tree.stats.tests} boxes for ${N} items`);
  }
  // Moved items refit the tree as built; removed and added items build it anew.
  for (let i = 0; i < N; i += 7) {
    const matrix = place();
    tree.setMatrix(ids[i], matrix);
    brute.setMatrix(ids[i], matrix);
  }
  tree.update(engine.camera);
  brute.update(engine.camera);
  same('after moving every seventh item');
  for (let i = 0; i < N; i += 5) {
    tree.remove(ids[i]);
    brute.remove(ids[i]);
  }
  for (let i = 0; i < 4; i++) {
    const matrix = place(),
      id = tree.add(coarse, { matrix });
    assert.equal(brute.add(coarse, { matrix }), id);
    assert.ok(ids.includes(id), 'a removed id is used again');
  }
  tree.update(look([0, 5, 0], [100, 0, 30]));
  brute.update(engine.camera);
  same('after removing every fifth item and adding four');
  assert.equal(tree.count, N - N / 5 + 4);
});

test('levels switch at their distances, equality included, and come back only past the dead band', async () => {
  const { engine, context, look } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 8, maxVertices: 32 }),
    lod = BatchedLOD.attach(engine, batch);
  assert.equal(lod.hysteresis, 0.1, 'documented default');
  const id = lod.add([{ geometry: fine }, { geometry: coarse, distance: 10 }, { geometry: coarse, distance: 20 }]);
  const at = (distance) => {
    lod.update(look([0, 0, distance]));
    // Exactly the level drawn has the batch's flag: batch ids follow the item's in level order.
    batch.mesh.prepareDeformation(context);
    const flag = flags(batch),
      level = lod.levelOf(id);
    assert.deepEqual(
      [0, 1, 2].map((l) => flag(id + l)),
      [0, 1, 2].map((l) => +(l === level)),
    );
    return level;
  };
  assert.equal(at(5), 0);
  assert.equal(lod.stats.triangles, 2);
  assert.equal(at(9.99), 0);
  assert.equal(at(10), 1, 'the set distance itself switches');
  assert.equal(lod.stats.triangles, 1, 'the coarser geometry is the one drawn');
  assert.equal(at(9.5), 1, 'inside the band 9 to 10 the coarser level holds');
  assert.equal(at(9.01), 1);
  assert.equal(at(8.99), 0, 'below 10 * (1 - 0.1) the finer level returns');
  assert.equal(at(25), 2, 'coarser is never delayed, two levels at once');
  assert.equal(at(18.5), 2, 'inside the band 18 to 20');
  assert.equal(at(17.9), 1);
  assert.equal(at(5), 0);
  // Per-level hysteresis, zero hysteresis and bias.
  const wide = lod.add([{ geometry: fine }, { geometry: coarse, distance: 10, hysteresis: 0.5 }]),
    exact = BatchedLOD.attach(engine, batch, { hysteresis: 0, bias: 2 }),
    plain = exact.add([{ geometry: fine }, { geometry: coarse, distance: 10 }]);
  const levels = (distance) => {
    lod.update(look([0, 0, distance]));
    exact.update(engine.camera);
    return [lod.levelOf(wide), exact.levelOf(plain)];
  };
  assert.deepEqual(levels(4.9), [0, 0]);
  assert.deepEqual(levels(5), [0, 1], 'bias 2 doubles the distance');
  assert.deepEqual(levels(12), [1, 1]);
  assert.deepEqual(levels(5.1), [1, 1], 'a band of 0.5 holds down to 5');
  assert.deepEqual(levels(4.9), [0, 0], 'no hysteresis: back at once');
  exact.bias = 1;
  assert.deepEqual(levels(4.9), [0, 0]);
  assert.deepEqual(levels(9.9), [0, 0]);
});

test('culling and levels cut the triangles drawn, and an unchanged frame does no work', async () => {
  const { engine, context, passes, look } = await world(),
    side = 20,
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: side * side * 2, maxVertices: side * side * 7 }),
    lod = BatchedLOD.attach(engine, batch, { bvhItems: 0 });
  for (let x = 0; x < side; x++)
    for (let z = 0; z < side; z++)
      lod.add([{ geometry: fine }, { geometry: coarse, distance: 60 }], { matrix: translate(x * 4, 0, z * 4) });
  assert.equal(batch.count, side * side * 2, 'every level is an item of the batch');
  // From beyond a corner, looking along the diagonal: nearly the whole grid is in view, the far part at the coarse level.
  lod.update(look([-20, 15, -20], [40, 0, 40]));
  const all = { ...lod.stats };
  assert.deepEqual(all, { items: 400, drawn: 390, culled: 10, triangles: 448, tests: 63 });
  assert.ok(all.triangles < 800, '800 triangles with every item drawn at its finest level');
  // Looking away from most of it: the items out of view are neither drawn nor, mostly, even tested.
  lod.update(look([-20, 15, -20], [-20, 0, 40]));
  const part = { ...lod.stats };
  assert.deepEqual([part.drawn, part.culled, part.triangles, part.tests], [90, 310, 101, 101]);
  assert.ok(part.tests < 400, 'most of the 310 items out of view were dropped with their node, untested');
  batch.mesh.prepareDeformation(context);
  const dispatched = passes(),
    level = lod.levelOf(0);
  // The same camera and items again: nothing is tested, set or uploaded.
  lod.stats.tests = -1;
  lod.update(engine.camera);
  batch.mesh.prepareDeformation(context);
  assert.equal(lod.stats.tests, -1, 'the update returned before any work');
  assert.equal(passes(), dispatched, 'the batch had nothing to recompute');
  assert.equal(lod.levelOf(0), level);
});

test('items belong to the object that added them: ids, picking, rollback, removal and disposal', async () => {
  const { engine, look } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 5, maxVertices: 32 }),
    own = batch.add(coarse),
    lod = BatchedLOD.attach(engine, batch);
  const a = lod.add([{ geometry: fine }, { geometry: coarse, distance: 10 }], {
    matrix: translate(1, 2, 3),
    color: [0.5, 0.25, 1],
  });
  assert.equal(lod.count, 1);
  assert.equal(batch.count, 3);
  assert.ok(lod.has(a) && !lod.has(own) && !lod.has(a + 1), 'a level is not an item');
  assert.deepEqual(Array.from(lod.getMatrix(a)), translate(1, 2, 3));
  assert.deepEqual(Array.from(batch.getMatrix(a + 1)), translate(1, 2, 3), 'every level carries the matrix');
  assert.deepEqual(Array.from(batch.getColor(a + 1)), [0.5, 0.25, 1], 'and the colour');
  lod.setColor(a, [1, 0, 0]).setMatrix(a, translate(0, 0, 0));
  assert.deepEqual(Array.from(lod.getColor(a)), [1, 0, 0]);
  assert.deepEqual(Array.from(batch.getColor(a + 1)), [1, 0, 0]);
  // Vertices 0 to 2 are the batch's own item; 3 to 6 the fine level, 7 to 9 the coarse one.
  assert.deepEqual([lod.itemOf(0), lod.itemOf(3), lod.itemOf(7), lod.itemOf(20)], [-1, a, a, -1]);
  lod.update(look([0, 0, 4]));
  assert.equal(batch.isVisible(own), true, 'an item added to the batch directly is left alone');
  // The box the culling reads: BatchedMesh.bounds without the allocation.
  const box = new Float64Array(6);
  assert.equal(batch.boundsInto(box, a + 1), box);
  assert.deepEqual(Array.from(box), Array.from(batch.bounds(a + 1)));
  assert.deepEqual(Array.from(batch.boundsInto([], own)), [-1, -1, 0, 1, 1, 0]);
  // The batch has room for two more items, not three: nothing of the refused item stays.
  assert.throws(
    () => lod.add([{ geometry: fine }, { geometry: coarse, distance: 1 }, { geometry: coarse, distance: 2 }]),
    /holds 5 items/,
  );
  assert.equal(batch.count, 3);
  assert.equal(lod.count, 1);
  const tooMany = Array.from({ length: MAX_BATCHED_LEVELS + 1 }, (_, l) => ({ geometry: coarse, distance: l }));
  assert.throws(() => lod.add(tooMany), RangeError);
  assert.throws(() => lod.add([]), RangeError);
  assert.throws(() => lod.add([{ geometry: fine }, null]), TypeError);
  assert.throws(() => lod.add([{ geometry: fine }, { geometry: coarse }]), /distances/);
  assert.throws(() => lod.add([{ geometry: fine, distance: 3 }]), /distances/);
  assert.throws(
    () => lod.add([{ geometry: fine }, { geometry: coarse, distance: 9 }, { geometry: coarse, distance: 8 }]),
    /distances/,
  );
  assert.throws(() => lod.add([{ geometry: fine }, { geometry: coarse, distance: 9, hysteresis: 1 }]), /hysteresis/);
  assert.throws(() => lod.add(coarse, { visible: 1 }), TypeError);
  assert.throws(() => lod.setVisible(a, 1), TypeError);
  assert.throws(() => lod.setMatrix(own, translate(0, 0, 0)), /no item/);
  assert.throws(() => lod.levelOf(7), /no item/);
  assert.equal(batch.count, 3);
  for (const options of [{ margin: -1 }, { hysteresis: 1 }, { bias: 0 }, { bvhItems: -1 }])
    assert.throws(() => BatchedLOD.attach(engine, batch, options), RangeError);
  assert.throws(() => BatchedLOD.attach(engine, batch, { culling: 1 }), TypeError);
  assert.throws(() => BatchedLOD.attach(engine, {}), TypeError);
  lod.remove(a);
  assert.deepEqual([lod.count, batch.count, lod.has(a)], [0, 1, false]);
  const b = lod.add([{ geometry: fine }, { geometry: coarse, distance: 10 }]);
  lod.dispose();
  lod.dispose();
  assert.equal(batch.count, 1, 'disposing takes its items out of the batch and leaves the rest');
  assert.ok(batch.has(own) && !batch.has(b + 1));
  assert.throws(() => lod.add(coarse), { code: 'disposed' });
  assert.equal(engine.sceneOf(lod), undefined);
  // Disposing the batch disposes what culls it.
  const other = BatchedLOD.attach(engine, batch);
  other.add(coarse);
  batch.dispose();
  assert.throws(() => other.add(coarse), { code: 'disposed' });
  assert.equal(engine.sceneOf(other), undefined);
  other.update(engine.camera);
});
