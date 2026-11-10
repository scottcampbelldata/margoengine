import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GLTFAsset } from '../../gltf-pro/dist/index.js';
import { readPropertyMetadata, loadPropertyMetadata } from '../dist/properties.js';
const folder = new URL('../../../examples/assets/3d-tiles/EXT_structural_metadata/', import.meta.url);
const json = (relative) => JSON.parse(readFileSync(new URL(relative, folder)));
test('real CC0 point cloud: every interleaved classification and float intensity matches the stored source bytes', () => {
  const doc = json('PropertyAttributesPointCloud/PropertyAttributesPointCloudTree.gltf'),
    buffer = readFileSync(new URL('PropertyAttributesPointCloud/PropertyAttributesPointCloudTree.bin', folder)),
    schema = json('PropertyAttributesPointCloud/MetadataSchema.json');
  const asset = new GLTFAsset(doc, [buffer]),
    metadata = readPropertyMetadata(asset, { schema }),
    attributes = metadata.primitives[0][0].attributes[0],
    view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  assert.equal(attributes.count, 6876);
  for (let i = 0; i < attributes.count; i++) {
    assert.equal(attributes.get(i, 'intensity'), view.getFloat32(165024 + i * 4, true));
    assert.equal(view.getUint16(192528 + i * 4, true), 0);
    assert.equal(attributes.get(i, 'classification'), 'MediumVegetation');
  }
  assert.equal(attributes.get(-1, 'intensity'), undefined);
});
test('real CC0 property texture: raw PNG channels survive alpha zero and normalization is applied once', async () => {
  const asset = new GLTFAsset(json('SimplePropertyTexture/SimplePropertyTexture.gltf'), []),
    metadata = await loadPropertyMetadata(asset),
    texture = metadata.primitives[0][0].textures[0];
  assert.deepEqual(texture.row([0, 0]), { insideTemperature: 13, outsideTemperature: 9, insulation: 40 / 255 });
  assert.deepEqual(texture.row([0.25, 0.25]), { insideTemperature: 20, outsideTemperature: 13, insulation: 50 / 255 });
  assert.deepEqual(texture.row([0.75, 0.25]), { insideTemperature: 21, outsideTemperature: 11, insulation: 50 / 255 });
  const values = metadata.sample(0, 0, 0, [0.5, 0.25, 0.25]);
  // Source triangle 0 has UVs (0,1), (1,1), (0,0): this hit is texel (4,12) of the 16x16 PNG.
  assert.deepEqual(values, [{ insideTemperature: 21, outsideTemperature: 12, insulation: 50 / 255 }]);
  assert.equal(metadata.sample(0, 0, 0, Float32Array.from([0.1, 0.2, 0.7])).length, 1);
  assert.throws(() => metadata.sample(0, 0, 99, [1, 0, 0]), /triangle index/);
});
function synthetic(definition, binding = {}, image = { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) }) {
  const schema = {
    classes: {
      test: { properties: { value: definition, missing: { type: 'SCALAR', componentType: 'UINT8', default: 17 } } },
    },
  };
  const doc = {
    extensions: {
      EXT_structural_metadata: {
        schema,
        propertyTextures: [{ class: 'test', properties: { value: { index: 0, channels: [0], ...binding } } }],
      },
    },
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ wrapS: 33071, wrapT: 33071 }],
    meshes: [{ primitives: [{ extensions: { EXT_structural_metadata: { propertyTextures: [0] } } }] }],
  };
  const asset = { doc, maxBytes: 1024 };
  return { asset, schema, read: () => readPropertyMetadata(asset, { image: () => image }).propertyTextures[0] };
}
test('texture properties decode little-endian floats/vectors, channel order, overrides, noData and defaults', () => {
  const f = synthetic(
    { type: 'SCALAR', componentType: 'FLOAT32', offset: 2, scale: 3 },
    { channels: [0, 1, 2, 3] },
    { width: 1, height: 1, data: new Uint8Array([0, 0, 128, 63]) },
  );
  assert.equal(f.read().get([0, 0], 'value'), 5);
  assert.equal(f.read().get([0, 0], 'missing'), 17);
  const v = synthetic(
    { type: 'VEC2', componentType: 'UINT16' },
    { channels: [3, 0, 2, 1] },
    { width: 1, height: 1, data: new Uint8Array([0x12, 0x56, 0x78, 0x34]) },
  );
  assert.deepEqual(v.read().get([0, 0], 'value'), [0x1234, 0x5678]);
  const missing = synthetic({
    type: 'SCALAR',
    componentType: 'UINT8',
    normalized: true,
    noData: 0,
    default: 9,
    offset: 2,
    scale: 3,
  });
  assert.equal(missing.read().get([0, 0], 'value'), 9);
  const override = synthetic(
    { type: 'SCALAR', componentType: 'UINT8', normalized: true, offset: 2, scale: 3 },
    { offset: 4, scale: 2 },
    { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 0]) },
  );
  assert.equal(override.read().get([0, 0], 'value'), 6);
});
test('texture properties support fixed arrays, booleans, enums, wrapping and texture transforms', () => {
  const array = synthetic(
    { type: 'SCALAR', componentType: 'UINT8', array: true, count: 4 },
    { channels: [0, 1, 2, 3] },
    { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) },
  );
  assert.deepEqual(array.read().get([0, 0], 'value'), [1, 2, 3, 4]);
  const bool = synthetic(
    { type: 'BOOLEAN', array: true, count: 3 },
    { channels: [0] },
    { width: 1, height: 1, data: new Uint8Array([5, 0, 0, 0]) },
  );
  assert.deepEqual(bool.read().get([0, 0], 'value'), [true, false, true]);
  const enumeration = synthetic(
    { type: 'ENUM', enumType: 'tree', noData: 'None', default: 'Oak' },
    { channels: [0, 1] },
  );
  enumeration.schema.enums = {
    tree: {
      valueType: 'UINT16',
      values: [
        { name: 'None', value: 0 },
        { name: 'Oak', value: 1 },
      ],
    },
  };
  assert.equal(enumeration.read().get([0, 0], 'value'), 'Oak');
  const transformed = synthetic(
    { type: 'SCALAR', componentType: 'UINT8' },
    { extensions: { KHR_texture_transform: { offset: [0.5, 0], scale: [0.5, 1], texCoord: 1 } } },
    { width: 2, height: 1, data: new Uint8Array([10, 0, 0, 0, 20, 0, 0, 0]) },
  );
  assert.equal(
    transformed.read().get((set) => {
      assert.equal(set, 1);
      return [0, 0];
    }, 'value'),
    20,
  );
});
function attributeFixture() {
  const schema = {
    classes: { test: { properties: { value: { type: 'SCALAR', componentType: 'UINT16', noData: 0, default: 99 } } } },
  };
  const views = [new Uint8Array([7, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0]), new Uint8Array([1]), new Uint8Array([42, 0])];
  const doc = {
    accessors: [
      { count: 3, type: 'VEC3', componentType: 5126 },
      {
        count: 3,
        type: 'SCALAR',
        componentType: 5123,
        bufferView: 0,
        sparse: { count: 1, indices: { bufferView: 1, componentType: 5121 }, values: { bufferView: 2 } },
      },
    ],
    bufferViews: [{ byteStride: 4 }, {}, {}],
    extensions: {
      EXT_structural_metadata: {
        schema,
        propertyAttributes: [{ class: 'test', properties: { value: { attribute: '_VALUE' } } }],
      },
    },
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, _VALUE: 1 },
            extensions: { EXT_structural_metadata: { propertyAttributes: [0] } },
          },
        ],
      },
    ],
  };
  return { asset: { doc, maxBytes: 1024, view: (i) => views[i] }, schema, views };
}
test('sparse property attributes retain integer bits and reject corrupt ranges and sparse indices', () => {
  const f = attributeFixture(),
    attributes = readPropertyMetadata(f.asset).primitives[0][0].attributes[0];
  assert.deepEqual(
    [0, 1, 2].map((i) => attributes.get(i, 'value')),
    [7, 42, 9],
  );
  f.views[1][0] = 3;
  assert.throws(() => readPropertyMetadata(f.asset), /Sparse property/);
  f.views[1][0] = 1;
  f.asset.doc.accessors[1].count = 4;
  f.asset.doc.accessors[0].count = 4;
  assert.throws(() => readPropertyMetadata(f.asset), /runs past/);
  assert.throws(() => readPropertyMetadata(attributeFixture().asset, { maximumDecodedBytes: 1 }), /decoded byte limit/);
  const unaligned = attributeFixture();
  unaligned.asset.doc.accessors[1].byteOffset = 1;
  assert.throws(() => readPropertyMetadata(unaligned.asset), /unaligned/);
});
test('byte, type, channel, finite-value and required-property validation rejects malformed metadata', () => {
  assert.throws(() => synthetic({ type: 'SCALAR', componentType: 'UINT16' }).read(), /channels/);
  assert.throws(() => synthetic({ type: 'STRING' }).read(), /fixed-size/);
  assert.throws(
    () =>
      synthetic(
        { type: 'SCALAR', componentType: 'FLOAT32' },
        { channels: [0, 1, 2, 3] },
        { width: 1, height: 1, data: new Uint8Array([0, 0, 128, 127]) },
      )
        .read()
        .get([0, 0], 'value'),
    /non-finite/,
  );
  const f = synthetic({ type: 'SCALAR', componentType: 'UINT8' });
  f.schema.classes.test.properties.missing.required = true;
  assert.throws(() => f.read(), /Required property/);
});
test('external schema loading uses the asset base URL, cancellation and a bounded fetch', async () => {
  const doc = json('PropertyAttributesPointCloud/PropertyAttributesPointCloudTree.gltf'),
    bytes = readFileSync(new URL('PropertyAttributesPointCloud/PropertyAttributesPointCloudTree.bin', folder)),
    asset = new GLTFAsset(doc, [bytes]);
  asset.baseURL = 'https://data.test/tree/model.gltf';
  const requested = [];
  const result = await loadPropertyMetadata(asset, {
    fetch: async (url, init) => {
      requested.push(url);
      assert.equal(init.signal, undefined);
      return new Response(JSON.stringify(json('PropertyAttributesPointCloud/MetadataSchema.json')));
    },
  });
  assert.deepEqual(requested, ['https://data.test/tree/MetadataSchema.json']);
  assert.equal(result.primitives[0][0].attributes[0].count, 6876);
  const controller = new AbortController();
  controller.abort('stop');
  await assert.rejects(loadPropertyMetadata(asset, { signal: controller.signal }), (e) => e === 'stop');
  await assert.rejects(
    loadPropertyMetadata(asset, { maximumBytes: 1, fetch: async () => new Response('{}') }),
    /budget|maximumBytes/,
  );
});
test('embedded schemas retain UTF-8 percent escapes and embedded resources obey the byte limit', async () => {
  const f = attributeFixture(),
    ext = f.asset.doc.extensions.EXT_structural_metadata;
  ext.schemaUri = 'data:application/json,' + encodeURIComponent(JSON.stringify({ ...f.schema, id: 'café' }));
  delete ext.schema;
  const metadata = await loadPropertyMetadata(f.asset);
  assert.equal(metadata.schema.id, 'café');
  await assert.rejects(loadPropertyMetadata(f.asset, { maximumBytes: 1 }), /maximumBytes/);
});

