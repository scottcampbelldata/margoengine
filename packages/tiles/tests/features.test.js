import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GLTFAsset } from '../../gltf-pro/dist/index.js';
import { PBRInstances } from '../../gltf-pro/dist/instancing.js';
import { BatchTable, FeatureTable } from '../dist/index.js';
import { TileFeatures, textureFeatureId, metadataTexel } from '../dist/features.js';
import { validatePreparedGeometry } from '../../shared/prepared-geometry.js';

const source = JSON.parse(
  readFileSync(
    new URL(
      '../../../examples/assets/3d-tiles/EXT_structural_metadata/FeatureIdAttributeAndPropertyTable/FeatureIdAttributeAndPropertyTable.gltf',
      import.meta.url,
    ),
  ),
);
function fixture(change = () => {}) {
  const doc = structuredClone(source);
  change(doc);
  const asset = new GLTFAsset(doc, []),
    definition = doc.meshes[0].primitives[0];
  const positions = asset.accessor(definition.attributes.POSITION, 'VEC3'),
    normals = asset.accessor(definition.attributes.NORMAL, 'VEC3');
  const vertices = new Float32Array((positions.length / 3) * 20);
  for (let i = 0; i < positions.length / 3; i++) {
    vertices.set([...positions.subarray(i * 3, i * 3 + 3), 1], i * 20);
    vertices.set(normals.subarray(i * 3, i * 3 + 3), i * 20 + 4);
    vertices.set([1, 1, 1, 1], i * 20 + 16);
  }
  const primitive = {
    vertices,
    indices: Uint32Array.from(asset.accessor(definition.indices, 'SCALAR')),
    definition,
    material: { settings: [0, 0.5, 0] },
  };
  const model = {
    asset,
    primitives: [primitive],
    writeGeometry(data) {
      for (const g of data) validatePreparedGeometry(g);
      data.forEach((g, i) =>
        Object.assign(this.primitives[i], { vertices: g.vertices, indices: g.indices, uvs: g.uvs }),
      );
    },
  };
  const engine = {
    use(plugin) {
      plugin.setup(this);
    },
    sceneOf: () => undefined,
    removePlugin() {},
    gpu: null,
  };
  const content = { type: 'gltf', gltf: new TextEncoder().encode(JSON.stringify(doc)), byteLength: 100 };
  const tile = { id: 0, contentUrls: ['https://example.invalid/tile.gltf'] };
  return { model, primitive, engine, context: { kind: 'model', model, content, tile }, doc };
}
const pick = (f, faceIndex = 0, barycoord = [0.8, 0.1, 0.1]) => ({
  model: f.model,
  primitive: f.primitive,
  faceIndex,
  barycoord,
});

for (const kind of ['model', 'points']) {
  test(`pending ${kind} decoration releases its prior owner after controller disposal`, async () => {
    const f = fixture();
    let finish;
    let released = 0;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const features = new TileFeatures(f.engine, { decorate: () => pending });
    const work = features.decorate({ ...f.context, kind });
    features.dispose();
    finish({
      bytes: 1,
      dispose() {
        released++;
      },
    });
    await assert.rejects(work, { code: 'disposed' });
    assert.equal(released, 1);
  });
}

test('aborting a pending preceding decorator releases it and preserves a falsy reason', async () => {
  const f = fixture(),
    controller = new AbortController();
  let finish;
  let released = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const features = new TileFeatures(f.engine, { decorate: () => pending });
  const work = features.decorate({ ...f.context, signal: controller.signal });
  controller.abort(false);
  finish({
    bytes: 1,
    dispose() {
      released++;
    },
  });
  try {
    await assert.rejects(work, (error) => error === false);
    assert.equal(released, 1);
    assert.equal(features.resolve(pick(f)), undefined);
  } finally {
    features.dispose();
  }
});

