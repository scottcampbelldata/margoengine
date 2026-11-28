// Real-GPU check for KB-MAT-TINTMAP1: the light a transmissive Material passes is tinted by its whole base colour,
// factor times texture (KHR_materials_transmission, "Tint": the transmitted light is multiplied by baseColor, which
// includes baseColorTexture). On a #cccccc background a fully transmissive quad with `color` red, with a red `map`
// texel and white colour, and with a red `layered()` layer must read the same red tint, with and without the
// `Transmission` refraction pass, in the two-draw and the dual-source blend. Before the fix a map or a layer left the
// background untinted: (203, 202, 202) where the colour gave (203, 2, 2).
// Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/materials/test/tint-map-browser.mjs
//   MARGO_COMPAT=1 node scripts/run-with-timeout.mjs -- node packages/materials/test/tint-map-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const compat = compatRun(),
  browser = await openBrowser({ port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.waitForFunction(() => window.modern);
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { Material, Texture, createMesh } = await import('/packages/materials/dist/index.js');
    const { layered } = await import('/packages/materials/dist/layered.js');
    const { Transmission } = await import('/packages/materials/dist/transmission.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const quad = {
      positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    };
    const red = () => new Texture({ data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 });
    const looks = {
      color: () => ({ color: [1, 0, 0, 1] }),
      map: () => ({ map: red() }),
      // A physical map as well, so the mapped-physical shader route is covered too.
      mapAndTransmissionMap: () => ({
        map: red(),
        transmissionMap: new Texture({ data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 }),
      }),
      layer: () => ({ features: [layered({ layers: [{ color: [1, 0, 0] }] })] }),
      none: () => ({}),
    };
    async function scene(look, pass, blend) {
      const canvas = document.body.appendChild(document.createElement('canvas'));
      const engine = await Engine.create(canvas, {
        exactSize: [32, 32],
        features: ['dual-source-blending'],
        camera: { position: [0, 0, 2], target: [0, 0, 0] },
      });
      try {
        const gpuErrors = [];
        engine.gpu.addEventListener('uncapturederror', (ev) => gpuErrors.push(ev.error.message));
        engine.scene.background = '#cccccc';
        if (pass) engine.use(new Transmission());
        createMesh(
          engine,
          quad,
          new Material({ transmission: 1, roughness: 0.5, transmissionBlend: blend, ...looks[look]() }),
        );
        const frame = async () => {
          engine.render({ culling: false });
          await engine.gpu.queue.onSubmittedWorkDone();
        };
        const read = document.createElement('canvas');
        read.width = read.height = 32;
        const g = read.getContext('2d');
        let failure;
        try {
          await waitForPipelines(frame);
          engine.render({ culling: false });
          g.drawImage(canvas, 0, 0, 32, 32);
        } catch (e) {
          failure = { code: e.code, message: e.message };
        }
        return { look, pass, blend, failure, gpuErrors, centre: [...g.getImageData(16, 16, 1, 1).data.slice(0, 3)] };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    }
    const rows = [];
    for (const pass of [false, true])
      for (const blend of ['two-draw', 'auto'])
        for (const look of Object.keys(looks)) rows.push(await scene(look, pass, blend));
    return rows;
  });
  console.log(JSON.stringify({ compat: !!compat, rows: result.map((r) => [r.look, r.pass, r.blend, r.centre]) }));
  for (const r of result) {
    assert.equal(r.failure, undefined, `${r.look} pass=${r.pass} ${r.blend}: ${r.failure?.message}`);
    assert.deepEqual(r.gpuErrors, [], `${r.look} pass=${r.pass} ${r.blend}`);
  }
  for (const pass of [false, true])
    for (const blend of ['two-draw', 'auto']) {
      const at = (look) => result.find((r) => r.look === look && r.pass === pass && r.blend === blend).centre,
        tinted = at('color'),
        plain = at('none');
      const where = `pass=${pass} ${blend}`;
      assert.ok(tinted[0] > 150 && tinted[1] < 40 && tinted[2] < 40, `${where}: a red colour tints red: ${tinted}`);
      assert.ok(plain[1] > 150 && plain[2] > 150, `${where}: no colour leaves the grey: ${plain}`);
      for (const look of ['map', 'mapAndTransmissionMap', 'layer']) {
        const c = at(look);
        assert.ok(
          c.every((v, k) => Math.abs(v - tinted[k]) <= 3),
          `${where}: ${look} tints the passed light as the colour does: ${c} against ${tinted}`,
        );
      }
    }
  assert.deepEqual(errors, []);
  console.log('transmission tint by base colour map: passed');
} finally {
  await browser.close();
}
