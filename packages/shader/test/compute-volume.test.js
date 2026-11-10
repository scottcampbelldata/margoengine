import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputePass, storage, uvec3, vec3, vec4, texture3D, NodeMaterial, If } from '../dist/index.js';
import { ComputeVolume, storageVolume } from '../dist/compute-volume.js';

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_SRC: 1, COPY_DST: 2 };
const device = () => {
  let lose;
  const made = [],
    writes = [];
  return {
    made,
    writes,
    lose: () => lose({}),
    lost: new Promise((r) => {
      lose = r;
    }),
    limits: { maxTextureDimension3D: 32, maxTextureDimension2D: 64, maxTextureArrayLayers: 16 },
    features: new Set(),
    createTexture(d) {
      const t = {
        ...d,
        destroyed: false,
        createView: (v) => ({ t, ...v }),
        destroy() {
          t.destroyed = true;
        },
      };
      made.push(t);
      return t;
    },
    createSampler: (s) => s,
    queue: { writeTexture: (...a) => writes.push(a) },
  };
};
test('3d and array stores, loads and linear indexing compile with distinct dimensional signatures', () => {
  for (const dimension of ['3d', '2d-array']) {
    const t = storageVolume(4, 3, 2, { dimension, format: 'rgba8uint' });
    assert.ok(t instanceof ComputeVolume);
    const write = new ComputePass(t.pixels, (i) => t.store(t.coord(i), i));
    const out = storage(t.pixels, 'vec4u');
    const read = new ComputePass(t.pixels, (i) => out.store(i, t.load(t.coord(i))));
    assert.equal(t.pixels, 24);
    assert.match(write.code, new RegExp(`texture_storage_${dimension.replace('-', '_')}<rgba8uint, write>`));
    assert.match(write.code, /gid.x \/ 12u/);
    assert.match(read.code, /textureLoad\(/);
    if (dimension === '2d-array') assert.match(write.code, /\.xy, i32\(.*\.z\)/);
  }
});
test('ping pong binds separate images, swaps once per dispatch and is independent per device', () => {
  const t = storageVolume(2, 3, 4, { pingPong: true, data: new Uint8Array(192) }),
    a = device(),
    b = device();
  const pass = new ComputePass(t.pixels, (i) => {
    const at = t.coord(i);
    If(i.equal(0), () => t.store(at, t.load(at).add(1)));
  });
  const resources = pass.program.resources;
  const writer = resources.find((r) => r.resource.prefix === 'ndw').resource;
  const reader = resources.find((r) => r.resource.prefix === 'ndr').resource;
  const before = t.texture(a),
    other = t.texture(b);
  assert.notEqual(reader.entries(a)[0], writer.entries(a)[0]);
  writer.finish();
  assert.notEqual(t.texture(a), before);
  assert.equal(t.texture(b), other);
  assert.equal(a.made.length, 2);
  assert.equal(a.writes.length, 2);
  assert.deepEqual(a.writes[0][2], { bytesPerRow: 16, rowsPerImage: 3 });
  assert.deepEqual(a.writes[0][3], [2, 3, 4]);
  assert.equal(a.made[0].dimension, '3d');
  const old = t.texture(a);
  t.dispose();
  assert.equal(old.destroyed, true);
  assert.notEqual(t.texture(a), old);
});
test('array allocation uses 2d storage and an explicit array view, depth limits differ from volumes', () => {
  const d = device(),
    t = storageVolume(2, 3, 4, { dimension: '2d-array' });
  assert.equal(t.bind(d)[0].dimension, '2d-array');
  assert.equal(d.made[0].dimension, '2d');
  assert.throws(() => storageVolume(2, 3, 17, { dimension: '2d-array' }).texture(d), /reduce its dimensions/);
  assert.ok(storageVolume(2, 3, 17).texture(d));
});
test('device loss resets images to CPU data and float volumes sample in NodeMaterial', async () => {
  const d = device(),
    t = storageVolume(1, 1, 1),
    before = t.texture(d);
  d.lose();
  await new Promise((r) => setImmediate(r));
  assert.notEqual(t.texture(d), before);
  assert.match(new NodeMaterial({ colorNode: texture3D(t, vec3(0.5)).rgb }).fragmentCode, /textureSample/);
  assert.throws(() => storageVolume(1, 1, 1, { format: 'rgba8uint' }).bind(d), /Use load/);
});
test('invalid dimensions, formats, aliasing and misplaced writes fail before submission', () => {
  for (const dims of [
    [0, 1, 1],
    [1, 2.5, 1],
    [1, 1, NaN],
    [65536, 65536, 1],
  ])
    assert.throws(() => storageVolume(...dims), /positive integer/);
  assert.throws(() => storageVolume(1, 1, 1, { format: 'constructor' }), /supported storage/);
  assert.throws(() => storageVolume(1, 1, 1, { data: new Uint8Array(1) }), /8 bytes/);
  assert.throws(() => storageVolume(1, 1, 1, { dimension: 'cube' }), /dimension/);
  assert.throws(() => storageVolume(1, 1, 1, { readWrite: true }), /r32/);
  assert.throws(
    () => storageVolume(1, 1, 1, { format: 'r32float', readWrite: true, pingPong: true }),
    /without pingPong/,
  );
  const t = storageVolume(1, 1, 1);
  assert.throws(() => new ComputePass(1, (i) => t.store(t.coord(i), t.load(t.coord(i)))), /use pingPong/);
  assert.throws(() => t.load(vec3(0)), /vec3u or vec3i/);
  assert.throws(() => t.store(uvec3(0), vec4(1)), /inside/);
});