test('controller disposal during feature image decoding rejects the decoration and releases its prior owner', async () => {
  const f = fixture((doc) => {
    const set = doc.meshes[0].primitives[0].extensions.EXT_mesh_features.featureIds[0];
    delete set.attribute;
    set.texture = { index: 0, channels: [0] };
    doc.textures = [{ source: 0 }];
  });
  let finish, started;
  let released = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const decoding = new Promise((resolve) => {
    started = resolve;
  });
  const features = new TileFeatures(f.engine, {
    decorate: () => ({
      bytes: 1,
      dispose() {
        released++;
      },
    }),
    image: () => {
      started();
      return pending;
    },
  });
  const work = features.decorate(f.context);
  await decoding;
  features.dispose();
  finish({ width: 1, height: 1, data: new Uint8Array(4) });
  await assert.rejects(work, { code: 'disposed' });
  assert.equal(released, 1);
});
test('real CC0 sample: ray hits resolve feature ID and the exact structural metadata row', async () => {
  const f = fixture(),
    features = TileFeatures.attach(f.engine),
    decoration = await features.decorate(f.context);
  const feature = features.resolve(pick(f));
  assert.equal(feature.id, 0);
  assert.deepEqual(feature.properties.example_VEC3_FLOAT32, [0, 0.10000000149011612, 0.20000000298023224]);
  const vertices = f.primitive.vertices,
    indices = f.primitive.indices,
    material = f.primitive.material;
  features.highlight(feature, [1, 0, 0, 1]);
  assert.deepEqual([...f.primitive.vertices.subarray(16, 20)], [1, 0, 0, 1]);
  assert.equal(features.resolve(pick(f)).id, 0);
  features.clear();
  assert.equal(f.primitive.vertices, vertices);
  assert.equal(f.primitive.indices, indices);
  assert.equal(f.primitive.material, material);
  decoration.dispose();
  assert.equal(features.resolve(pick(f)), undefined);
  assert.throws(() => features.highlight(feature), /unloaded/);
  features.dispose();
  assert.throws(() => features.resolve(pick(f)), /disposed/);
});
test('b3dm batch table uses legacy IDs and a missing feature set uses the content single feature', async () => {
  const f = fixture((doc) => delete doc.meshes[0].primitives[0].extensions);
  f.context.content.batchTable = new BatchTable({ name: ['building'] }, new Uint8Array(), 1);
  const features = new TileFeatures(f.engine);
  await features.decorate(f.context);
  assert.deepEqual(features.resolve(pick(f)).properties, { name: 'building' });
  features.dispose();
});
test('feature set labels and null IDs are respected', async () => {
  const f = fixture((doc) => {
    const set = doc.meshes[0].primitives[0].extensions.EXT_mesh_features.featureIds[0];
    set.label = 'building';
    set.nullFeatureId = 0;
  });
  const features = new TileFeatures(f.engine, { set: 'building' });
  await features.decorate(f.context);
  assert.equal(features.resolve(pick(f)), undefined);
  const feature = features.resolve(pick(f, 2));
  assert.equal(feature.id, 1);
  assert.equal(feature.label, 'building');
  features.dispose();
});
test('i3dm BATCH_ID resolves instance row to metadata and highlight restores shared instance tint', async () => {
  const f = fixture(),
    rows = new PBRInstances(2);
  f.primitive.instances = rows;
  const content = {
    type: 'i3dm',
    length: 2,
    featureTable: new FeatureTable(
      { BATCH_ID: { byteOffset: 0, componentType: 'UNSIGNED_BYTE' } },
      new Uint8Array([1, 0]),
    ),
    batchTable: new BatchTable({ name: ['oak', 'pine'] }, new Uint8Array(), 2),
  };
  const features = new TileFeatures(f.engine);
  await features.decorate({ ...f.context, kind: 'instances', content });
  const hit = { ...pick(f), instanceId: 0 },
    feature = features.resolve(hit);
  assert.equal(feature.id, 1);
  assert.equal(feature.properties.name, 'pine');
  const original = rows.data.slice();
  features.highlight(feature, [0, 1, 0, 0.5]);
  assert.deepEqual([...rows.data.subarray(16, 20)], [0, 1, 0, 0.5]);
  assert.deepEqual([...rows.data.subarray(40, 44)], [1, 1, 1, 1]);
  features.clear();
  assert.deepEqual(rows.data, original);
  features.dispose();
});
test('feature textures retain unsigned 32-bit IDs, channel order, wrapping and nearest sampling', () => {
  assert.equal(textureFeatureId([255, 255, 255, 255], [0, 1, 2, 3]), 4294967295);
  assert.equal(textureFeatureId([1, 2, 3, 4], [2, 0]), 259);
  const image = { width: 2, height: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
  assert.deepEqual([...metadataTexel(image, [0.5, 0])], [5, 6, 7, 8]);
  assert.deepEqual([...metadataTexel(image, [1.1, -0.1], 33071, 33071)], [5, 6, 7, 8]);
  assert.deepEqual([...metadataTexel(image, [1.1, 0], 10497)], [1, 2, 3, 4]);
  assert.deepEqual([...metadataTexel(image, [-0.1, 0], 33648)], [1, 2, 3, 4]);
  for (const channels of [[], [4], [1, 1]]) assert.throws(() => textureFeatureId([1, 2, 3, 4], channels), /channels/);
});
test('mixed attribute features use nearest-vertex Voronoi regions without blended highlight boundaries', async () => {
  const f = fixture();
  const definition = f.doc.meshes[0].primitives[0],
    accessor = f.doc.accessors[definition.attributes._FEATURE_ID_0],
    view = f.doc.bufferViews[accessor.bufferView];
  const bytes = f.model.asset.buffers[view.buffer],
    data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids = [0, 1, 2, 0];
  ids.forEach((id, i) => data.setUint8((view.byteOffset ?? 0) + i * (view.byteStride ?? 1), id));
  f.doc.buffers[view.buffer].uri = 'data:application/octet-stream;base64,' + Buffer.from(bytes).toString('base64');
  f.context.content.gltf = new TextEncoder().encode(JSON.stringify(f.doc));
  const features = new TileFeatures(f.engine);
  await features.decorate(f.context);
  const feature = features.resolve(pick(f)),
    original = f.primitive.vertices;
  features.highlight(feature, [1, 0, 0, 1]);
  assert.ok(f.primitive.vertices.length > original.length);
  for (let i = 0; i < f.primitive.indices.length; i += 3) {
    const colors = [0, 1, 2].map((k) => f.primitive.vertices[f.primitive.indices[i + k] * 20 + 17]);
    assert.ok(colors.every((v) => v === colors[0]));
  }
  const area = (v, indices) => {
    let sum = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const p = [0, 1, 2].map((k) => indices[i + k] * 20);
      sum +=
        Math.abs(
          (v[p[1]] - v[p[0]]) * (v[p[2] + 1] - v[p[0] + 1]) - (v[p[2]] - v[p[0]]) * (v[p[1] + 1] - v[p[0] + 1]),
        ) / 2;
    }
    return sum;
  };
  assert.ok(
    Math.abs(
      area(original, f.model.asset.accessor(definition.indices)) - area(f.primitive.vertices, f.primitive.indices),
    ) < 1e-7,
  );
  features.clear();
  assert.equal(f.primitive.vertices, original);
  features.dispose();
});

