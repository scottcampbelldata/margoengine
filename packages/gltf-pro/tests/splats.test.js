import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLTFAsset } from '../dist/index.js';
import { gaussianSplats, readGaussianSplats } from '../dist/splats.js';
import { parseSpz } from '../../splats/dist/data.js';
import { glbChunks } from '../../shared/glb.js';

const fixture = (name) => new URL(`fixtures/splats/${name}`, import.meta.url);
const NAME = 'KHR_gaussian_splatting';
const C0 = 0.2820947917738781;

function glb(path) {
  const [json, binary] = glbChunks(new Uint8Array(readFileSync(path)));
  return { doc: JSON.parse(new TextDecoder().decode(json.data)), binary: binary.data };
}
const asset = ({ doc, binary }) => new GLTFAsset(doc, [], binary, { splats: gaussianSplats }, 2 ** 30);

/** A one-primitive file from typed arrays: `attributes` maps a semantic to [data, type, componentType, normalized]. */
function file(attributes, primitive = {}, extension = { kernel: 'ellipse', colorSpace: 'srgb_rec709_display' }) {
  const parts = [],
    accessors = [],
    bufferViews = [],
    ids = {};
  let offset = 0;
  for (const [semantic, [data, type, componentType = 5126, normalized]] of Object.entries(attributes)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType,
      count: data.length / width,
      type,
      ...(normalized ? { normalized } : {}),
    });
    ids[semantic] = accessors.length - 1;
    parts.push(bytes);
    offset += bytes.length;
    // The next accessor starts on a multiple of its component size.
    const pad = (4 - (offset % 4)) % 4;
    if (pad) parts.push(new Uint8Array(pad));
    offset += pad;
  }
  const buffer = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    buffer.set(part, at);
    at += part.length;
  }
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: [NAME],
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
    meshes: [{ primitives: [{ attributes: ids, mode: 0, extensions: { [NAME]: extension }, ...primitive }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
  return new GLTFAsset(doc, [buffer], undefined, { splats: gaussianSplats });
}
const f32 = (...values) => new Float32Array(values);
const base = () => ({
  POSITION: [f32(1, 2, 3), 'VEC3'],
  [`${NAME}:ROTATION`]: [f32(0, 0, 0, 1), 'VEC4'],
  [`${NAME}:SCALE`]: [f32(1, 2, 3), 'VEC3'],
  [`${NAME}:OPACITY`]: [f32(0.5), 'SCALAR'],
  [`${NAME}:SH_DEGREE_0_COEF_0`]: [f32(0, 0, 0), 'VEC3'],
});
const read = (a) => readGaussianSplats(a, a.doc.meshes[0].primitives[0]);

test('a real SPZ-compressed glTF from CesiumJS reads exactly like its SPZ payload', async () => {
  const a = asset(glb(fixture('sh_unit_cube.glb'))),
    primitive = a.doc.meshes[0].primitives[0],
    data = await readGaussianSplats(a, primitive),
    payload = await parseSpz(
      a.view(primitive.extensions[NAME].extensions.KHR_gaussian_splatting_compression_spz_2.bufferView),
    );
  assert.equal(data.positions.length / 3, 27);
  assert.equal(data.sphericalHarmonics.length / 27 / 3, 16);
  assert.deepEqual(data, payload);
});

test('a real uncompressed glTF from the godot-gsplat sample reads opacity and linear colour', async () => {
  const doc = JSON.parse(readFileSync(fixture('minimal_point.gltf'), 'utf8')),
    a = new GLTFAsset(doc, [readFileSync(fixture('minimal_point.bin'))], undefined, { splats: gaussianSplats }),
    primitive = doc.meshes[0].primitives[0],
    data = await readGaussianSplats(a, primitive),
    attribute = (name) => a.accessor(primitive.attributes[`${NAME}:${name}`]);
  assert.equal(data.positions.length, 3);
  // lin_rec709_display: colour is 0.5 + C0 x SH, with no sRGB decode. Float32 of the colour: 2^-24 at 1.
  const sh = attribute('SH_DEGREE_0_COEF_0');
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(data.colors[c] - Math.min(1, Math.max(0, 0.5 + C0 * sh[c]))) < 2 ** -23);
  assert.equal(data.colors[3], attribute('OPACITY')[0]);
});

test('the real tower capture reads whole when the sample is present', async (t) => {
  const folder = process.env.MARGO_SPLAT_SAMPLES;
  if (!folder) return t.skip('set MARGO_SPLAT_SAMPLES to a folder holding tower.glb (fixtures/splats/NOTICE.md)');
  const path = join(folder, 'tower.glb');
  assert.ok(existsSync(path), path);
  const a = asset(glb(path)),
    data = await readGaussianSplats(a, a.doc.meshes[0].primitives[0]);
  assert.equal(data.positions.length / 3, 286868);
});

test('attributes become SplatData: quaternions are x y z w, scales linear, SH bands in order', async () => {
  const turn = Math.SQRT1_2,
    data = await read(
      file({
        ...base(),
        [`${NAME}:ROTATION`]: [f32(0, 0, turn, turn), 'VEC4'],
        [`${NAME}:SH_DEGREE_1_COEF_0`]: [f32(1, 2, 3), 'VEC3'],
        [`${NAME}:SH_DEGREE_1_COEF_1`]: [f32(4, 5, 6), 'VEC3'],
        [`${NAME}:SH_DEGREE_1_COEF_2`]: [f32(7, 8, 9), 'VEC3'],
      }),
    );
  assert.deepEqual([...data.positions], [1, 2, 3]);
  // A quarter turn about z swaps x and y: variances 4, 1, 9 from scales 1, 2, 3. Float32 of 9: 2^-20; of the quaternion
  // read back: the same order. 1e-5 holds both.
  const [xx, xy, xz, yy, yz, zz] = data.covariances;
  for (const [got, want] of [
    [xx, 4],
    [xy, 0],
    [xz, 0],
    [yy, 1],
    [yz, 0],
    [zz, 9],
  ])
    assert.ok(Math.abs(got - want) < 1e-5, `${got} is ${want}`);
  assert.equal(data.colors[3], 0.5);
  // 4 coefficients a channel, channel innermost; sRGB display colour turns linear to first order, by the curve's slope at 0.5.
  assert.equal(data.sphericalHarmonics.length, 12);
  const slope = (2.4 / 1.055) * ((0.5 + 0.055) / 1.055) ** 1.4;
  [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((v, i) => assert.ok(Math.abs(data.sphericalHarmonics[3 + i] - v * slope) < 1e-5));
});

test('quantized accessors read as the extension defines them', async () => {
  const data = await read(
    file({
      POSITION: [f32(0, 0, 0), 'VEC3'],
      [`${NAME}:ROTATION`]: [new Int8Array([0, 0, 0, 127]), 'VEC4', 5120, true],
      [`${NAME}:SCALE`]: [new Uint8Array([2, 4, 8]), 'VEC3', 5121],
      [`${NAME}:OPACITY`]: [new Uint16Array([65535]), 'SCALAR', 5123, true],
      [`${NAME}:SH_DEGREE_0_COEF_0`]: [f32(0, 0, 0), 'VEC3'],
    }),
  );
  assert.equal(data.colors[3], 1);
  // Uint8 scale is not normalized: 2, 4, 8, so variances 4, 16, 64, exact in Float32.
  assert.deepEqual([data.covariances[0], data.covariances[3], data.covariances[5]], [4, 16, 64]);
});

test('files the extension forbids are refused, naming the fault', async () => {
  await assert.rejects(read(file(base(), { mode: 4 })), /mode must be POINTS/);
  const noScale = base();
  delete noScale[`${NAME}:SCALE`];
  await assert.rejects(read(file(noScale)), /SCALE is missing/);
  await assert.rejects(
    read(file({ ...base(), [`${NAME}:SH_DEGREE_0_COEF_0`]: [new Uint8Array([1, 2, 3]), 'VEC3', 5121] })),
    /SH_DEGREE_0_COEF_0: componentType 5121/,
  );
  await assert.rejects(
    read(file({ ...base(), [`${NAME}:SH_DEGREE_1_COEF_0`]: [f32(1, 2, 3), 'VEC3'] })),
    /spherical harmonics degree 1/,
  );
  const band = (degree, size) =>
    Object.fromEntries(
      Array.from({ length: size }, (_, n) => [`${NAME}:SH_DEGREE_${degree}_COEF_${n}`, [f32(1, 2, 3), 'VEC3']]),
    );
  await assert.rejects(read(file({ ...base(), ...band(2, 5) })), /spherical harmonics degree 2/);
  await assert.rejects(
    read(file({ ...base(), [`${NAME}:OPACITY`]: [f32(0.5, 0.5), 'SCALAR'] })),
    /count differs from POSITION/,
  );
  await assert.rejects(read(file(base(), {}, { kernel: 'quadratic' })), (e) => e.code === 'unsupported');
  await assert.rejects(read(file(base(), {}, { colorSpace: 'display_p3' })), (e) => e.code === 'unsupported');
});

test('colour spaces: sRGB decodes to linear, linear stays', async () => {
  const srgb = await read(file(base(), {}, { colorSpace: 'srgb_rec709_display' })),
    lin = await read(file(base(), {}, { colorSpace: 'lin_rec709_display' }));
  assert.equal(lin.colors[0], 0.5);
  // sRGB 0.5 is 0.21404 linear.
  assert.ok(Math.abs(srgb.colors[0] - 0.21404) < 1e-4);
});

test('a required splat extension needs the reader', () => {
  const doc = { asset: { version: '2.0' }, extensionsRequired: [NAME], buffers: [] };
  assert.throws(() => new GLTFAsset(doc, []), /KHR_gaussian_splatting \(pass a splats decoder\)/);
  assert.ok(new GLTFAsset(doc, [], undefined, { splats: gaussianSplats }));
});
