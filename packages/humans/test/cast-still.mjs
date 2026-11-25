// Real-GPU check of @margoengine/humans/cast (WebGPU, or the WebGL2 compatibility layer with MARGO_COMPAT=1): the
// 1910 ranger's outfit, written by outfitGLB, loads through gltf/pbr (its physical path draws KHR_materials_sheen),
// takes materials' install, and draws without a GPU error; the garments fill the frame and the cloth sheen changes the
// picture against the same file with the sheen taken out. Garments only: no body is
// drawn (a person comes from addPerson). The frames go to test-results/cast-still/ for review. From the repository root
// after building packages:
//   node packages/humans/test/cast-still.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/humans/test/person-still.html', port: 'free' }),
  { page } = browser,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
console.log('device', browser.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
  const frame = (sheen) =>
    page.evaluate(async (sheen) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { parseGLTFAsync } = await import('/packages/gltf/dist/pbr.js');
      const { install } = await import('/packages/materials/dist/index.js');
      const { outfitGLB, OUTFITS } = await import('/packages/humans/dist/cast.js');
      const canvas = document.querySelector('canvas');
      const engine = await Engine.create(canvas, {
        camera: { position: [0.9, 1.25, 3.2], target: [0, 0.95, 0], fov: 38, near: 0.05, far: 100 },
      });
      engine.stop();
      const errors = [];
      engine.gpu?.addEventListener?.('uncapturederror', (e) => errors.push(e.error.message));
      engine.scene.background = '#30333a';
      engine.lighting.direction.set([0.5, 0.6, 0.62, 3]);
      engine.lighting.radiance.set([1, 0.95, 0.88, 0.45]);
      let glb = outfitGLB(OUTFITS['ranger-1910']);
      if (!sheen) {
        // The same file without the sheen: rewrite the JSON chunk, padded with spaces to the same length.
        const view = new DataView(glb.buffer),
          length = view.getUint32(12, true),
          doc = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
        for (const m of doc.materials) delete m.extensions;
        delete doc.extensionsUsed;
        const text = new TextEncoder().encode(JSON.stringify(doc)),
          copy = glb.slice();
        copy.fill(0x20, 20, 20 + length);
        copy.set(text, 20);
        glb = copy;
      }
      const model = await parseGLTFAsync(engine, glb);
      install(model);
      for (let i = 0; i < 3; i++) {
        engine.render({ delta: 1 / 30 });
        await engine.gpu?.queue?.onSubmittedWorkDone?.();
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const bytes = [...new Uint8Array(await blob.arrayBuffer())];
      engine.dispose();
      return { bytes, errors, garments: model.primitives.map((p) => p.material?.name) };
    }, sheen);
  const plain = await frame(false),
    cloth = await frame(true);
  assert.deepEqual(plain.errors, []);
  assert.deepEqual(cloth.errors, []);
  assert.deepEqual(cloth.garments, ['shirt', 'boots', 'hat', 'breeches', 'coat', 'puttees']);
  const dir = 'test-results/cast-still';
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/ranger-${browser.hardware?.compat ? 'compat' : 'webgpu'}.png`, new Uint8Array(cloth.bytes));
  const a = await decodePNG(new Uint8Array(plain.bytes)),
    b = await decodePNG(new Uint8Array(cloth.bytes)),
    channels = b.data.length / (b.width * b.height);
  let covered = 0,
    changed = 0;
  for (let i = 0; i < b.data.length; i += channels) {
    if (Math.abs(b.data[i] - 0x30) + Math.abs(b.data[i + 1] - 0x33) + Math.abs(b.data[i + 2] - 0x3a) > 30) covered++;
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      3
    )
      changed++;
  }
  const pixels = b.width * b.height;
  console.log(
    'garments cover',
    ((100 * covered) / pixels).toFixed(1),
    'percent; the sheen changes',
    ((100 * changed) / pixels).toFixed(2),
    'percent',
  );
  assert.ok(covered > pixels * 0.08, 'the outfit fills the frame');
  assert.ok(changed > pixels * 0.002, 'the cloth sheen shows (the felt hat and the fitted lobes)');
  assert.deepEqual(pageErrors, []);
  console.log('cast still check passed');
} finally {
  await browser.close();
}
