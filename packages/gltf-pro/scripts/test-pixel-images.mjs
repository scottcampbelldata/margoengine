import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { encodePNG } from '@margoengine/headless';
import { decodePNG } from '../../../tests/support/png.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';

const { doc, buffers } = materialQuad();
doc.buffers.forEach((d, i) => {
  d.uri = `data:application/octet-stream;base64,${Buffer.from(buffers[i].buffer, buffers[i].byteOffset, buffers[i].byteLength).toString('base64')}`;
});
const bytes = await encodePNG({
  width: 2,
  height: 2,
  data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255),
});
doc.images = [{ uri: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` }];
doc.textures = [{ source: 0 }];
doc.materials = [{ extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (e) => errors.push(e.message));
    const result = await browser.page.evaluate(async (doc) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js');
      const { decodePNG } = await import('/packages/decoders/dist/png.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 3], target: [0, 0, 0] },
      });
      const pictures = [];
      engine.gpu.pushErrorScope('validation');
      try {
        for (const raw of [false, true]) {
          const bytes = (uri) => Uint8Array.from(atob(uri.split(',')[1]), (c) => c.charCodeAt(0));
          const model = raw
            ? await parseGLTFAsync(
                engine,
                doc,
                doc.buffers.map((b) => bytes(b.uri)),
                [await decodePNG(bytes(doc.images[0].uri))],
              )
            : await parseGLTFAsync(engine, doc);
          try {
            if (raw && !('data' in model.image(0))) throw new Error('pixel decoder was not used');
            await waitForPipelines(async () => {
              engine.render({ delta: 0 });
              await engine.gpu.queue.onSubmittedWorkDone();
            });
            pictures.push(canvas.toDataURL('image/png'));
            model.onDeviceRestored(engine);
            await waitForPipelines(async () => {
              engine.render({ delta: 0 });
              await engine.gpu.queue.onSubmittedWorkDone();
            });
            pictures.push(canvas.toDataURL('image/png'));
          } finally {
            model.dispose();
          }
        }
        return { pictures, validation: (await engine.gpu.popErrorScope())?.message ?? null };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    }, doc);
    assert.deepEqual(errors, []);
    assert.equal(result.validation, null);
    const images = await Promise.all(result.pictures.map((p) => decodePNG(Buffer.from(p.split(',')[1], 'base64'))));
    for (const image of images.slice(1))
      assert.deepEqual(image.data, images[0].data, 'bitmap, pixel upload and restored models draw identical pixels');
    assert.ok(new Set(images[0].data).size > 20, 'the textured quad drew nonuniform colours');
    console.log('Pixel image uploads match browser bitmaps and survive restoration');
  },
  () => browser.close(),
);
