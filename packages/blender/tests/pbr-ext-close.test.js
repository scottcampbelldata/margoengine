// @margoengine/blender/pbr-ext: images decoded while the physical shader's import fails are closed, not leaked.
// A module hook makes the shader chunk fail to load, and a counting createImageBitmap stands in for the browser's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleHooks } from '../../../scripts/support/node-compat.mjs';

// The rule's message reaching the caller shows the shader import went through the failing hook.
await moduleHooks([
  {
    pattern: String.raw`^@margoengine/gltf/extended-materials$`,
    parent: '/dist/pbr-ext.js',
    error: 'shader chunk failed to load',
  },
]);

const { parseMargoPBR } = await import('../dist/pbr-ext.js');
const { decodeMargo } = await import('../dist/index.js');
const bytes = await readFile(new URL('./fixtures/pbr-ext.margo', import.meta.url));

test('a failed shader import closes every decoded image', async (t) => {
  t.after(() => delete globalThis.createImageBitmap);
  const pngCount = decodeMargo(bytes).images.length;
  assert.ok(pngCount > 0, 'the fixture carries at least one image');
  const opened = [];
  // createImageBitmap does not exist in Node; this one counts what it opens and closes.
  globalThis.createImageBitmap = async (blob) => {
    const header = new DataView(await blob.arrayBuffer());
    const image = { width: header.getUint32(16), height: header.getUint32(20), closed: 0 };
    image.close = () => image.closed++;
    opened.push(image);
    return image;
  };
  await assert.rejects(parseMargoPBR({}, bytes), /shader chunk failed to load/);
  assert.equal(opened.length, pngCount, 'every image was decoded before the rejection settled');
  assert.deepEqual(
    opened.map((image) => image.closed),
    opened.map(() => 1),
    'each decoded image is closed once',
  );
});
