// The layers option: every UV set and colour layer of a real Blender file against Blender's own values, then the texture
// to UV set link on a hand-written file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import validator from 'gltf-validator';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { headlessEngine } from '../../exporters/tests/helpers.js';
import { convertFBX } from '../dist/index.js';
import { modelFromPrepared } from '../../gltf-pro/dist/worker.js';
import { readGLB } from './native-scene-helper.js';
import { ascii, L } from './fixtures.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

const file = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
  truth = JSON.parse(file('blender-layers.json'));

test('real Blender grid: three UV maps and two colour layers keep every value', async () => {
  const buffer = await convertFBX(file('blender-layers.fbx'), { layers: true }),
    { doc, accessor } = readGLB(buffer),
    { attributes } = doc.meshes[0].primitives[0];
  const report = await validator.validateBytes(new Uint8Array(buffer));
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
  const positions = accessor(attributes.POSITION),
    sets = [
      ['UVMap', accessor(attributes.TEXCOORD_0)],
      ['lightmap', accessor(attributes.TEXCOORD_1)],
      ['detail', accessor(attributes.TEXCOORD_2)],
    ],
    colors = [
      ['Tint', accessor(attributes.COLOR_0)],
      ['Wetness', accessor(attributes.COLOR_1)],
    ];
  assert.equal(attributes.TEXCOORD_3, undefined);
  const count = positions.length / 3;
  assert.equal(count, 9);
  for (let i = 0; i < count; i++) {
    // The file is Z up, so Blender's (x, y) lands on glTF's (x, -z); the grid is whole numbers.
    const key = `${Math.round(positions[i * 3])},${Math.round(-positions[i * 3 + 2])}`;
    for (const [name, values] of sets) {
      const [u, v] = truth.uvs[name][key];
      // Float32 through the file and back, then 1 - v: one ulp of the largest value, 8, is below 1e-6.
      assert.ok(Math.abs(values[i * 2] - u) < 1e-6, `${name} u at ${key}`);
      assert.ok(Math.abs(values[i * 2 + 1] - (1 - v)) < 1e-6, `${name} v at ${key}`);
    }
    for (const [name, values] of colors)
      truth.colors[name][key].forEach((value, k) =>
        assert.ok(Math.abs(values[i * 4 + k] - value) < 1e-6, `${name}[${k}] at ${key}`),
      );
  }
});

test('without the option only the first UV set and colour layer are kept, as before', async () => {
  const { doc } = readGLB(await convertFBX(file('blender-layers.fbx'))),
    { attributes } = doc.meshes[0].primitives[0];
  assert.ok(attributes.TEXCOORD_0 !== undefined && attributes.COLOR_0 !== undefined);
  assert.equal(attributes.TEXCOORD_1, undefined);
  assert.equal(attributes.COLOR_1, undefined);
});

test('a corner that differs only in its second UV set keeps its own vertex', async () => {
  const uv = (index, name, values, indices) => [
    'LayerElementUV',
    [{ I: index }],
    [
      ['Name', [name]],
      ['MappingInformationType', ['ByPolygonVertex']],
      ['ReferenceInformationType', ['IndexToDirect']],
      ['UV', [{ array: 'd', values }]],
      ['UVIndex', [{ array: 'i', values: indices }]],
    ],
  ];
  // Two triangles over a shared edge: the first UV set agrees across it, the second does not.
  const bytes = new TextEncoder().encode(
    ascii([
      [
        'Objects',
        [],
        [
          [
            'Geometry',
            [L(10), 'Geometry::G', 'Mesh'],
            [
              ['Vertices', [{ array: 'd', values: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] }]],
              ['PolygonVertexIndex', [{ array: 'i', values: [0, 1, ~2, 0, 2, ~3] }]],
              uv(0, 'first', [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3]),
              uv(1, 'second', [0, 0, 0.5, 0, 0.5, 0.5, 0.75, 0.75, 1, 1, 0.75, 1], [0, 1, 2, 3, 4, 5]),
            ],
          ],
          ['Model', [L(100), 'Model::M', 'Mesh']],
        ],
      ],
      [
        'Connections',
        [],
        [
          ['C', ['OO', L(100), L(0)]],
          ['C', ['OO', L(10), L(100)]],
        ],
      ],
    ]),
  );
  const count = async (options) => {
    const { doc } = readGLB(await convertFBX(bytes, options));
    return doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION].count;
  };
  assert.equal(await count({}), 4);
  assert.equal(await count({ layers: true }), 6);
});

