import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { DynamicInstances } from '../dist/dynamic.js';
import { dynamicRoute } from '../src/compat.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const translate = (x, y, z, s = 1) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1];
function harness() {
  const h = optionalGPU(),
    batches = [],
    released = [];
  h.engine.canvas = { clientWidth: 64, width: 64, height: 64 };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  // Core's batch for a retained geometry: count 0 (no mesh draws it), as Engine.retain makes it.
  h.engine.retain = (geometry) => batches.push({ geometry, instances: new Float32Array(48), count: 0 });
  h.engine.release = (geometry) => released.push(geometry);
  h.engine.geometryBuffers = () => ({ vertex: { label: 'vertex' }, index: { label: 'index' } });
  h.context.batches = batches;
  h.context.width = h.context.height = 64;
  const writes = h.bufferWrites;
  return {
    ...h,
    batches,
    released,
    run(frames = 1) {
      for (let i = 0; i < frames; i++) h.engine.frameGraph.execute(h.context);
    },
    /** Buffer writes into `buffer` since index `from`, as [byte offset, bytes]. */
    writesTo(buffer, from = 0) {
      return writes
        .slice(from)
        .filter((w) => w.buffer === buffer)
        .map((w) => [w.offset, w.bytes]);
    },
  };
}
const make = (options) =>
  new DynamicInstances({
    geometry: box(),
    material: new PbrMaterial({ color: '#808080', doubleSided: false }),
    capacity: 1024,
    ...options,
  });

test('draws its instances through core: own batch redirected to GPU-compacted records and indirect arguments', () => {
  const h = harness(),
    geometry = box(),
    material = new PbrMaterial({ color: '#ff0000', roughness: 0.4, metalness: 0.2, doubleSided: false }),
    crowd = DynamicInstances.attach(h.engine, { geometry, material, capacity: 1000 });
  assert.equal(h.batches.length, 1, 'retains one batch');
  assert.notEqual(h.batches[0].geometry, geometry, 'its own batch: core meshes of the geometry keep theirs');
  assert.equal(h.batches[0].geometry.indices, geometry.indices, 'sharing the geometry arrays');
  for (let i = 0; i < 3; i++) crowd.addInstance(translate(i, 0, 0));
  crowd.setColorAt(1, [0.5, 1, 0]);
  h.run();
  const b = crowd['buffers'],
    batch = h.batches[0];
  assert.equal(batch.redirect.instances, b.drawn);
  assert.equal(batch.redirect.args, b.args);
  assert.equal(batch.mask, 0, 'single-sided, no mirrors: core draws it back-face culled');
  assert.equal(b.drawn.usage, 128 | 32 | 8);
  assert.equal(b.args.usage, 128 | 256 | 4 | 8);
  assert.equal(b.drawn.size, 1000 * 96);
  assert.deepEqual(
    h.pipelines.filter((p) => p.compute).map((p) => p.compute.entryPoint),
    ['cull', 'scan', 'scatter', 'fill'],
  );
  const code = h.pipelines.find((p) => p.compute).compute.module.code;
  assert.match(code, /drawn\[p\]=record\(i\)/, 'order-keeping compaction, kept rows only');
  assert.match(code, /rows\[i\]\.w==1u/, 'only shown rows');
  assert.equal(code.match(/world\[i\]=/g).length, 1, 'only `fill` writes every row');
  assert.match(code, /finite\(matrices\[k\+j\]\)/, 'non-finite rows draw nothing');
  // Rows: 12 floats of affine columns, attributes rgb tint + state word.
  assert.deepEqual(Array.from(new Float32Array(b.matrices.data, 48, 12)), [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]);
  assert.deepEqual(Array.from(new Float32Array(b.rows.data, 16, 3)), [0.5, 1, 0]);
  assert.deepEqual(
    Array.from(new Uint32Array(b.rows.data, 0, 16)).filter((_, i) => i % 4 === 3),
    [1, 1, 1, 0],
  );
  const words = new Uint32Array(b.part.data),
    floats = new Float32Array(b.part.data);
  assert.deepEqual([words[0], words[1]], [3, geometry.indices.length], 'kernels visit the rows up to the highest');
  assert.deepEqual(Array.from(floats.subarray(4, 8)), Array.from(geometry.bounds));
  assert.deepEqual(Array.from(floats.subarray(8, 12)), [Math.fround(0.4), Math.fround(0.2), 0, 16777216]);
  assert.deepEqual(Array.from(floats.subarray(12, 16)), [...material.data.subarray(0, 3), 1]);
  assert.equal(crowd.count, 3);
  assert.equal(crowd.transforms, b.matrices);
  crowd.dispose();
});

