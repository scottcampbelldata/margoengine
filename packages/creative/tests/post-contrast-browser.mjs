// Real-GPU check of PostProcessing's contrast, built packages. Lit white, grey and blue boxes at exposures -4 to 1 in
// half stops. The contrast 1 frame gives each pixel's scene-linear value where the PBR Neutral display transform passes
// colour through (peak under 0.76, here sRGB code 200 and under): decode its sRGB, then undo the transform's small black
// offset. The contrast 1.2 frame must match 0.18 (c / 0.18)^1.2, a power about grey, through the same transform, and
// keep every channel that power leaves visible above black: the linear contrast used until 2026-11-14,
// (c - 0.18) 1.2 + 0.18 clamped at 0, sent every scene-linear channel below 0.03 to 0. The oracle starts from 8-bit
// values (half a code each way), which undoing the offset's square root and the power's slope of 1.2 widen: within 3
// levels (2.43 measured on the 680M).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';
import { pbrNeutral } from '../../shared/display.js';

const k = 1.2;
await postBrowser(
  'creative-post-contrast',
  5351,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostProcessing } = await import('/packages/creative/dist/post.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
      engine.stop();
      for (const [x, color] of [
        [-1.2, '#ffffff'],
        [0, '#808080'],
        [1.2, '#20a0e0'],
      ])
        engine
          .createMesh()
          .setGeometry(box(1, 1.6, 0.2))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color, roughness: 1 }));
      const post = new PostProcessing({ grain: 0 });
      engine.use(post);
      window.t = { engine, post };
    });
    const frame = async (exposure, contrast) => {
      await page.evaluate(
        `Object.assign(window.t.post.options, {exposure: ${exposure}, contrast: ${contrast}}); window.t.engine.render({delta: 1 / 60})`,
      );
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const sets = [];
    for (let e = -4; e <= 1; e += 0.5) sets.push([await frame(e, 1), await frame(e, k)]);
    const decode = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
      encode = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
      clip = 0.18 * (1 - 1 / k);
    const result = { pixels: 0, contrast: 0, dark: 0, darkBlack: 0, spread: new Set() };
    for (const [plain, graded] of sets)
      for (let i = 0; i < plain.data.length; i += 4) {
        const shown = [0, 1, 2].map((c) => plain.data[i + c]);
        if (Math.max(...shown) > 200) continue;
        // Undo PBR Neutral below its knee: out = c - offset, offset = x - 6.25 x^2 (x, the smallest channel, under
        // 0.08, where the smallest output is 6.25 x^2) or 0.04.
        const d = shown.map(decode),
          m = Math.min(...d),
          x = m < 0.04 ? Math.sqrt(m / 6.25) : m + 0.04,
          scene = d.map((v) => v + (m < 0.04 ? x - m : 0.04)),
          expected = pbrNeutral(scene.map((v) => 0.18 * (v / 0.18) ** k)).map(encode);
        result.pixels++;
        for (let c = 0; c < 3; c++) {
          result.spread.add(shown[c]);
          result.contrast = Math.max(result.contrast, Math.abs(expected[c] - graded.data[i + c]));
          // Visible after the power (code 3 and up) from a scene-linear channel the linear contrast clipped to 0.
          if (expected[c] >= 3 && scene[c] < clip) {
            result.dark++;
            if (graded.data[i + c] === 0) result.darkBlack++;
          }
        }
      }
    result.spread = result.spread.size;
    console.log(JSON.stringify(result));
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(result.spread > 40, `many input levels are checked: ${result.spread}`);
    assert.ok(result.dark > 100, `dark channels are checked: ${result.dark}`);
    assert.equal(result.darkBlack, 0, `contrast ${k} keeps every visible dark channel above black`);
    assert.ok(result.contrast <= 3, `contrast ${k} matches 0.18 (c / 0.18)^${k}: ${result.contrast} levels`);
  },
);
