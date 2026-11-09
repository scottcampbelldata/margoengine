// The third and fourth UV set and the second colour set: glTF only, each in its own accessor, each read by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB } from '../dist/index.js';
import { accessor, readGLB, validate } from './helpers.js';

const triangle = (extra) => ({
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
  ...extra,
});
const scene = (geometry, material) => ({ nodes: [{ name: 'T', geometry, material }] });

test('uvs2, uvs3 and colors1 reach TEXCOORD_2, TEXCOORD_3 and COLOR_1 with their own values', async () => {
  const uvs1 = [0.5, 0.5, 0.75, 0.5, 0.5, 0.75],
    uvs2 = [0.25, 0.25, 0.5, 0.25, 0.25, 0.5],
    uvs3 = [0.75, 0, 1, 0, 0.75, 0.25],
    colors = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1],
    colors1 = [0.5, 0.25, 0.75, 1, 0.5, 0.25, 0.75, 0.5, 0, 0, 0, 0],
    glb = exportGLB(scene(triangle({ uvs1, uvs2, uvs3, colors, colors1 })));
  await validate(glb);
  const { json, bin } = readGLB(glb),
    { attributes } = json.meshes[0].primitives[0];
  assert.deepEqual([...accessor(json, bin, attributes.TEXCOORD_2)], uvs2);
  assert.deepEqual([...accessor(json, bin, attributes.TEXCOORD_3)], uvs3);
  assert.deepEqual([...accessor(json, bin, attributes.COLOR_0)], colors);
  assert.deepEqual([...accessor(json, bin, attributes.COLOR_1)], colors1);
  assert.equal(json.accessors[attributes.COLOR_1].type, 'VEC4');
});

test('colors1 may be rgb, and it is checked as colors is', () => {
  const rgb = [1, 0, 0, 0, 1, 0, 0, 0, 1],
    { json } = readGLB(exportGLB(scene(triangle({ colors1: rgb }))));
  assert.equal(json.accessors[json.meshes[0].primitives[0].attributes.COLOR_1].type, 'VEC3');
  assert.throws(() => exportGLB(scene(triangle({ colors1: [2, 0, 0, 0, 1, 0, 0, 0, 1] }))), /\[0, 1\]/);
  assert.throws(() => exportGLB(scene(triangle({ uvs2: [0, 0] }))), /UVs 2/);
});

test('a texture on set 2 needs uvs2', () => {
  const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==',
    texture = { mimeType: 'image/png', image: Buffer.from(png, 'base64'), texCoord: 2 };
  assert.throws(
    () => exportGLB(scene(triangle(), { baseColorTexture: texture })),
    /texCoord 2 need geometry with uvs2/,
  );
  const { json } = readGLB(exportGLB(scene(triangle({ uvs2: [0, 0, 1, 0, 0, 1] }), { baseColorTexture: texture })));
  assert.equal(json.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord, 2);
});
