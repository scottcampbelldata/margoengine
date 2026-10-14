// HANDOFF 1f.j: parseFBXInWorker's worker (dist/workers/fbx.js) + modelFromPrepared build the same model as parseFBX,
// compared byte for byte (see tests/support/pbr-snapshot.js for what is compared).
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFBX} from '../dist/index.js';
import {modelFromPrepared} from '../../gltf-pro/dist/worker.js';
import {ascii, binary, grid, rich, L} from './fixtures.js';
import {runParseWorker, assertSameBytes} from '../../../tests/support/parse-worker.js';
import {headless, headlessModels, snapshot} from '../../../tests/support/pbr-snapshot.js';

const worker = new URL('../dist/workers/fbx.js', import.meta.url);
// Two meshes, each with a Phong material whose diffuse map is an embedded (fake) PNG.
function textured() {
  const objects = [], links = [];
  for (let i = 0; i < 2; i++) {
    objects.push(['Geometry', [L(10 + i), 'Geometry::G' + i, 'Mesh'], [['Vertices', [{array: 'd', values: [0, 0, i, 1, 0, i, 0, 1, i]}]], ['PolygonVertexIndex', [{array: 'i', values: [0, 1, ~2]}]],
      ['LayerElementUV', [{I: 0}], [['MappingInformationType', ['ByPolygonVertex']], ['ReferenceInformationType', ['Direct']], ['UV', [{array: 'd', values: [0, 0, 1, 0, 0, 1]}]]]]]],
    ['Model', [L(100 + i), 'Model::M' + i, 'Mesh']], ['Material', [L(200 + i), 'Material::Mat' + i, ''], [['ShadingModel', ['phong']]]], ['Texture', [L(300 + i), 'Texture::T' + i, ''], [['FileName', ['tex' + i + '.png']]]],
    ['Video', [L(400 + i), 'Video::V' + i, 'Clip'], [['RelativeFilename', ['tex' + i + '.png']], ['Content', [Buffer.from([137, 80, 78, 71, i]).toString('base64')]]]]);
    links.push(['C', ['OO', L(100 + i), L(0)]], ['C', ['OO', L(10 + i), L(100 + i)]], ['C', ['OO', L(200 + i), L(100 + i)]], ['C', ['OP', L(300 + i), L(200 + i), 'DiffuseColor']], ['C', ['OO', L(400 + i), L(300 + i)]]);
  }
  return new TextEncoder().encode(ascii([['Objects', [], objects], ['Connections', [], links]]));
}
for (const [name, file] of [
  ['rich binary with zlib arrays (pivots, skin, blend shape, clips)', () => binary(rich({morphAnimation: true}), {compress: true})],
  ['ASCII with embedded textures', textured],
  ['128 x 128 quad grid, binary', () => binary(grid(128), {compress: true})],
]) test(`worker-parsed FBX equals parseFBX: ${name}`, () => headlessModels(async () => {
  const bytes = new Uint8Array(file());
  const main = await parseFBX(await headless(), bytes.slice());
  const prepared = await runParseWorker(worker, {input: bytes.slice().buffer, resourcePath: 'https://example.test/'});
  assertSameBytes(snapshot(modelFromPrepared(await headless(), prepared)), snapshot(main));
}));

test('FBX worker errors keep their type and message', () => headlessModels(async () => {
  await assert.rejects(runParseWorker(worker, {input: new Uint8Array(8).buffer, resourcePath: 'https://example.test/'}), {name: 'RangeError', message: 'Invalid FBX byte budget'});
}));
