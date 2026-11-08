// Real-GPU check of the classic curves, built packages. Lit white, grey and blue boxes, Tonemap alone, at exposures
// -4 to 1 in half stops so the flat faces give many input levels.
// The `linear` frame gives each pixel's HDR value where it is below white (decode its sRGB); `reinhard` and `cineon`
// must then match a CPU oracle of their formulas on every such pixel: x / (1 + x), and the Hejl and Burgess-Dawson
// fit raised to 2.2 (within 2 levels: the oracle starts from 8-bit values).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'tonemap-curves',
  5367,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js');
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
      const tonemap = Tonemap.attach(engine, { curve: 'linear', exposure: -1 });
      window.t = {
        engine,
        tonemap,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (curve, exposure) => {
      await page.evaluate(
        `Object.assign(window.t.tonemap.options, {curve: '${curve}', exposure: ${exposure}}); window.t.frame()`,
      );
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const sets = [];
    for (let e = -4; e <= 1; e += 0.5)
      sets.push([await frame('linear', e), await frame('reinhard', e), await frame('cineon', e)]);
    const decode = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
      encode = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
      curves = {
        reinhard: (x) => x / (1 + x),
        cineon: (x) => {
          const f = Math.max(x - 0.004, 0);
          return ((f * (6.2 * f + 0.5)) / (f * (6.2 * f + 1.7) + 0.06)) ** 2.2;
        },
      };
    const result = { pixels: 0, reinhard: 0, cineon: 0, spread: new Set() };
    for (const [linear, reinhard, cineon] of sets)
      for (let i = 0; i < linear.data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          const v = linear.data[i + c];
          if (v >= 250) continue;
          if (c === 0) result.pixels++;
          result.spread.add(v);
          const x = decode(v);
          for (const [name, img] of [
            ['reinhard', reinhard],
            ['cineon', cineon],
          ])
            result[name] = Math.max(result[name], Math.abs(encode(curves[name](x)) - img.data[i + c]));
        }
    result.spread = result.spread.size;
    console.log(JSON.stringify(result));
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(result.spread > 40, `many input levels are checked: ${result.spread}`);
    assert.ok(result.reinhard <= 2, `reinhard matches x / (1 + x): ${result.reinhard} levels`);
    assert.ok(result.cineon <= 2, `cineon matches the filmic fit: ${result.cineon} levels`);
  },
);
