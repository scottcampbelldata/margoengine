// EXT_lights_ies and EXT_lights_image_based: real files read as they state, the frames, and what is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIES, iesCandela } from '../../clustered/dist/ies.js';
import { gltfIESLights, gltfImageLight, orientIES, placeIESLights, rotateCube } from '../dist/lights.js';
import { cubeDocument, dataURI, pngOf } from './support/cube-png.js';

const file = (name) => new URL(`./fixtures/lights/${name}`, import.meta.url),
  json = (name) => JSON.parse(readFileSync(file(name), 'utf8')),
  profileText = readFileSync(file('LightProfile.ies'), 'latin1');
const base64 = (uri) => new Uint8Array(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'));
/** What the two readers use of a loaded model. */
const modelOf = (doc, baseURL) => ({
  asset: { doc, baseURL, buffers: (doc.buffers ?? []).map((buffer) => base64(buffer.uri ?? ',')) },
  nodes: (doc.nodes ?? []).map(() => ({})),
});
const fetchFixture = async (url) => new Response(readFileSync(file(String(url).split('/').pop())));
const near = (a, b, bound, message) => assert.ok(Math.abs(a - b) <= bound, `${message}: ${a} against ${b}`);
const axes = (x, y, z) => [x, y, z];

test('the real Example.gltf reads the same by uri and by bufferView, with the candela the file states', async () => {
  const byName = await gltfIESLights(modelOf(json('Example.gltf'), 'https://example.test/lights/'), {
      fetch: fetchFixture,
    }),
    byView = await gltfIESLights(modelOf(json('Example_bufferView.gltf')));
  for (const lights of [byName, byView]) {
    assert.equal(lights.length, 1);
    assert.equal(lights[0].nodeIndex, 2);
    assert.equal(lights[0].multiplier, 1);
    assert.deepEqual(lights[0].color, [0.181, 0.485, 0]);
    assert.equal(lights[0].profile.format, 'IES:LM-63-2019');
    // The file's largest value, with its 1.10001 file generation type left out of the candela.
    assert.equal(lights[0].profile.peak, 8500);
    assert.equal(iesCandela(lights[0].profile, 30, 0), 5250);
  }
});

test('a file with neither extension loads no light and asks for no file', async () => {
  const fail = async () => assert.fail('fetched');
  assert.deepEqual(await gltfIESLights(modelOf({ nodes: [{}] }), { fetch: fail }), []);
  assert.equal(await gltfImageLight(modelOf({ scenes: [{}] }), { fetch: fail }), undefined);
});

test('multiplier and color reach the light, color clamped to 0 to 1 as the extension states', async () => {
  const doc = json('Example_bufferView.gltf');
  Object.assign(doc.nodes[2].extensions.EXT_lights_ies, { multiplier: 2.5, color: [-1, 0.5, 3] });
  const [light] = await gltfIESLights(modelOf(doc));
  assert.equal(light.multiplier, 2.5);
  assert.deepEqual(light.color, [0, 0.5, 1]);
});

test('orientIES puts the beam where the node aims it: the file frame is -Z', () => {
  const profile = parseIES(profileText);
  // A clustered point light reads its grid at (sin t cos p, -cos t, -sin t sin p): theta 90 and phi 90 is -Z.
  const seen = orientIES(profile, iesCandela, axes([1, 0, 0], [0, 1, 0], [0, 0, 1]));
  near(iesCandela(seen, 90, 90), 8500, 1e-9, 'the beam on the node -Z');
  near(iesCandela(seen, 60, 90), 5250, 1e-9, 'thirty degrees off the beam');
  assert.equal(iesCandela(seen, 90, 270), 0, 'behind the fixture');
  // The real file's node, -90 degrees about X: its Y is world -Z and its Z is world +Y, so the beam falls straight down.
  const down = orientIES(profile, iesCandela, axes([1, 0, 0], [0, 0, -1], [0, 1, 0]));
  near(iesCandela(down, 0, 0), 8500, 1e-9, 'straight down');
  near(iesCandela(down, 30, 45), 5250, 1e-9, 'any plane of a symmetric file');
  assert.equal(iesCandela(down, 180, 0), 0, 'straight up');
  // An uplight: past the hemisphere a spot cone reaches from the light's down axis.
  const up = orientIES(profile, iesCandela, axes([1, 0, 0], [0, 0, 1], [0, -1, 0]));
  near(iesCandela(up, 180, 0), 8500, 1e-9, 'an uplight keeps its beam');
});

test('orientIES keeps plane 0 on the node +X and plane 90 on the node +Y', () => {
  // Candela by plane alone: 100 on plane 0 and 180, 190 on plane 90, written for a full half circle.
  const angles = Array.from({ length: 19 }, (_, i) => i * 10),
    profile = parseIES(
      [
        'IESNA:LM-63-2002',
        'TILT=NONE',
        '1 -1 1 19 19 1 2 0 0 0',
        '1 1 0',
        angles.join(' '),
        angles.join(' '),
        ...angles.map((phi) => angles.map(() => 100 + Math.min(phi, 180 - phi)).join(' ')),
      ].join('\n'),
    ),
    seen = orientIES(profile, iesCandela, axes([1, 0, 0], [0, 1, 0], [0, 0, 1]));
  // The light grid's theta 90, phi 0 is world +X; theta 180 is world +Y; theta 0 is world -Y, plane 270 mirrored to 90.
  near(iesCandela(seen, 90, 0), 100, 1e-9, 'node +X');
  near(iesCandela(seen, 180, 0), 190, 1e-9, 'node +Y');
  near(iesCandela(seen, 0, 0), 190, 1e-9, 'node -Y');
});

const uniform = (values) => ({
  size: 2,
  faces: values.map((v) => Float32Array.from({ length: 16 }, (_, i) => (i % 4 === 3 ? 1 : v))),
});
const faceValues = (cube) => cube.faces.map((face) => face[0]);
test('rotateCube turns the environment by the quaternion: what lay along d comes to lie along q d', () => {
  const cube = uniform([1, 2, 3, 4, 5, 6]),
    s = Math.SQRT1_2;
  assert.equal(rotateCube(cube, [0, 0, 0, 1]), cube);
  // Half a turn about Y swaps X and Z with their opposites; Y stays.
  assert.deepEqual(faceValues(rotateCube(cube, [0, 1, 0, 0])), [2, 1, 3, 4, 6, 5]);
  // A quarter about Y carries +Z to +X and +X to -Z.
  assert.deepEqual(faceValues(rotateCube(cube, [0, s, 0, s])), [5, 6, 3, 4, 2, 1]);
  // A quarter about X carries +Y to +Z.
  assert.deepEqual(faceValues(rotateCube(cube, [s, 0, 0, s])), [1, 2, 6, 5, 3, 4]);
});

const docOf = (cube) => ({
  images: cube.images,
  scenes: [{ extensions: { EXT_lights_image_based: { light: 0 } } }],
  extensions: { EXT_lights_image_based: { lights: [cube.light] } },
});
test('a cube face reads as the sRGB decode of rgb / alpha, its saved rows swapped', async () => {
  // Saved top row: 128 / 128 is 1. Saved bottom row: 51 / 255 is 0.2, whose sRGB decode is 0.0331.
  const png = pngOf(2, (x, y) => (y === 0 ? [128, 128, 128, 128] : [51, 51, 51, 255])),
    cube = cubeDocument(Array(6).fill([0, 0, 0, 255]), { size: 2 });
  for (const image of cube.images) image.uri = dataURI(png);
  const { faces: cubeFaces } = await gltfImageLight(modelOf(docOf(cube))),
    { faces } = cubeFaces;
  near(faces[0][0], 0.0331, 1e-3, 'the first row is the saved last row');
  near(faces[0][8], 1, 1e-6, 'rgb / alpha');
  assert.equal(faces[0][3], 1);
});

test('the light carries its intensity and rotation, and the cube already turned', async () => {
  const s = Math.SQRT1_2,
    black = [0, 0, 0, 255],
    cube = cubeDocument([[255, 255, 255, 255], black, black, black, black, black], {
      rotation: [0, s, 0, s],
      intensity: 3,
    }),
    light = await gltfImageLight(modelOf(docOf(cube)));
  assert.equal(light.intensity, 3);
  assert.deepEqual(light.rotation, [0, s, 0, s]);
  // A quarter about Y carries +X to -Z.
  assert.equal(light.faces.faces[5][0], 1);
  assert.equal(light.faces.faces[0][0], 0);
  assert.equal(light.irradianceCoefficients.length, 9);
});

test('what a file gets wrong is refused', async () => {
  const ies = (edit) => {
    const doc = json('Example_bufferView.gltf');
    edit(doc);
    return gltfIESLights(modelOf(doc));
  };
  const node = (doc) => doc.nodes[2].extensions.EXT_lights_ies,
    example = () => modelOf(json('Example.gltf'), 'https://example.test/');
  await assert.rejects(ies((doc) => (node(doc).light = 4)), /light index/);
  await assert.rejects(ies((doc) => delete node(doc).light), /light index/);
  await assert.rejects(ies((doc) => (node(doc).multiplier = -1)), /multiplier/);
  await assert.rejects(ies((doc) => (node(doc).color = [1, 1])), /color/);
  await assert.rejects(ies((doc) => delete doc.extensions.EXT_lights_ies.lights[0].mimeType), /mimeType/);
  await assert.rejects(ies((doc) => delete doc.extensions.EXT_lights_ies), /no lights/);
  await assert.rejects(gltfIESLights(modelOf(json('Example.gltf'))), /no base URL; pass baseURL/);
  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(gltfIESLights(example(), { fetch: missing }), /answered 404/);
  const typeA = async () => new Response(profileText.replace('10 1 1 1', '10 1 3 1'));
  await assert.rejects(gltfIESLights(example(), { fetch: typeA }), /type A/);
  const image = (edit) => {
    const cube = cubeDocument(Array(6).fill([0, 0, 0, 255]));
    edit(cube.light, cube);
    return gltfImageLight(modelOf(docOf(cube)));
  };
  await assert.rejects(image((light) => (light.specularImages = [[0, 1]])), /specular images/);
  await assert.rejects(image((light) => (light.specularImageSize = 3)), /specular images/);
  await assert.rejects(image((light) => (light.specularImageSize = 8)), /specularImageSize square/);
  await assert.rejects(image((light) => (light.irradianceCoefficients = [])), /irradiance/);
  await assert.rejects(image((light) => (light.rotation = [0, 0, 0, 2])), /rotation/);
  await assert.rejects(image((light) => (light.intensity = -1)), /intensity/);
  await assert.rejects(image((light, cube) => (cube.images.length = 2)), /image index/);
});

test('two unnamed profiles of one format aimed alike keep their own candela (batch 132)', () => {
  // Both profiles have the default name "" and the same LM-63 format line; the aimed-profile cache once keyed on
  // format + name + aim, so the second fixture drew the first profile's beam at the first one's intensity.
  const bright = parseIES(profileText),
    dim = parseIES(profileText.replace(/8500/g, '4250')),
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    light = (profile, nodeIndex) => ({ name: '', profile, nodeIndex, multiplier: 1, color: [1, 1, 1] });
  assert.equal(bright.format, dim.format);
  assert.deepEqual([bright.peak, dim.peak], [8500, 5250]);
  const { fixtures, profiles } = placeIESLights([light(bright, 0), light(dim, 1)], () => identity, iesCandela);
  near(fixtures[0].intensity, bright.peak, 1e-6, 'the first fixture');
  near(fixtures[1].intensity, dim.peak, 1e-6, 'the second fixture');
  assert.notEqual(profiles[0], profiles[1]);
  // One profile on two nodes aimed alike still shares a single aimed profile.
  const shared = placeIESLights([light(bright, 0), light(bright, 1)], () => identity, iesCandela);
  assert.equal(shared.profiles[0], shared.profiles[1]);
});
