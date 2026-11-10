import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { LodInstances } from '../dist/lod.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const options = (n = 2) => ({
  levels: [
    { geometry: box(), minRadius: 40 },
    { geometry: box(0.5), minRadius: 5 },
  ],
  material: new PbrMaterial(),
  transforms: new Float32Array(Array.from({ length: n }, () => identity).flat()),
});
function harness(vendor) {
  const h = optionalGPU(),
    batches = [];
  if (vendor) h.engine.gpu.adapterInfo = { vendor };
  h.engine.canvas = { clientWidth: 64, width: 64, height: 64 };
  h.engine.retain = (geometry) => batches.push({ geometry, instances: new Float32Array(48), count: 0 });
  h.engine.release = () => {};
  h.context.batches = batches;
  h.context.width = h.context.height = 64;
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  return { ...h, batches, run: () => h.engine.frameGraph.execute(h.context) };
}

test('one compute pass feeds every level: core draws each from its own list and arguments', () => {
  const h = harness(),
    lod = new LodInstances(options());
  h.engine.use(lod);
  h.run();
  assert.equal(h.batches.length, 2);
  const [near, far] = h.batches;
  assert.ok(near.redirect.instances && far.redirect.instances);
  assert.notEqual(near.redirect.instances, far.redirect.instances);
  assert.notEqual(near.redirect.args, far.redirect.args);
  const compute = h.pipelines.filter((p) => p.compute),
    code = compute[0].compute.module.code;
  assert.match(code, /fn pick/);
  assert.match(code, /drawn1\[p\]=records\[i\]/);
  // batch 132: an atomicAdd slot per instance reordered each level's list every frame; test, scan and copy keep
  // instance order (lod-check.mjs reads the lists back and compares redraws).
  assert.doesNotMatch(code, /atomic/);
  assert.deepEqual(
    compute.map((p) => p.compute.entryPoint),
    ['cull', 'scan', 'scatter'],
  );
});

test('the frame writes no records when nothing changed, and one range when one instance moved', () => {
  const h = harness(),
    lod = new LodInstances(options(4));
  h.engine.use(lod);
  h.run();
  const from = h.bufferWrites.length;
  h.run();
  const size = (w) => w.bytes;
  assert.ok(!h.bufferWrites.slice(from).some((w) => size(w) >= 96 * 4), 'no full upload');
  lod.setTransform(2, identity);
  const next = h.bufferWrites.length;
  h.run();
  assert.ok(h.bufferWrites.slice(next).some((w) => w.offset === 2 * 96 && size(w) === 96));
});

test('a limit that does not fall from level to level is refused', () => {
  const o = options();
  o.levels[1].minRadius = 40;
  assert.throws(() => new LodInstances(o), /smaller value/);
  o.levels[0].minRadius = 0;
  o.levels[1].minRadius = 0;
  assert.throws(() => new LodInstances(o), /smaller value/);
  assert.throws(() => new LodInstances({ ...options(), levels: [] }), /1 to 4 levels/);
});

test('matrices are checked as DynamicInstances checks them', () => {
  const lod = new LodInstances(options());
  assert.throws(() => lod.setTransform(5, identity), /Invalid instance index/);
  assert.throws(() => lod.setTransform(0, [...identity.slice(0, 15), 2]), /not affine/);
  assert.throws(() => lod.setTransform(0, [-1, ...identity.slice(1)]), /mirrored/);
  assert.ok(new LodInstances({ ...options(), mirrored: true }).setTransform(0, [-1, ...identity.slice(1)]));
});

test('on the WebGL2 layer every shown instance draws the first level, without compute', () => {
  const h = harness('margo-webgl2'),
    lod = new LodInstances(options(3));
  h.engine.use(lod);
  lod.setVisible(1, false);
  h.run();
  const args = new Uint32Array(h.batches[0].redirect.args.data);
  assert.equal(args[1], 2);
  assert.equal(h.pipelines.filter((p) => p.compute).length, 3, 'compiled, never dispatched');
});

test('a level that cannot be retained releases the levels taken, once each, and the error reaches the caller', () => {
  const h = harness(),
    retained = [],
    released = [];
  h.engine.retain = (geometry) => {
    if (retained.length === 1) throw new RangeError('GPU buffer limit');
    retained.push(geometry);
  };
  h.engine.release = (geometry) => released.push(geometry);
  assert.throws(() => h.engine.use(new LodInstances(options())), /GPU buffer limit/);
  assert.deepEqual(released, retained, 'only what was retained is released');
});
