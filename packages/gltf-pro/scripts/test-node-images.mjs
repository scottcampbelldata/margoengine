// Real Node binding regression: no canvas image decoder or copyExternalImageToTexture source.
import assert from 'node:assert/strict';
import { create } from 'webgpu';
import { createHeadlessStage } from '@margoengine/headless/stage';
import { readPixels, encodePNG } from '@margoengine/headless';
import { loadGLTF, parseGLTFAsync } from '@margoengine/gltf-pro';
import { materialQuad } from '../../../tests/support/materials-fixture.js';

assert.equal(typeof createImageBitmap, 'undefined');
const gpu = create([]);
using stage = await createHeadlessStage({
  gpu,
  width: 64,
  height: 64,
  camera: { position: [0, 0, 3], target: [0, 0, 0] },
});
const device = stage.engine.gpu,
  errors = [];
device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
device.pushErrorScope('validation');
const { doc, buffers } = materialQuad();
doc.buffers.forEach((d, i) => {
  d.uri = `data:application/octet-stream;base64,${Buffer.from(buffers[i].buffer, buffers[i].byteOffset, buffers[i].byteLength).toString('base64')}`;
});
doc.materials = [{ extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
doc.textures = [{ source: 0 }];
const pictures = [];
for (const color of [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
]) {
  const reference = structuredClone(doc);
  reference.materials[0].pbrMetallicRoughness = { baseColorFactor: color.map((c) => c / 255) };
  delete reference.textures;
  delete reference.images;
  let expected;
  {
    using model = await parseGLTFAsync(stage.engine, reference);
    stage.engine.render({ delta: 0 });
    await device.queue.onSubmittedWorkDone();
    expected = await readPixels(stage.engine);
  }
  const png = await encodePNG({ width: 2, height: 2, data: Uint8Array.from([...color, ...color, ...color, ...color]) });
  doc.images = [{ uri: 'color.png' }];
  using model = await loadGLTF(stage.engine, 'https://example.test/model.gltf', {
    fetch: async (url) => (String(url).endsWith('.gltf') ? Response.json(doc) : new Response(png)),
  });
  assert.deepEqual(Array.from(model.image(0).data.subarray(0, 4)), color);
  stage.engine.render({ delta: 0 });
  await device.queue.onSubmittedWorkDone();
  const image = await readPixels(stage.engine);
  assert.deepEqual(image.data, expected.data, 'decoded primary texture matches the same uniform base colour exactly');
  pictures.push(image.data.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 3));
}
assert.notDeepEqual(pictures[0], pictures[1], 'the two decoded textures draw different colours');
const error = await device.popErrorScope();
assert.equal(error, null);
assert.deepEqual(errors, []);
console.log(
  'Node textured glTF:',
  pictures.map((p) => Array.from(p)),
);
