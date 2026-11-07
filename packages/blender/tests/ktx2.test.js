// KTX2 in .margo: compressMargo turns a real Blender 5.2.3 export's PNG textures (tests/fixtures/bake.margo: baked
// colour, metallic-roughness and normal images) into KTX2 sections, and the KTX2 images transcode back to the PNG's
// pixels within Basis Universal's loss, each in the colour space its material slot reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodePNG } from '@margoengine/decoders/png';
import { nodeKTX2 } from '@margoengine/decoders/image';
import { decodeMargo } from '../dist/index.js';
import { compressMargo, decodeMargoKTX2 } from '../dist/ktx2.js';

const source = await readFile(new URL('./fixtures/bake.margo', import.meta.url));
const plain = decodeMargo(source);
const compressed = await compressMargo(source, { mode: 'uastc' });
const asset = decodeMargoKTX2(compressed);
const table = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return Array.from({ length: view.getUint32(12, true) }, (_, i) => view.getUint32(64 + i * 16, true));
};

test('every PNG section becomes a KTX2 section and the scene keeps its geometry and materials', () => {
  assert.ok(plain.images.length >= 2, 'the fixture has textures');
  assert.deepEqual(table(compressed).filter((t) => t === 4), []);
  assert.equal(table(compressed).filter((t) => t === 8).length, plain.images.length);
  assert.deepEqual(asset.document.images.map((i) => i.mimeType), plain.images.map(() => 'image/ktx2'));
  assert.deepEqual(asset.document.materials, plain.document.materials);
  assert.deepEqual(asset.geometry.map((m) => m.map((p) => [...p.vertices])), plain.geometry.map((m) => m.map((p) => [...p.vertices])));
  for (const bytes of asset.images) assert.deepEqual([...bytes.subarray(0, 12)], [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('each KTX2 image transcodes to its PNG within the codec loss, sRGB for colour and linear for data', async () => {
  const textures = plain.document.textures,
    slot = (index) => {
      const material = plain.document.materials.find((m) =>
        [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture].some((t) => t && textures[t.index].source === index));
      return material.pbrMetallicRoughness?.baseColorTexture && textures[material.pbrMetallicRoughness.baseColorTexture.index].source === index ? 'srgb' : 'linear';
    };
  for (const [index, png] of plain.images.entries()) {
    const want = decodePNG(png), got = await nodeKTX2.transcode(asset.images[index]);
    assert.equal(got.width, want.width);
    assert.equal(got.height, want.height);
    const pixels = got.mipmaps[0].data;
    let error = 0;
    for (let i = 0; i < pixels.length; i++) error += Math.abs(pixels[i] - want.data[i]);
    const mean = error / pixels.length;
    assert.ok(mean < 4, `image ${index} differs by a mean of ${mean} of 255`);
    const header = new DataView(asset.images[index].buffer, asset.images[index].byteOffset);
    // KTX2 data format descriptor transfer function: 2 sRGB, 1 linear.
    const dfd = header.getUint32(48, true), transfer = asset.images[index][dfd + 4 + 10];
    assert.equal(transfer === 2 ? 'srgb' : 'linear', slot(index), `image ${index} colour space`);
  }
});

test('the static reader refuses a KTX2 file by name, and ETC1S is smaller than the PNGs', async () => {
  assert.throws(() => decodeMargo(compressed), /KTX2 textures; load it with parseMargoKTX2 or loadMargoKTX2 from @margoengine\/blender\/ktx2/);
  const small = await compressMargo(source);
  const pngBytes = plain.images.reduce((n, b) => n + b.byteLength, 0),
    ktxBytes = decodeMargoKTX2(small).images.reduce((n, b) => n + b.byteLength, 0);
  assert.ok(ktxBytes < pngBytes, `ETC1S ${ktxBytes} B against PNG ${pngBytes} B`);
});

test('a corrupt KTX2 section and animated or shapes files are refused by name', async () => {
  const broken = new Uint8Array(compressed), view = new DataView(broken.buffer);
  const at = table(compressed).indexOf(8);
  broken[view.getUint32(68 + at * 16, true)] = 0;
  assert.throws(() => decodeMargoKTX2(broken), /Invalid \.margo KTX2 image/);
  await assert.rejects(compressMargo(await readFile(new URL('./fixtures/anim.margo', import.meta.url))), /Animated \.margo/);
  await assert.rejects(compressMargo(await readFile(new URL('./fixtures/curves.margo', import.meta.url))), /curves, point clouds or volumes/);
});
