// @margoengine/tiles/metadata: EXT_structural_metadata property tables and EXT_mesh_features feature IDs read from real
// Cesium samples (values checked against the sample READMEs), and Draco pnts decoded from real Draco point clouds of
// google/draco's test data, wrapped in a stand-in pnts made here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeDracoPoints } from '../../decoders/dist/codec.js';
import { TilesRenderer, parsePnts } from '../dist/index.js';
import { dracoPoints, readStructuralMetadata } from '../dist/metadata.js';
import { dracoPnts, memoryFetch, settle } from './generator.js';

const asset = (path) =>
  new Uint8Array(readFileSync(new URL(`../../../examples/assets/3d-tiles/${path}`, import.meta.url)));
const drc = (name) =>
  new Uint8Array(readFileSync(new URL(`../../decoders/tests/fixtures/draco-points/${name}`, import.meta.url)));

// Google's full Draco decoder, as @margoengine/decoders ships it; its wrapper takes its Node path from these globals.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('../../decoders/dist/draco-full/', import.meta.url));
(0, eval)(readFileSync(new URL('../../decoders/dist/draco-full/draco_wasm_wrapper.js', import.meta.url), 'utf8'));
const { module: draco } = await new Promise((resolve, reject) =>
  globalThis
    .DracoDecoderModule({
      wasmBinary: readFileSync(new URL('../../decoders/dist/draco-full/draco_decoder.wasm', import.meta.url)),
    })
    .then((module) => resolve({ module }), reject),
);
/** The same decode as the worker decoder of @margoengine/decoders/draco-points, in this thread. */
const source = { decode: async (bytes) => decodeDracoPoints(draco, bytes) };

test('metadata: a real ComplexTypes table reads as its README lists (normalized, boolean, string and enum arrays)', () => {
  const metadata = readStructuralMetadata(asset('EXT_structural_metadata/ComplexTypes/ComplexTypes.gltf')),
    [table] = metadata.propertyTables;
  assert.equal(table.count, 4);
  const raw = [
      [0, 255],
      [0, 128, 255],
      [0, 85, 170, 255],
      [0, 64, 128, 192, 255],
    ],
    bools = [
      [true, false, true, false, true, false, true, false, true, false],
      [true, true, false, false, true, true, false, false, true, true],
      [false, false, true, true, false, false, true, true, false, false],
      [false, true, false, true, false, true, false, true, false, true],
    ],
    // The fourth row's typo is the sample's own; the words are split from one string.
    strings = ['One', 'One Two', 'One Two Three', 'One Two Theee Four'].map((words) => words.split(' ')),
    enums = [
      [0, 1],
      [1, 2],
      [2, 0],
      [1, 2],
    ],
    names = ['ExampleEnumValueA', 'ExampleEnumValueB', 'ExampleEnumValueC'];
  for (let row = 0; row < 4; row++) {
    const values = table.row(row);
    // Normalized UINT8 is value / 255, exactly in float64.
    assert.deepEqual(
      values.example_variable_length_ARRAY_normalized_UINT8,
      raw[row].map((v) => v / 255),
    );
    assert.deepEqual(values.example_fixed_length_ARRAY_BOOLEAN, bools[row]);
    assert.deepEqual(values.example_variable_length_ARRAY_STRING, strings[row]);
    assert.deepEqual(
      values.example_fixed_length_ARRAY_ENUM,
      enums[row].map((v) => names[v]),
    );
  }
  assert.equal(table.get(4, 'example_fixed_length_ARRAY_BOOLEAN'), undefined, 'a row past the table reads as nothing');
});

test('metadata: a picked vertex of a real sample leads through its feature ID to its property row', () => {
  const metadata = readStructuralMetadata(
      asset('EXT_structural_metadata/FeatureIdAttributeAndPropertyTable/FeatureIdAttributeAndPropertyTable.gltf'),
    ),
    [set] = metadata.primitives[0][0];
  assert.equal(set.featureCount, 4);
  assert.equal(set.attribute, 0);
  // The README's values, as float32 holds them (one float32 step at 3.2 is 2.4e-7).
  const want = [
    [0, 0.1, 0.2],
    [1, 1.1, 1.2],
    [2, 2.1, 2.2],
    [3, 3.1, 3.2],
  ];
  for (let vertex = 0; vertex < set.ids.length; vertex++) {
    const feature = metadata.feature(0, 0, vertex);
    assert.equal(feature.id, set.ids[vertex]);
    feature.properties.example_VEC3_FLOAT32.forEach((v, k) =>
      assert.ok(Math.abs(v - Math.fround(want[feature.id][k])) === 0),
    );
  }
  assert.deepEqual([...new Set(set.ids)], [0, 1, 2, 3], 'the quad strip has four features');
  assert.equal(metadata.feature(0, 0, 999), undefined, 'a vertex past the primitive has no feature');
});

