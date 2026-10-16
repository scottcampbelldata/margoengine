import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../packages/animation/dist/index.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU } from './support/optional-gpu.js';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';

test('upload eligibility reads real typed-array backing stores despite own or subclass buffer getters', async () => {
  // Fake GPU writers deliberately cannot enter the native-only reuse branch.
  // Exercise the actual internal predicate with real typed arrays instead.
  const source = await readFile(new URL('../packages/animation/src/weight-buffer.ts', import.meta.url), 'utf8'),
    emitted = await transformWithOxc(source, 'weight-buffer.ts', { target: 'es2022' }),
    { ordinaryWeightBuffer } = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
  let propertyReads = 0;
  class DisguisedWeights extends Float32Array {
    get buffer() {
      propertyReads++;
      return new ArrayBuffer(4);
    }
  }
  for (const shared of [false, true]) {
    const backing = shared ? new SharedArrayBuffer(4) : new ArrayBuffer(4),
      own = new Float32Array(backing),
      inherited = new DisguisedWeights(backing);
    Object.defineProperty(own, 'buffer', {
      get() {
        propertyReads++;
        return new ArrayBuffer(4);
      },
    });
    assert.equal(ordinaryWeightBuffer(own), !shared);
    assert.equal(ordinaryWeightBuffer(inherited), !shared);
    own[0] = inherited[0] = 0.375;
    assert.equal(ordinaryWeightBuffer(own), !shared, 'eligibility follows the actual backing after edits');
    assert.equal(ordinaryWeightBuffer(inherited), !shared);
  }
  assert.equal(propertyReads, 0, 'eligibility does not invoke caller-owned accessors');
  const ordinary = new Float32Array(1);
  Object.defineProperty(ordinary, 'buffer', { get: () => { throw new Error('not the backing store'); } });
  assert.equal(ordinaryWeightBuffer(ordinary), true);
});

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function fixture(Type = Animation) {
  const h = optionalGPU(),
    doc = animatedTriangle();
  h.engine.store.transforms = Object.fromEntries(
    ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((key) => [
      key,
      new Float32Array(2).fill(['qw', 'sx', 'sy', 'sz'].includes(key) ? 1 : 0),
    ]),
  );
  const nodes = [0, 1].map((id) => ({
    id,
    engine: h.engine,
    matrix: identity(),
    check() {},
    setPosition(v) {
      this.matrix[12] = v[0];
      return this;
    },
    setScale() {
      return this;
    },
    setQuaternion() {
      return this;
    },
  }));
  const primitive = {
    definition: doc.doc.meshes[0].primitives[0],
    nodeIndex: 0,
    node: nodes[0],
    vertices: new Float32Array(60),
    weights: new Float32Array([0]),
  };
  const model = {
    name: 'uploads',
    root: nodes[0],
    nodes,
    primitives: [primitive],
    asset: new GLTFAsset(doc.doc, doc.buffers),
    onDispose() {
      return () => {};
    },
  };
  const animation = new Type(model);
  animation.playing = false;
  h.engine.use(animation);
  const record = animation.resources[0],
    writes = [],
    write = h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer = (buffer, offset, value) => {
    if (!ArrayBuffer.isView(value)) throw new TypeError('GPUBufferSource required');
    writes.push({ buffer, bytes: value.byteLength });
    return write(buffer, offset, value);
  };
  return { ...h, animation, record, nodes, primitive, writes };
}
test('custom writers receive palettes and morph weights on every render while deformation still dispatches', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const output = f.primitive.deformed;
  f.frame();
  assert.equal(f.writes.length, 2);
  for (let i = 0; i < 300; i++) f.frame();
  assert.equal(f.writes.length, 602);
  assert.equal(f.record.bonesUploaded, false);
  assert.equal(f.record.weightsUploaded, false);
  assert.equal(f.counts.compute, 301);
  assert.equal(f.primitive.deformed, output);
});
test('joint, mesh, replacement view and signed-zero weight edits preserve exact GPU inputs through custom writers', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  f.nodes[1].matrix[12] = 0.25;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.writes.length = 0;
  f.nodes[0].matrix[13] = 0.125;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.writes.length = 0;
  f.primitive.weights[0] = -0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
  f.writes.length = 0;
  f.primitive.weights = new Float32Array([-0]);
  f.nodes[1].matrix = new Float32Array(f.nodes[1].matrix);
  f.frame();
  assert.equal(f.writes.length, 2);
  f.writes.length = 0;
  f.primitive.weights[0] = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.writes.length = 0;
  f.primitive.weights[0] = 0.5;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
});
test('palette uploads distinguish signed-zero bit patterns', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.nodes[1].matrix.fill(-0);
  f.frame();
  assert.ok(f.record.paletteBits.some((value) => value === 0x80000000));
  f.writes.length = 0;
  f.nodes[1].matrix.fill(0);
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  assert.deepEqual(new Uint32Array(f.record.bones.data), f.record.paletteBits);
});
test('custom writers receive length-tracking weight views after buffer growth and shrink', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const buffer = new ArrayBuffer(4, { maxByteLength: 16 });
  f.primitive.weights = new Float32Array(buffer);
  f.primitive.weights[0] = 0.25;
  f.frame();
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
  f.writes.length = 0;
  buffer.resize(8);
  f.primitive.weights[1] = 0.5;
  f.frame();
  f.frame();
  assert.equal(f.writes.length, 4);
  buffer.resize(4);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
});
test('empty and detached weight views retain the original no-upload behavior', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  const original = f.primitive.weights;
  structuredClone(original.buffer, { transfer: [original.buffer] });
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones],
  );
  f.writes.length = 0;
  f.primitive.weights = new Float32Array();
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones],
  );
  f.writes.length = 0;
  f.primitive.weights = new Float32Array([0]);
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
});
test('shared-memory weights always upload so concurrent edits cannot invalidate a cached snapshot', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.primitive.weights = new Float32Array(new SharedArrayBuffer(4));
  f.frame();
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.primitive.weights[0] = 0.5;
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.primitive.weights = new Float32Array([0]);
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
});
test('non-finite weights, singular meshes and Float32 palette overflow remain guarded before custom uploads', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  const before = f.counts.compute;
  f.primitive.weights[0] = NaN;
  assert.throws(() => f.frame(), /Invalid morph weights/);
  assert.equal(f.counts.compute, before);
  assert.equal(f.writes.length, 0);
  f.primitive.weights[0] = 0;
  f.nodes[0].matrix.fill(0);
  assert.throws(() => f.frame(), /Singular skinned mesh transform/);
  assert.equal(f.counts.compute, before);
  assert.equal(f.writes.length, 0);
  f.nodes[0].matrix.set(identity());
  f.nodes[1].matrix[0] = 3e38;
  f.record.inverseBind[0][0] = 2;
  assert.throws(() => f.frame(), /Skin matrix overflow/);
  assert.equal(f.counts.compute, before);
  assert.equal(f.writes.length, 0);
  f.nodes[1].matrix[0] = 1;
  f.record.inverseBind[0][0] = 1;
  f.frame();
  assert.equal(f.counts.compute, before + 1);
  assert.equal(f.writes.length, 2);
});
test('failed custom uploads retry without suppressing the dispatch', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  const original = f.engine.gpu.queue.writeBuffer;
  for (const [buffer, edit] of [
    [
      f.record.bones,
      () => {
        f.nodes[1].matrix[12] += 0.1;
      },
    ],
    [
      f.record.weights,
      () => {
        f.primitive.weights[0] += 0.1;
      },
    ],
  ]) {
    edit();
    const before = f.counts.compute;
    f.engine.gpu.queue.writeBuffer = (target, offset, value) => {
      if (target === buffer) throw new Error('upload failed');
      return original(target, offset, value);
    };
    assert.throws(() => f.frame(), /upload failed/);
    assert.equal(f.counts.compute, before);
    f.engine.gpu.queue.writeBuffer = original;
    f.writes.length = 0;
    f.frame();
    assert.ok(f.writes.some((w) => w.buffer === buffer));
    assert.equal(f.counts.compute, before + 1);
    f.writes.length = 0;
    f.frame();
    assert.equal(f.writes.length, 2);
  }
});
test('changed weight types and lengths preserve the original custom upload path', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  for (const values of [new Float32Array([0.25, 0.5]), new Float64Array([0.75])]) {
    f.primitive.weights = values;
    f.frame();
    f.frame();
    assert.deepEqual(
      f.writes.map((w) => w.buffer),
      [f.record.bones, f.record.weights, f.record.bones, f.record.weights],
    );
    f.writes.length = 0;
  }
  f.primitive.weights = [0.5];
  assert.throws(() => f.frame(), TypeError);
  f.primitive.weights = new Float32Array([0]);
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones, f.record.weights],
  );
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
});
test('device restoration creates fresh upload state and disposal releases the shared output', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  const old = f.primitive.deformed,
    resources = f.resources.slice();
  f.animation.onDeviceRestored(f.engine);
  assert.ok(resources.every((r) => r.destroyed));
  assert.notEqual(f.primitive.deformed, old);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
  f.animation.dispose();
  assert.equal(f.primitive.deformed, undefined);
  assert.ok(f.resources.every((r) => r.destroyed));
});
test('custom uploads and deformation both execute again after a later graph pass throws', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.nodes[1].matrix[12] = 0.4;
  f.writes.length = 0;
  const remove = f.engine.frameGraph.add({
      name: 'later-failure',
      order: -5,
      execute() {
        throw new Error('later pass');
      },
    }),
    before = f.counts.compute;
  assert.throws(() => f.frame(), /later pass/);
  assert.equal(f.counts.compute, before + 1);
  assert.equal(f.writes.length, 2);
  remove();
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
  assert.equal(f.counts.compute, before + 2);
});
test('moving and held poses always leave GPU input bytes equal to the current palette and morph weights', (t) => {
  const b = fixture();
  t.after(() => b.animation.dispose());
  for (let i = 0; i < 1000; i++) {
    if (i % 7 === 0) {
      b.nodes[1].matrix[12] = Math.sin(i * 0.17) * 0.25;
      b.nodes[1].matrix[0] = Math.cos(i * 0.11) * 0.1 + 1;
    }
    if (i % 11 === 0) b.nodes[0].matrix[13] = Math.sin(i * 0.03) * 0.12;
    if (i % 5 === 0) b.primitive.weights[0] = Math.sin(i * 0.05) * 0.5;
    if (i % 101 === 0) b.nodes[1].matrix = new Float32Array(b.nodes[1].matrix);
    if (i % 103 === 0) b.primitive.weights = new Float32Array(b.primitive.weights);
    b.frame();
    assert.deepEqual(new Uint8Array(b.record.bones.data), new Uint8Array(b.record.palette.buffer));
    assert.deepEqual(new Float32Array(b.record.weights.data)[0], b.primitive.weights[0]);
  }
  assert.equal(b.counts.compute, 1000);
  assert.equal(b.writes.length, 2000);
});