test('a steady frame writes only its two uniforms and creates nothing, however many instances there are', () => {
  const h = harness(),
    crowd = make({ capacity: 100_000 });
  h.engine.use(crowd);
  for (let i = 0; i < 100_000; i++) crowd.addInstance();
  h.run();
  const created = { ...h.counts },
    before = h.bufferWrites.length;
  h.run(20);
  assert.equal(h.counts.buffers, created.buffers, 'no per-frame buffers');
  assert.equal(h.counts.groups, created.groups, 'no per-frame bind groups');
  assert.equal(h.bufferWrites.length - before, 40, 'frame and part uniforms only');
  crowd.dispose();
});

test('uploads only the blocks of 256 rows that changed, one write per run of blocks', () => {
  const h = harness(),
    crowd = make();
  h.engine.use(crowd);
  for (let i = 0; i < 1024; i++) crowd.addInstance();
  h.run();
  const b = crowd['buffers'];
  assert.deepEqual(h.writesTo(b.matrices), [[0, 1024 * 48]], 'first frame uploads every row once');
  let at = h.bufferWrites.length;
  crowd.setMatrixAt(3, translate(1, 2, 3)).setMatrixAt(700, translate(4, 5, 6));
  h.run();
  assert.deepEqual(h.writesTo(b.matrices, at), [
    [0, 256 * 48],
    [512 * 48, 256 * 48],
  ]);
  assert.deepEqual(h.writesTo(b.rows, at), [], 'attributes untouched');
  assert.deepEqual(Array.from(new Float32Array(b.matrices.data, 700 * 48 + 36, 3)), [4, 5, 6]);
  at = h.bufferWrites.length;
  crowd.matrices[300 * 12 + 9] = 7;
  crowd.update(256, 600);
  h.run();
  assert.deepEqual(h.writesTo(b.matrices, at), [[256 * 48, 512 * 48]], 'a bulk range: one write');
  assert.equal(new Float32Array(b.matrices.data)[300 * 12 + 9], 7);
  at = h.bufferWrites.length;
  crowd.setVisibleAt(5, false);
  h.run();
  assert.deepEqual(h.writesTo(b.rows, at), [[0, 256 * 16]]);
  assert.equal(new Uint32Array(b.rows.data)[5 * 4 + 3], 2, 'hidden state');
  crowd.dispose();
});

