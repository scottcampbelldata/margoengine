import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../dist/index.js';
import { GLTFAsset } from '../../gltf-pro/dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function harness() {
  const h = optionalGPU(),
    fixture = animatedTriangle(),
    asset = new GLTFAsset(fixture.doc, fixture.buffers);
  h.engine.store.transforms = Object.fromEntries(
    ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((name) => [
      name,
      new Float32Array(2).fill(['qw', 'sx', 'sy', 'sz'].includes(name) ? 1 : 0),
    ]),
  );
  let serial = 0;
  const make = (shared) => {
    const k = serial++,
      nodes = [0, 1].map((id) => ({
        id,
        engine: h.engine,
        matrix: identity(),
        check() {},
        setPosition() {
          return this;
        },
        position: { set() {} },
        scale: { set() {} },
        setScale() {
          return this;
        },
        setQuaternion() {
          return this;
        },
      })),
      vertices = shared ?? Float32Array.from({ length: 60 }, (_, i) => k * 1000 + i);
    const animation = new Animation({
      name: 'model ' + k,
      root: nodes[0],
      nodes,
      primitives: [
        {
          definition: fixture.doc.meshes[0].primitives[0],
          nodeIndex: 0,
          node: nodes[0],
          vertices,
          weights: new Float32Array([k / 8]),
        },
      ],
      asset,
      onDispose() {
        return () => {};
      },
    });
    h.engine.use(animation);
    return animation;
  };
  return { ...h, make, asset };
}
const output = (p) => new Float32Array(p.deformed.data, p.deformedOffset, p.vertices.length);

test('primitives of many models share buffers on 256-byte offsets through growth, holes and compaction', async () => {
  const h = harness(),
    animations = [];
  try {
    for (let i = 0; i < 5; i++) animations.push(h.make());
    const check = () => {
      const primitives = animations.flatMap((a) => a.model.primitives);
      assert.equal(new Set(primitives.map((p) => p.deformed)).size, 1, 'one shared output buffer');
      const ranges = primitives
        .map((p) => [p.deformedOffset, p.deformedOffset + p.vertices.byteLength])
        .sort((a, b) => a[0] - b[0]);
      for (const [start] of ranges) assert.equal(start % 256, 0);
      for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] >= ranges[i - 1][1], 'outputs do not overlap');
      for (const a of animations) {
        const r = a.resources[0],
          weights = new Float32Array(r.weights.data, r.slot.weights.offset * 4, 1);
        assert.equal(weights[0], a.model.primitives[0].weights[0], a.name + ' weights at its own offset');
      }
    };
    h.frame();
    // Outputs start as the bind pose, moved intact by every growth (a fake dispatch writes nothing).
    for (const a of animations) assert.deepEqual(output(a.model.primitives[0]), a.model.primitives[0].vertices);
    check();
    animations.splice(1, 1)[0].dispose();
    h.frame();
    check();
    for (let i = 0; i < 9; i++) animations.push(h.make());
    h.frame();
    check();
    for (const a of animations) assert.deepEqual(output(a.model.primitives[0]), a.model.primitives[0].vertices);
    // One shared copy of the morph deltas and skin influences for every model of the same asset primitive.
    assert.equal(new Set(animations.map((a) => a.resources[0].slot.morphs)).size, 1);
    assert.equal(new Set(animations.map((a) => a.resources[0].slot.influences)).size, 1);
    assert.equal(animations[0].resources[0].slot.morphs.refs, animations.length);
  } finally {
    for (const a of animations) a.dispose();
  }
  assert.ok(animations.every((a) => a.model.primitives[0].deformed === undefined));
  // Buffers a growth replaced are destroyed once the work submitted before it is done.
  await h.engine.gpu.queue.onSubmittedWorkDone();
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'the last model releases every shared buffer',
  );
});

test('copies of one packed array upload its vertices once, and the last holder frees them', async () => {
  const h = harness(),
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer,
    vertices = Float32Array.from({ length: 60 }, (_, i) => i + 0.5);
  let uploads = 0;
  queue.writeBuffer = function (buffer, offset, data, ...rest) {
    if (data.buffer === vertices.buffer) uploads++;
    return write.call(this, buffer, offset, data, ...rest);
  };
  const animations = [];
  try {
    for (let i = 0; i < 100; i++) animations.push(h.make(vertices));
    const other = h.make();
    h.frame();
    const slots = animations.map((a) => a.resources[0].slot);
    assert.equal(uploads, 1, 'a hundred copies, one upload of the bind pose');
    assert.equal(new Set(slots.map((s) => s.source)).size, 1, 'one shared source block');
    assert.equal(slots[0].source.refs, 100);
    assert.notEqual(other.resources[0].slot.source, slots[0].source, 'other vertices keep their own block');
    assert.equal(new Set(slots.map((s) => s.output)).size, 100, 'each copy deforms into its own output');
    for (const a of animations) assert.deepEqual(output(a.model.primitives[0]), vertices, 'outputs start at bind pose');
    // The block outlives its first holder, moves with a compaction, and goes with its last holder.
    animations.shift().dispose();
    for (let i = 0; i < 40; i++) animations.push(h.make(vertices));
    h.frame();
    const page = slots[1].page,
      block = animations[0].resources[0].slot.source,
      info = new Uint32Array(page.info.buffer.data);
    assert.equal(uploads, 1, 'still one upload after growth');
    assert.equal(info[animations[0].resources[0].slot.index * 12], block.range.offset, 'the slot record reads the block');
    assert.deepEqual(
      new Float32Array(page.source.buffer.data, block.range.offset * 80, vertices.length),
      vertices,
      'the block holds the vertices',
    );
    for (const a of animations.splice(0)) a.dispose();
    assert.equal(page.source.ranges.size, 1, 'only the other model is left in the pool');
    assert.equal(page.blocks.get(h.asset).has(vertices), false, 'the page lets go of the array with the last copy');
    other.dispose();
    assert.equal(page.blocks.size, 0, 'the emptied page holds no asset');
  } finally {
    queue.writeBuffer = write;
    for (const a of animations) a.dispose();
  }
});

test('morph weights longer than the primitive region are refused before they reach a neighbour', () => {
  const h = harness(),
    a = h.make(),
    b = h.make();
  try {
    h.frame();
    a.model.primitives[0].weights = new Float32Array(5);
    assert.throws(() => h.frame(), /Morph weights longer than the primitive has morph targets/);
    const r = b.resources[0];
    assert.equal(new Float32Array(r.weights.data, r.slot.weights.offset * 4, 1)[0], b.model.primitives[0].weights[0]);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('a dispatch that fails to build leaves no half-built cache: the next frame builds and dispatches it', () => {
  const h = harness(),
    a = h.make(),
    create = h.engine.gpu.createBindGroup;
  let dispatched = 0;
  h.context.encoder.beginComputePass = () => ({
    setPipeline() {},
    setBindGroup() {},
    dispatchWorkgroups() {
      dispatched++;
    },
    end() {},
  });
  try {
    h.engine.gpu.createBindGroup = () => {
      throw new Error('Injected bind group');
    };
    assert.throws(() => h.frame(), /Injected bind group/);
    h.engine.gpu.createBindGroup = create;
    h.frame();
    assert.equal(dispatched, 1);
  } finally {
    a.dispose();
  }
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'the failed attempt destroyed its work list',
  );
});
