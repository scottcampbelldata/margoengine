import test from 'node:test';
import assert from 'node:assert/strict';
import { convertFBX } from '../dist/index.js';
import { textures } from '../dist/textures.js';
import { pbrMaterials } from '../dist/pbr.js';
import { textureFileToRGBA } from '@margoengine/decoders/texture-rgba';
import { parseDDS } from '@margoengine/decoders/dds';
import { decodePNG } from '@margoengine/decoders/png';
import { readGLB } from './native-scene-helper.js';
import { files, fixture } from './texture-helper.js';
const bmp = files.bmp;
for (const [name, bytes] of Object.entries(files))
  for (const embedded of [true, false])
    test(`FBX ${name} ${embedded ? 'embedded' : 'external'} becomes exact PNG pixels`, async () => {
      const { doc, bin } = readGLB(
        await convertFBX(fixture(name, embedded ? bytes : undefined), {
          extensions: [textures],
          resourcePath: 'https://example.com/',
          fetch: async () => new Response(bytes),
        }),
      );
      const image = doc.images[doc.textures[doc.materials[0].pbrMetallicRoughness.baseColorTexture.index].source],
        view = doc.bufferViews[image.bufferView];
      const decoded = decodePNG(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength));
      for (let i = 0; i < decoded.data.length; i += 4)
        assert.deepEqual([...decoded.data.subarray(i, i + 4)], [255, 0, 0, 255]);
      assert.equal(doc.materials[0].extras?.fbxMissingTextures, undefined);
    });
test('texture converters compose with PBR in either extension order', async () => {
  for (const extensions of [
    [pbrMaterials, textures],
    [textures, pbrMaterials],
  ]) {
    const { doc } = readGLB(await convertFBX(fixture('bmp', bmp), { extensions }));
    assert.equal(doc.images.length, 1);
  }
});
test('recognized damaged texture rejects instead of being dropped', async () => {
  await assert.rejects(convertFBX(fixture('bmp', new Uint8Array([66, 77])), { extensions: [textures] }), /truncated/);
});

test('texture RGBA entry shares the exact DDS decode used by the bridge', async () => {
  assert.deepEqual([...(await textureFileToRGBA(parseDDS(files.dds))).data.subarray(0, 4)], [255, 0, 0, 255]);
});
