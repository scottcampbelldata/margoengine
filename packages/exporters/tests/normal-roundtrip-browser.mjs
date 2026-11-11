// Real-GPU check that exportModel keeps a normal map's shading: a @margoengine/materials plane with computeTangents
// tangents (v-up UVs, flipY uploads) and a normal map is drawn, exported to GLB, loaded back with
// @margoengine/gltf-pro (v-down UVs, glTF image-up normals) and drawn again. The map tilts the upper half of the image
// toward image-up and leaves the lower half flat, and the light comes from above, so a flipped V, an upside-down image
// or a flipped bitangent each move or invert the bright band.
// Run from the repository root after `npm run build:packages`: npm run test:normal:browser --workspace packages/exporters
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ port: 'free' }),
  { page } = browser,
  errors = [],
  size = 128;
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

/** Draws one scene (`source`: the materials plane, `export`: its GLB through gltf-pro, `flat`: that GLB without its
 * normal texture) and returns the canvas pixels. */
async function draw(kind) {
  await page.evaluate(
    async ({ size, kind }) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Material, Texture, createMesh } = await import('/packages/materials/dist/index.js'),
        { planeGeometry, computeTangents } = await import('/packages/geometry/dist/index.js'),
        { exportModel } = await import('/packages/exporters/dist/model.js'),
        { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js');
      document.querySelector('canvas')?.remove();
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px`;
      canvas.width = canvas.height = size;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, { camera: { position: [0, 0, 2.2], target: [0, 0, 0] } });
      engine.gpu?.pushErrorScope('validation');
      // Light from above and in front, toward the viewer's side of the plane.
      engine.lighting.direction.set([0, Math.SQRT1_2, Math.SQRT1_2, 0]);
      // 8 x 8 raw rows, row 0 at v = 0 (the image's bottom): rows 4 to 7 tilt 45 degrees toward image-up (+Y),
      // rows 0 to 3 are flat.
      const data = new Uint8Array(8 * 8 * 4);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) data.set(y >= 4 ? [128, 218, 218, 255] : [128, 128, 255, 255], (y * 8 + x) * 4);
      const material = new Material({
        color: [1, 1, 1],
        roughness: 1,
        metalness: 0,
        normalMap: new Texture({ width: 8, height: 8, data }, { magFilter: 'nearest', minFilter: 'nearest' }),
      });
      const mesh = createMesh(engine, computeTangents(planeGeometry(2, 2)), material);
      if (kind !== 'source') {
        const glb = await exportModel([mesh], { binary: true });
        mesh.dispose?.();
        mesh.root?.destroy?.();
        let input = glb;
        if (kind === 'flat') {
          const view = new DataView(glb.buffer, glb.byteOffset),
            length = view.getUint32(12, true),
            json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
          for (const m of json.materials) delete m.normalTexture;
          input = { json, bin: glb.slice(28 + length) };
        }
        window.loaded =
          kind === 'flat'
            ? await parseGLTFAsync(engine, input.json, [input.bin], [])
            : await parseGLTFAsync(engine, input, {});
      }
      window.check = { engine };
      engine.start();
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      await waitForPipelines(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await engine.gpu?.queue.onSubmittedWorkDone();
      });
    },
    { size, kind },
  );
  const shot = await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(async () => {
    const { engine } = window.check,
      error = await engine.gpu?.popErrorScope();
    engine.dispose();
    if (error) throw new Error(error.message);
  });
  return shot;
}
/** Mean green of a band of rows, the plane's middle columns only. */
const band = (shot, y0, y1) => {
  let sum = 0,
    n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = 40; x < 88; x++) {
      sum += shot.data[(y * shot.width + x) * 4 + 1];
      n++;
    }
  return sum / n;
};

try {
  const shots = { source: await draw('source'), export: await draw('export'), flat: await draw('flat') },
    // The plane spans rows of about 18 to 110; each band keeps clear of the edge and of the seam at the middle.
    bands = Object.fromEntries(
      Object.entries(shots).map(([k, s]) => [k, { top: band(s, 30, 56), bottom: band(s, 72, 98) }]),
    );
  console.log(JSON.stringify(bands));
  assert.deepEqual(errors, []);
  // The source: the tilted upper half faces the light more than the flat lower half.
  assert.ok(bands.source.top > bands.source.bottom + 8, `source upper half lit more: ${JSON.stringify(bands.source)}`);
  // The reloaded file: the flat lower half shades as the file without a normal map does, the upper half brighter.
  assert.ok(
    Math.abs(bands.export.bottom - bands.flat.bottom) <= 2,
    `exported flat half matches the no-normal-map render: ${JSON.stringify(bands)}`,
  );
  assert.ok(bands.export.top > bands.flat.top + 8, `exported tilted half lit more than flat: ${JSON.stringify(bands)}`);
  console.log('normal-roundtrip-browser: exported normal map shades as the source (3 checks)');
} finally {
  await browser.close();
}