test('custom queue writers always run and temporary input mutation cannot certify stale GPU bytes', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const queue = f.engine.gpu.queue,
    write = queue.writeBuffer;
  let mutate = true;
  queue.writeBuffer = function (buffer, offset, values) {
    assert.equal(this, queue);
    const original = values[0];
    if (mutate) values[0] = 0.375;
    const result = write.call(this, buffer, offset, values);
    values[0] = original;
    if (buffer === f.record.weights) mutate = false;
    return result;
  };
  f.frame();
  assert.equal(new Float32Array(f.record.bones.data)[0], 0.375);
  assert.equal(new Float32Array(f.record.weights.data)[0], 0.375);
  f.frame();
  assert.equal(f.writes.length, 4);
  assert.deepEqual(new Uint8Array(f.record.bones.data), new Uint8Array(f.record.palette.buffer));
  assert.equal(new Float32Array(f.record.weights.data)[0], f.primitive.weights[0]);
});

test('queue and writer replacements remain observable on otherwise identical animation frames', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  const queue = f.engine.gpu.queue,
    write = queue.writeBuffer;
  let writerCalls = 0,
    queueCalls = 0;
  queue.writeBuffer = function (...args) {
    assert.equal(this, queue);
    writerCalls++;
    return write.apply(this, args);
  };
  f.frame();
  assert.equal(writerCalls, 2);
  const replacement = { ...queue };
  replacement.writeBuffer = function (...args) {
    assert.equal(this, replacement);
    queueCalls++;
    return write.apply(queue, args);
  };
  f.engine.gpu.queue = replacement;
  f.frame();
  assert.equal(queueCalls, 2);
  f.frame();
  assert.equal(queueCalls, 4);
});