test('metadata: noData gives the default, offset and scale apply after normalizing, and a bad view is refused', () => {
  const values = new Uint8Array([0, 255, 128, 7]),
    json = {
      asset: { version: '2.0' },
      buffers: [
        { byteLength: 4, uri: `data:application/octet-stream;base64,${Buffer.from(values).toString('base64')}` },
      ],
      bufferViews: [
        { buffer: 0, byteLength: 4 },
        { buffer: 0, byteOffset: 2, byteLength: 4 },
      ],
      extensions: {
        EXT_structural_metadata: {
          schema: {
            classes: {
              c: {
                properties: {
                  level: {
                    type: 'SCALAR',
                    componentType: 'UINT8',
                    normalized: true,
                    offset: 10,
                    scale: 2,
                    noData: 7,
                    default: -1,
                  },
                },
              },
            },
          },
          propertyTables: [{ class: 'c', count: 4, properties: { level: { values: 0 } } }],
        },
      },
    };
  const table = readStructuralMetadata(new TextEncoder().encode(JSON.stringify(json))).propertyTables[0];
  assert.deepEqual(
    [0, 1, 2, 3].map((r) => table.get(r, 'level')),
    [10, 12, 10 + (2 * 128) / 255, -1],
  );
  json.extensions.EXT_structural_metadata.propertyTables[0].properties.level.values = 1;
  assert.throws(() => readStructuralMetadata(new TextEncoder().encode(JSON.stringify(json))), RangeError);
});

test('draco pnts: real Draco points decode to the positions and colours the Draco decoder gives', async () => {
  const bytes = drc('pc_color.drc'),
    want = decodeDracoPoints(draco, bytes),
    content = parsePnts(dracoPnts(bytes, { length: want.pointCount, properties: { POSITION: 0, RGB: 1 } }));
  assert.equal(content.positions.length, 0, 'nothing is decoded before dracoPoints');
  assert.equal(content.draco.length, 7733);
  const points = await dracoPoints(content, undefined, source);
  assert.equal(points.draco, undefined);
  assert.deepEqual([...points.positions], [...want.attributes[0].array]);
  const rgb = want.attributes[1].array;
  for (let i = 0; i < want.pointCount; i++) {
    for (let k = 0; k < 3; k++) assert.equal(points.colors[i * 4 + k], rgb[i * 3 + k]);
    assert.equal(points.colors[i * 4 + 3], 255);
  }
});

test('draco pnts: batch table properties come out of the Draco buffer, and a missing attribute is refused', async () => {
  const bytes = drc('survey.drc'),
    decoded = decodeDracoPoints(draco, bytes),
    position = decoded.attributes.find((a) => a.name === 'POSITION'),
    intensity = decoded.attributes.find((a) => a.name === 'intensity');
  const content = parsePnts(
    dracoPnts(bytes, {
      length: 1000,
      properties: { POSITION: position.uniqueId },
      batch: { intensity: intensity.uniqueId },
    }),
  );
  const points = await dracoPoints(content, undefined, source);
  assert.deepEqual([...points.batchTable.values('intensity')], [...intensity.array]);
  assert.deepEqual(points.batchTable.feature(3), { intensity: intensity.array[3] });
  const wrong = parsePnts(dracoPnts(bytes, { length: 1000, properties: { POSITION: 99 } }));
  await assert.rejects(dracoPoints(wrong, undefined, source), /attribute 99/);
  const short = parsePnts(dracoPnts(bytes, { length: 999, properties: { POSITION: position.uniqueId } }));
  await assert.rejects(dracoPoints(short, undefined, source), /POINTS_LENGTH is 999/);
});

test('draco pnts: a Draco range past the feature table binary is refused', () => {
  const bytes = dracoPnts(drc('cube_pc.drc'), { length: 24, properties: { POSITION: 0 } }),
    text = new TextDecoder().decode(bytes);
  const at = text.indexOf('"byteLength":') + 13,
    broken = new Uint8Array(bytes);
  broken.set(new TextEncoder().encode('9'), at);
  assert.throws(() => parsePnts(broken), RangeError);
});

test('draco pnts: without the dracoPoints option the renderer fails the tile with a coded error naming the entry', async () => {
  const content = dracoPnts(drc('cube_pc.drc'), { length: 24, properties: { POSITION: 0 } }),
    files = new Map([
      [
        'tileset.json',
        JSON.stringify({
          asset: { version: '1.1' },
          geometricError: 10,
          root: { boundingVolume: { sphere: [0, 0, 0, 5] }, geometricError: 0, content: { uri: 'p.pnts' } },
        }),
      ],
      ['p.pnts', content],
    ]),
    memory = memoryFetch(files),
    engine = {
      camera: { position: [0, 0, 20], fov: 60, planes: new Float32Array(24) },
      canvas: { height: 600 },
      use(plugin) {
        plugin.setup(this);
        return this;
      },
      hasPlugin: () => false,
    };
  const renderer = await TilesRenderer.load(engine, memory.url, { fetch: memory.fetch, frame: 'local' }),
    errors = [];
  renderer.tileset.on('error', ({ error }) => errors.push(error));
  for (let i = 0; i < 20 && !errors.length; i++) {
    renderer.update();
    await settle(4);
  }
  assert.equal(errors[0]?.code, 'unsupported');
  assert.match(errors[0].message, /@margoengine\/tiles\/metadata/);
  renderer.dispose();
});