test('add, delete and visibility: indices are reused, the high row stays, deleted rows are free', () => {
  const h = harness(),
    crowd = make({ capacity: 4 });
  h.engine.use(crowd);
  const ids = [0, 1, 2].map(() => crowd.addInstance());
  assert.deepEqual(ids, [0, 1, 2]);
  crowd.deleteInstance(1);
  assert.equal(crowd.count, 2);
  assert.throws(() => crowd.setMatrixAt(1, translate(0, 0, 0)), /Instance 1 is not alive/);
  assert.equal(crowd.addInstance(), 1, 'a deleted index is reused');
  assert.equal(crowd.addInstance(), 3);
  assert.throws(
    () => crowd.addInstance(),
    (e) => e instanceof RangeError && /all 4 are alive/.test(e.message),
  );
  crowd.setVisibleAt(2, false);
  assert.equal(crowd.getVisibleAt(2), false);
  assert.equal(crowd.getVisibleAt(0), true);
  h.run();
  const words = new Uint32Array(crowd['buffers'].rows.data);
  assert.deepEqual(
    [3, 7, 11, 15].map((i) => words[i]),
    [1, 1, 2, 1],
  );
  crowd.deleteInstance(0);
  h.run();
  assert.equal(words[3], 0, 'a deleted row is free on the GPU');
  assert.equal(new Uint32Array(crowd['buffers'].part.data)[0], 4, 'kernels still visit up to the high row');
  assert.deepEqual(Array.from(crowd.getMatrixAt(3)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  crowd.dispose();
});

test('rejects bad options, matrices, colours and indices with errors that name the fix', () => {
  const geometry = box(),
    material = new PbrMaterial();
  assert.throws(() => new DynamicInstances({ geometry, material, capacity: 0 }), RangeError);
  assert.throws(() => new DynamicInstances({ geometry, material, capacity: 1.5 }), /whole number/);
  assert.throws(() => new DynamicInstances({ geometry: {}, material, capacity: 1 }), TypeError);
  assert.throws(() => new DynamicInstances({ geometry, material: {}, capacity: 1 }), TypeError);
  assert.throws(() => new DynamicInstances({ geometry, material, capacity: 1, minRadius: -1 }), /minRadius/);
  const crowd = new DynamicInstances({ geometry, material, capacity: 8 }),
    id = crowd.addInstance();
  assert.throws(() => crowd.setMatrixAt(id, [1, 2, 3]), TypeError);
  assert.throws(() => crowd.setMatrixAt(id, translate(Number.NaN, 0, 0)), /not finite/);
  const projective = translate(0, 0, 0);
  projective[3] = 1;
  assert.throws(() => crowd.setMatrixAt(id, projective), /not affine/);
  assert.throws(() => crowd.setMatrixAt(id, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), /mirrored: true/);
  const mirrored = new DynamicInstances({ geometry, material, capacity: 1, mirrored: true });
  mirrored.setMatrixAt(mirrored.addInstance(), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.throws(() => crowd.setColorAt(id, [2, 0, 0]), /0 to 1/);
  assert.throws(() => crowd.setColorAt(id, [1, 0]), TypeError);
  assert.throws(() => crowd.deleteInstance(5), /not alive/);
  assert.throws(() => crowd.update(0, 9), /from <= to <= 8/);
  const h = harness();
  h.engine.gpu = null;
  assert.throws(
    () => h.engine.use(new DynamicInstances({ geometry, material, capacity: 1 })),
    (e) => e.code === 'unsupported',
  );
  const small = harness();
  small.engine.gpu.limits.maxStorageBufferBindingSize = 960;
  assert.throws(
    () => small.engine.use(new DynamicInstances({ geometry, material, capacity: 11 })),
    /binds at most 960/,
  );
});

test('double-sided materials and mirrored instances draw with back faces', () => {
  const h = harness(),
    crowd = make({ material: new PbrMaterial({ doubleSided: true }) });
  h.engine.use(crowd);
  crowd.addInstance();
  h.run();
  assert.equal(h.batches[0].mask, 1);
  crowd.dispose();
  const m = harness(),
    mirrored = make({ mirrored: true });
  m.engine.use(mirrored);
  m.run();
  assert.equal(m.batches[0].mask, 1);
});

test('casts shadows from every live row through drawShadow, and readCount reads the drawn count', async () => {
  const h = harness(),
    crowd = make();
  h.engine.use(crowd);
  crowd.addInstance();
  crowd.addInstance();
  const calls = [],
    pass = {
      setPipeline() {},
      setBindGroup() {},
      setIndexBuffer() {},
      setVertexBuffer: (slot, buffer) => calls.push(['vertex', slot, buffer]),
      drawIndexed: (indices, count) => calls.push(['draw', indices, count]),
    };
  crowd.drawShadow({ context: h.context, pass, matrix: new Float32Array(16), cascade: 0 });
  assert.deepEqual(calls, [], 'nothing before the first frame');
  h.run();
  crowd.drawShadow({ context: h.context, pass, matrix: new Float32Array(16), cascade: 2 });
  assert.deepEqual(calls.at(-1), ['draw', box().indices.length, 2]);
  assert.equal(calls.find((c) => c[1] === 1)[2], crowd['buffers'].world, 'every row, not the camera-culled list');
  const pipeline = h.pipelines.find((p) => p.depthStencil?.format === 'depth32float');
  assert.equal(pipeline.depthStencil.depthCompare, 'less-equal');
  new Uint32Array(crowd['buffers'].args.data)[1] = 2;
  assert.equal(await crowd.readCount(), 2);
  crowd.dispose();
});

test('dispose restores core draws, releases its batch and buffers, and is idempotent', () => {
  const h = harness(),
    crowd = make();
  h.engine.use(crowd);
  crowd.addInstance();
  h.run();
  crowd.dispose();
  crowd.dispose();
  assert.equal(h.batches[0].redirect, undefined);
  assert.deepEqual(h.released, [h.batches[0].geometry]);
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(
    () => h.engine.use(crowd),
    (e) => e.code === 'disposed' || e instanceof TypeError,
  );
});

test('the WebGL2 layer route culls on the CPU: kept rows in order, every live row in world, the count in args', () => {
  const route = dynamicRoute(4),
    matrices = new Float32Array(48),
    attributes = new ArrayBuffer(64),
    tints = new Float32Array(attributes),
    states = new Uint32Array(attributes);
  // Rows: 0 in view, 1 behind the near plane's opposite (outside), 2 hidden, 3 non-finite.
  const rows = [translate(0, 0, 0), translate(100, 0, 0), translate(0, 0, 0), translate(Number.NaN, 0, 0)];
  rows.forEach((m, i) => {
    [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].forEach((k, j) => (matrices[i * 12 + j] = m[k]));
    tints.set([1, 0.5, 0.25], i * 4);
    states[i * 4 + 3] = i === 2 ? 2 : 1;
  });
  const frame = new Float32Array(44);
  frame.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  // One plane x <= 10 (inside where -x + 10 >= 0); the rest accept everything.
  frame.set([-1, 0, 0, 10], 16);
  for (let p = 1; p < 6; p++) frame.set([0, 0, 0, 1], 16 + p * 4);
  const part = new Float32Array(16);
  part.set([0.8, 0.2, 0, 16777216], 8);
  part.set([1, 1, 1, 1], 12);
  const writes = new Map(),
    device = {
      queue: {
        writeBuffer: (buffer, offset, data, start = 0, size = data.length) =>
          writes.set(buffer, Array.from(data.subarray(start, start + size))),
      },
    },
    buffers = { world: 'world', drawn: 'drawn', args: 'args' };
  route(device, 4, matrices, tints, buffers, frame, part, new Float32Array([0, 0, 0, 0.5]), 36);
  assert.deepEqual(writes.get('args'), [36, 1, 0, 0, 0]);
  const drawn = writes.get('drawn');
  assert.equal(drawn.length, 24);
  assert.deepEqual(drawn.slice(16, 24), [1, 0.5, 0.25, 1, 0.800000011920929, 0.20000000298023224, 0, 16777216]);
  const world = writes.get('world');
  assert.equal(world.length, 96);
  assert.equal(world[24 + 12], 100, 'outside the view, still in world (it casts shadows)');
  assert.ok(
    world.slice(48, 96).every((v) => v === 0),
    'hidden and non-finite rows are zero',
  );
});

test('`world` is built only for what reads it: once per cull, on the shadow pass encoder', () => {
  const h = harness(),
    crowd = make();
  h.engine.use(crowd);
  crowd.addInstance();
  h.run();
  const encoder = h.context.encoder,
    begin = encoder.beginComputePass;
  let passes = 0;
  encoder.beginComputePass = function (...args) {
    passes++;
    return begin.apply(this, args);
  };
  crowd.prepareShadow({ context: h.context });
  crowd.prepareShadow({ context: h.context });
  assert.equal(passes, 1, 'one fill however many sources ask');
  h.run();
  assert.equal(passes, 2, 'the frame runs its cull and builds no `world`');
  crowd.prepareShadow({ context: h.context });
  assert.equal(passes, 3, 'each cull needs its own fill');
});
