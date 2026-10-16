// HANDOFF 1f.j: parseFBXInWorker's worker (dist/workers/fbx.js) + modelFromPrepared build the same model as parseFBX,
// compared byte for byte (see tests/support/pbr-snapshot.js for what is compared).
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { rigFixture } from './native-scene-helper.js';
import assert from 'node:assert/strict';
import { parseFBX } from '../dist/index.js';
import { modelFromPrepared } from '../../gltf-pro/dist/worker.js';
import { ascii, binary, grid, rich, L } from './fixtures.js';
import { runParseWorker, assertSameBytes } from '../../../tests/support/parse-worker.js';
import { headless, headlessModels, snapshot } from '../../../tests/support/pbr-snapshot.js';

const worker = new URL('../dist/workers/fbx.js', import.meta.url);
// Two meshes, each with a Phong material and an embedded valid PNG.
function textured() {
  const objects = [],
    links = [];
  for (let i = 0; i < 2; i++) {
    objects.push(
      [
        'Geometry',
        [L(10 + i), 'Geometry::G' + i, 'Mesh'],
        [
          ['Vertices', [{ array: 'd', values: [0, 0, i, 1, 0, i, 0, 1, i] }]],
          ['PolygonVertexIndex', [{ array: 'i', values: [0, 1, ~2] }]],
          [
            'LayerElementUV',
            [{ I: 0 }],
            [
              ['MappingInformationType', ['ByPolygonVertex']],
              ['ReferenceInformationType', ['Direct']],
              ['UV', [{ array: 'd', values: [0, 0, 1, 0, 0, 1] }]],
            ],
          ],
        ],
      ],
      ['Model', [L(100 + i), 'Model::M' + i, 'Mesh']],
      ['Material', [L(200 + i), 'Material::Mat' + i, ''], [['ShadingModel', ['phong']]]],
      ['Texture', [L(300 + i), 'Texture::T' + i, ''], [['FileName', ['tex' + i + '.png']]]],
      [
        'Video',
        [L(400 + i), 'Video::V' + i, 'Clip'],
        [
          ['RelativeFilename', ['tex' + i + '.png']],
          [
            'Content',
            [
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==',
            ],
          ],
        ],
      ],
    );
    links.push(
      ['C', ['OO', L(100 + i), L(0)]],
      ['C', ['OO', L(10 + i), L(100 + i)]],
      ['C', ['OO', L(200 + i), L(100 + i)]],
      ['C', ['OP', L(300 + i), L(200 + i), 'DiffuseColor']],
      ['C', ['OO', L(400 + i), L(300 + i)]],
    );
  }
  return new TextEncoder().encode(
    ascii([
      ['Objects', [], objects],
      ['Connections', [], links],
    ]),
  );
}
for (const [name, file] of [
  ['real Blender binary rig', () => readFileSync(new URL('./fixtures/blender-rig.fbx', import.meta.url))],
  ['ASCII rig with skin, morph, geometric transform and animation', () => new TextEncoder().encode(rigFixture())],
  ['ASCII with embedded textures', textured],
  ['128 x 128 quad grid, binary', () => binary(grid(128), { compress: true })],
])
  test(`worker-parsed FBX equals parseFBX: ${name}`, () =>
    headlessModels(async () => {
      const bytes = new Uint8Array(file());
      const main = await parseFBX(await headless(), bytes.slice());
      const prepared = await runParseWorker(worker, {
        input: bytes.slice().buffer,
        resourcePath: 'https://example.test/',
      });
      assertSameBytes(snapshot(modelFromPrepared(await headless(), prepared)), snapshot(main));
    }));

test('FBX worker errors keep their type and message', () =>
  headlessModels(async () => {
    await assert.rejects(
      runParseWorker(worker, { input: new Uint8Array(8).buffer, resourcePath: 'https://example.test/' }),
      { name: 'RangeError', message: 'Invalid FBX byte budget' },
    );
  }));

test('FBX worker preserves unsupported inheritance errors from the native parser', () =>
  headlessModels(async () => {
    const scene = rich({ morphAnimation: true });
    const properties = scene
      .find(([name]) => name === 'GlobalSettings')[2]
      .find(([name]) => name === 'Properties70')[2];
    properties.push(
      ['P', ['FrontAxis', 'int', 'Integer', '', { I: 1 }]],
      ['P', ['FrontAxisSign', 'int', 'Integer', '', { I: -1 }]],
    );
    const input = new Uint8Array(binary(scene, { compress: true }));
    await assert.rejects(parseFBX(await headless(), input.slice()), /unsupported InheritType/);
    await assert.rejects(
      runParseWorker(worker, { input: input.slice().buffer, resourcePath: 'https://example.test/' }),
      /unsupported InheritType/,
    );
  }));