// A quad with two named UV sets, a material and a texture naming one of the sets.
function textured(uvSet) {
  const uv = (index, name) => [
    'LayerElementUV',
    [{ I: index }],
    [
      ['Name', [name]],
      ['MappingInformationType', ['ByPolygonVertex']],
      ['ReferenceInformationType', ['Direct']],
      ['UV', [{ array: 'd', values: [0, 0, 1, 0, 0, 1] }]],
    ],
  ];
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==';
  return new TextEncoder().encode(
    ascii([
      [
        'Objects',
        [],
        [
          [
            'Geometry',
            [L(10), 'Geometry::G', 'Mesh'],
            [
              ['Vertices', [{ array: 'd', values: [0, 0, 0, 1, 0, 0, 0, 1, 0] }]],
              ['PolygonVertexIndex', [{ array: 'i', values: [0, 1, ~2] }]],
              uv(0, 'map1'),
              uv(1, 'lightmap'),
            ],
          ],
          ['Model', [L(100), 'Model::M', 'Mesh']],
          ['Material', [L(200), 'Material::Mat', ''], [['ShadingModel', ['phong']]]],
          [
            'Texture',
            [L(300), 'Texture::T', ''],
            [
              ['FileName', ['t.png']],
              ['Properties70', [], [['P', ['UVSet', 'KString', '', '', uvSet]]]],
            ],
          ],
          ['Video', [L(400), 'Video::V', 'Clip'], [['Content', [png]]]],
        ],
      ],
      [
        'Connections',
        [],
        [
          ['C', ['OO', L(100), L(0)]],
          ['C', ['OO', L(10), L(100)]],
          ['C', ['OO', L(200), L(100)]],
          ['C', ['OP', L(300), L(200), 'DiffuseColor']],
          ['C', ['OO', L(400), L(300)]],
        ],
      ],
    ]),
  );
}

test('a texture that names a UV set samples that set, and the model takes it', async () => {
  const buffer = await convertFBX(textured('lightmap'), { layers: true }),
    { doc, bin } = readGLB(buffer);
  assert.equal(doc.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord, 1);
  const report = await validator.validateBytes(new Uint8Array(buffer));
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
  const engine = await headlessEngine(),
    asset = new GLTFAsset(doc, [bin]);
  assert.ok(new PBRModel(engine, asset));
  // The first set, an unknown name or no option all stay on TEXCOORD_0.
  for (const [name, options] of [
    ['map1', { layers: true }],
    ['default', { layers: true }],
    ['lightmap', {}],
  ]) {
    const { doc: other } = readGLB(await convertFBX(textured(name), options));
    assert.equal(other.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord, undefined, name);
  }
});

test('the worker takes the option', () =>
  headlessModels(async () => {
    const worker = new URL('../dist/workers/fbx.js', import.meta.url),
      input = new Uint8Array(file('blender-layers.fbx')).buffer,
      prepared = await runParseWorker(worker, { input, resourcePath: 'https://example.test/', layers: true }),
      model = modelFromPrepared(await headless(), prepared);
    assert.notEqual(prepared.doc.meshes[0].primitives[0].attributes.TEXCOORD_2, undefined);
    assert.notEqual(prepared.doc.meshes[0].primitives[0].attributes.COLOR_1, undefined);
    assert.ok(model);
  }));