test('clipping preserves the original affine smooth normal and tangent fields', async () => {
  const f = fixture();
  const v = f.primitive.vertices;
  const ids = f.doc.meshes[0].primitives[0].attributes._FEATURE_ID_0;
  const a = f.doc.accessors[ids],
    b = f.doc.bufferViews[a.bufferView],
    bytes = f.model.asset.buffers[b.buffer];
  [0, 1, 2, 0].forEach((id, i) => (bytes[(b.byteOffset ?? 0) + i * (b.byteStride ?? 1)] = id));
  f.doc.buffers[b.buffer].uri = 'data:application/octet-stream;base64,' + Buffer.from(bytes).toString('base64');
  f.context.content.gltf = new TextEncoder().encode(JSON.stringify(f.doc));
  f.primitive.indices = new Uint32Array([0, 1, 2]);
  const positions = [
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 0],
    ],
    normals = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  positions.forEach((point, i) => {
    v.set(point, i * 20);
    v.set(normals[i], i * 20 + 4);
    v.set(normals[(i + 1) % 3], i * 20 + 8);
    v[i * 20 + 11] = 1;
  });
  const features = new TileFeatures(f.engine);
  await features.decorate(f.context);
  features.highlight(features.resolve(pick(f)), [1, 1, 1, 1]);
  const out = f.primitive.vertices;
  let shorter = false;
  for (let i = 0; i < out.length; i += 20) {
    const weights = [1 - out[i] / 2 - out[i + 1] / 2, out[i] / 2, out[i + 1] / 2];
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(out[i + 4 + k] - weights[k]) < 1e-7);
      assert.ok(Math.abs(out[i + 8 + k] - weights[(k + 2) % 3]) < 1e-7);
    }
    shorter ||= Math.hypot(...out.subarray(i + 4, i + 7)) < 0.9;
  }
  assert.ok(shorter, 'new clipping vertices retain unnormalized convex direction interpolants');
  features.dispose();
});
test('normalized accessors retain raw feature IDs and decoded UINT32 sentinels require original bytes', async () => {
  const f = fixture((doc) => (doc.accessors[doc.meshes[0].primitives[0].attributes._FEATURE_ID_0].normalized = true));
  const features = new TileFeatures(f.engine);
  await features.decorate(f.context);
  assert.equal(features.resolve(pick(f, 2)).id, 1);
  features.dispose();
  const g = fixture((doc) => {
    const p = doc.meshes[0].primitives[0];
    const index = p.attributes._FEATURE_ID_0;
    doc.accessors[index] = { componentType: 5125, count: 16, type: 'SCALAR' };
    p.extensions.KHR_draco_mesh_compression = { bufferView: 0, attributes: { _FEATURE_ID_0: 0 } };
    delete p.extensions.EXT_mesh_features.featureIds[0].propertyTable;
    p.extensions.EXT_mesh_features.featureIds[0].nullFeatureId = 4294967295;
  });
  const missing = new TileFeatures(g.engine);
  await assert.rejects(missing.decorate(g.context), /precision/);
  missing.dispose();
  const raw = new Uint32Array(16);
  raw.set([4294967295, 4294967294, 7, 8]);
  const exact = new TileFeatures(g.engine, { accessor: () => new Uint8Array(raw.buffer) });
  await exact.decorate(g.context);
  assert.equal(exact.resolve(pick(g)), undefined);
  assert.equal(exact.resolve(pick(g, 0, [0.1, 0.8, 0.1])).id, 4294967294);
  exact.dispose();
});
test('feature texture transforms and UINT32 shader factors remain exact and budgeted', async () => {
  const f = fixture((doc) => {
    const p = doc.meshes[0].primitives[0];
    p.attributes.TEXCOORD_1 = p.attributes.POSITION;
    const set = p.extensions.EXT_mesh_features.featureIds[0];
    delete set.attribute;
    delete set.propertyTable;
    set.texture = {
      index: 0,
      channels: [0, 1, 2, 3],
      extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.75, 0], scale: [0, 0] } },
    };
    doc.textures = [{ source: 0 }];
  });
  // A VEC2 cache stands in for an independently decoded coordinate set.
  f.model.asset.accessor = () => new Float32Array(8);
  let destroyed = 0;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
  f.engine.gpu = {
    createTexture: () => ({
      createView: () => ({}),
      destroy() {
        destroyed++;
      },
    }),
    queue: { writeTexture() {} },
    createSampler: () => ({}),
  };
  const features = new TileFeatures(f.engine, {
    image: () => ({ width: 2, height: 1, data: new Uint8Array([0, 0, 0, 0, 254, 255, 255, 255]) }),
  });
  const decoration = await features.decorate(f.context);
  const feature = features.resolve(pick(f));
  assert.equal(feature.id, 4294967294);
  features.highlight(feature);
  assert.deepEqual([...f.primitive.extension.factors.subarray(0, 2)], [65534, 65535]);
  assert.ok(f.primitive.extension.factors.every(Number.isFinite));
  assert.equal(decoration.bytes, 8 + 32);
  features.clear();
  assert.equal(decoration.bytes, 0);
  assert.equal(destroyed, 1);
  features.dispose();
});
test('feature ID texture transforms pick and highlight the texel gltf-pro draws (review 5)', async () => {
  const { textureCoordinates } = await import('../../gltf-pro/dist/index.js');
  const transform = { offset: [0.25, 0.5], rotation: Math.PI / 2, scale: [2, 1] };
  const f = fixture((doc) => {
    const p = doc.meshes[0].primitives[0];
    p.attributes.TEXCOORD_0 = p.attributes.POSITION;
    const set = p.extensions.EXT_mesh_features.featureIds[0];
    delete set.attribute;
    delete set.propertyTable;
    set.texture = { index: 0, channels: [0], extensions: { KHR_texture_transform: transform } };
    doc.textures = [{ source: 0 }];
  });
  const m = textureCoordinates({ extensions: { KHR_texture_transform: transform } }).transform;
  const drawn = (uv) => [m[0] * uv[0] + m[1] * uv[1] + m[2], m[4] * uv[0] + m[5] * uv[1] + m[6]];
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
  f.engine.gpu = {
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    queue: { writeTexture() {} },
    createSampler: () => ({}),
  };
  f.model.asset.accessor = () => new Float32Array(8);
  const features = new TileFeatures(f.engine, { image: () => ({ width: 1, height: 1, data: new Uint8Array(4) }) });
  await features.decorate(f.context);
  const set = { texture: f.doc.meshes[0].primitives[0].extensions.EXT_mesh_features.featureIds[0].texture };
  features.highlight(features.resolve(pick(f)));
  const code = f.primitive.extension.wgsl;
  const rows = [...code.matchAll(/dot\(vec2f\(([^,()]+),([^,()]+)\),uv\(i,0\.0\)\)\+([^,()]+)/g)].map((r) =>
    r.slice(1, 4).map(Number),
  );
  assert.equal(rows.length, 2, 'the highlight shader applies the transform as one affine map');
  for (const uv of [
    [0.1, 0.3],
    [0.7, 0.2],
    [0.5, 0.95],
  ]) {
    const cpu = features.transformed(set, uv),
      gpu = rows.map(([a, b, c]) => a * uv[0] + b * uv[1] + c);
    drawn(uv).forEach((v, k) => {
      assert.ok(Math.abs(cpu[k] - v) < 1e-6, `CPU pick ${cpu} vs drawn ${drawn(uv)}`);
      assert.ok(Math.abs(gpu[k] - v) < 1e-6, `GPU highlight ${gpu} vs drawn ${drawn(uv)}`);
    });
  }
  features.dispose();
});
test('FLOAT feature ID attributes (EXT_mesh_features, legacy b3dm _BATCHID) decode as IDs, not raw bits (review 5)', () => {
  const features = new TileFeatures({ use() {}, sceneOf: () => undefined, removePlugin() {} });
  const ids = new Float32Array([0, 1, 2, 3]);
  const asset = {
    maxBytes: 1 << 20,
    doc: {
      accessors: [{ componentType: 5126, type: 'SCALAR', count: 4, bufferView: 0 }],
      bufferViews: [{ byteLength: 16 }],
    },
    view: () => new Uint8Array(ids.buffer),
  };
  assert.deepEqual([...features.rawIds({ asset }, 0)], [0, 1, 2, 3]);
  ids[2] = 1.5;
  assert.throws(() => features.rawIds({ asset }, 0), /non-integer/);
});
test('percent-encoded binary data: URI feature images decode to their exact bytes (review 5)', async () => {
  const { deflateSync } = await import('node:zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const crc = (b) => (b.reduce((c, x) => crcTable[(c ^ x) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const chunk = (type, data) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]),
      out = new DataView(new ArrayBuffer(body.length + 8));
    out.setUint32(0, data.length);
    new Uint8Array(out.buffer).set(body, 4);
    out.setUint32(body.length + 4, crc(body));
    return [...new Uint8Array(out.buffer)];
  };
  const ihdr = [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0];
  const png = Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', deflateSync(Uint8Array.of(0, 7, 0, 0, 255))),
    ...chunk('IEND', []),
  ]);
  const uri = 'data:image/png,' + [...png].map((b) => '%' + b.toString(16).padStart(2, '0')).join('');
  const model = { asset: { doc: { textures: [{ source: 0 }], images: [{ uri }] } } };
  const features = new TileFeatures({ use() {}, sceneOf: () => undefined, removePlugin() {} });
  await features.prepareImage({ model, context: {} }, { texture: { index: 0 } });
  assert.equal(features.images.get(model).get(0).data[0], 7);
});