test('normalized signed attribute sentinels are compared before transforms and packed codec bytes stay exact', () => {
  const f = attributeFixture(),
    accessor = f.asset.doc.accessors[1],
    definition = f.schema.classes.test.properties.value;
  delete accessor.sparse;
  accessor.count = 3;
  accessor.componentType = 5120;
  accessor.normalized = true;
  f.asset.doc.bufferViews[0].byteStride = 1;
  f.views[0] = new Uint8Array([128, 129, 127]);
  Object.assign(definition, {
    componentType: 'INT8',
    normalized: true,
    noData: -128,
    default: 77,
    offset: 2,
    scale: 3,
  });
  let attributes = readPropertyMetadata(f.asset).primitives[0][0].attributes[0];
  assert.deepEqual(
    [0, 1, 2].map((i) => attributes.get(i, 'value')),
    [77, -1, 5],
  );
  delete accessor.bufferView;
  f.asset.doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression = {};
  f.asset.accessor = () => Float32Array.from([-1, -1, 1]);
  assert.throws(() => readPropertyMetadata(f.asset), /ambiguous raw sentinel/);
  attributes = readPropertyMetadata(f.asset, { accessor: () => f.views[0] }).primitives[0][0].attributes[0];
  assert.deepEqual(
    [0, 1, 2].map((i) => attributes.get(i, 'value')),
    [77, -1, 5],
  );
  accessor.componentType = 5125;
  accessor.normalized = false;
  definition.componentType = 'UINT32';
  definition.normalized = false;
  assert.throws(() => readPropertyMetadata(f.asset), /UINT32 metadata/);
  const bytes = new Uint8Array(new Uint32Array([16777217, 16777219, 4294967295]).buffer);
  attributes = readPropertyMetadata(f.asset, { accessor: () => bytes }).primitives[0][0].attributes[0];
  assert.deepEqual(
    [0, 1, 2].map((i) => attributes.get(i, 'value')),
    [16777217, 16777219, 4294967295],
  );
});
test('matrix column padding and boolean vertex storage follow their distinct glTF and metadata layouts', () => {
  const f = attributeFixture(),
    accessor = f.asset.doc.accessors[1],
    definition = f.schema.classes.test.properties.value;
  delete accessor.sparse;
  accessor.count = 1;
  f.asset.doc.accessors[0].count = 1;
  accessor.type = 'MAT3';
  accessor.componentType = 5121;
  f.asset.doc.bufferViews[0].byteStride = 12;
  Object.assign(definition, { type: 'MAT3', componentType: 'UINT8' });
  f.views[0] = new Uint8Array([1, 2, 3, 99, 4, 5, 6, 99, 7, 8, 9, 99]);
  assert.deepEqual(
    readPropertyMetadata(f.asset).primitives[0][0].attributes[0].get(0, 'value'),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  accessor.type = 'SCALAR';
  accessor.count = 3;
  f.asset.doc.accessors[0].count = 3;
  f.asset.doc.bufferViews[0].byteStride = 1;
  f.views[0] = new Uint8Array([1, 0, 1]);
  definition.type = 'BOOLEAN';
  delete definition.noData;
  delete definition.default;
  const attrs = readPropertyMetadata(f.asset).primitives[0][0].attributes[0];
  assert.deepEqual(
    [0, 1, 2].map((i) => attrs.get(i, 'value')),
    [true, false, true],
  );
});

test('source triangle strips, fans and indexed lists use the correct corner order for UV lookup', () => {
  const f = synthetic(
    { type: 'SCALAR', componentType: 'UINT8' },
    {},
    { width: 2, height: 2, data: new Uint8Array([10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0, 40, 0, 0, 0]) },
  );
  const primitive = f.asset.doc.meshes[0].primitives[0];
  primitive.attributes = { POSITION: 0, TEXCOORD_0: 1 };
  f.asset.doc.accessors = [{ count: 4 }, { count: 4 }];
  f.asset.accessor = (index) =>
    index === 1 ? Float32Array.from([0, 0, 1, 0, 0, 1, 1, 1]) : Float32Array.from([3, 2, 1, 0]);
  const image = { width: 2, height: 2, data: new Uint8Array([10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0, 40, 0, 0, 0]) };
  primitive.mode = 5;
  let metadata = readPropertyMetadata(f.asset, { image: () => image });
  assert.equal(metadata.sample(0, 0, 1, [1, 0, 0])[0].value, 30);
  primitive.mode = 6;
  metadata = readPropertyMetadata(f.asset, { image: () => image });
  assert.equal(metadata.sample(0, 0, 1, [1, 0, 0])[0].value, 10);
  primitive.mode = 4;
  primitive.indices = 2;
  metadata = readPropertyMetadata(f.asset, { image: () => image });
  assert.equal(metadata.sample(0, 0, 0, [1, 0, 0])[0].value, 40);
});