test('post-copy custom morph edits are uploaded again instead of being stored as already queued', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const write = f.engine.gpu.queue.writeBuffer;
  let mutate = true;
  f.engine.gpu.queue.writeBuffer = function (buffer, offset, values) {
    const result = write.call(this, buffer, offset, values);
    if (buffer === f.record.weights && mutate) {
      values[0] = 0.5;
      mutate = false;
    }
    return result;
  };
  f.frame();
  assert.equal(new Float32Array(f.record.weights.data)[0], 0);
  assert.equal(f.primitive.weights[0], 0.5);
  f.frame();
  assert.equal(new Float32Array(f.record.weights.data)[0], 0.5);
});

test('custom writers keep direct-call semantics even when their call property is overridden', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const write = f.engine.gpu.queue.writeBuffer;
  const writer = function (buffer, offset, values) {
    return Reflect.apply(write, this, [buffer, offset, values]);
  };
  writer.call = () => assert.fail('writeBuffer.call is not the upload operation');
  f.engine.gpu.queue.writeBuffer = writer;
  f.frame();
  f.frame();
  assert.equal(f.writes.length, 4);
});

test('custom queue accessors and reentrant hooks retain every upload and cannot publish a reusable cache', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const queue = f.engine.gpu.queue,
    write = queue.writeBuffer,
    inner = new f.engine.frameGraph.constructor();
  f.animation.registerPasses(inner);
  let nested = false,
    reenter = true,
    reads = 0;
  const writer = function (...args) {
    const result = Reflect.apply(write, this, args);
    if (reenter && !nested) {
      nested = true;
      reenter = false;
      inner.execute(f.context);
      nested = false;
    }
    return result;
  };
  Object.defineProperty(queue, 'writeBuffer', {
    configurable: true,
    get() {
      reads++;
      return writer;
    },
  });
  f.frame();
  f.frame();
  assert.equal(f.writes.length, 6);
  assert.equal(reads, 6, 'read the queue method once per upload');
  assert.equal(f.counts.compute, 3);
  assert.equal(f.record.bonesUploaded, false);
  assert.equal(f.record.weightsUploaded, false);
});

test('a JavaScript GPUQueue installed before import is not trusted by a spoofed own toString', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'GPUQueue'),
    writes = [];
  class CustomQueue {
    writeBuffer(buffer, offset, values) {
      writes.push(buffer);
      new Uint8Array(buffer.data).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), offset);
    }
  }
  CustomQueue.prototype.writeBuffer.toString = () => 'function writeBuffer() { [native code] }';
  Object.defineProperty(globalThis, 'GPUQueue', { configurable: true, value: CustomQueue });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'GPUQueue', descriptor);
    else delete globalThis.GPUQueue;
  });
  const { Animation: Imported } = await import('../packages/animation/dist/index.js?custom-preimport-queue'),
    f = fixture(Imported);
  t.after(() => f.animation.dispose());
  Object.setPrototypeOf(f.engine.gpu.queue, CustomQueue.prototype);
  delete f.engine.gpu.queue.writeBuffer;
  f.frame();
  f.frame();
  assert.deepEqual(writes, [f.record.bones, f.record.weights, f.record.bones, f.record.weights]);
  assert.equal(f.record.bonesUploaded, false);
  assert.equal(f.record.weightsUploaded, false);
});
