// Real-GPU check of Grade, built packages. A white box and a red box on the dark background, Tonemap alone. Default
// Grade options change nothing (within one level of rounding). A blue shadows offset lifts the blue of the dark pixels
// and leaves the bright ones; a red highlights cut lowers the red of the bright pixels by what the wheel weights give
// (a CPU oracle) and leaves the dark ones; hue saturation 0 everywhere makes every pixel grey; a flat master curve at
// 0.5 makes every pixel sRGB 0.5 (188).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'tonemap-grade',
  5366,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js'),
        { Grade } = await import('/packages/tonemap/dist/grade.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
      engine.stop();
      for (const [x, color] of [
        [-1, '#ffffff'],
        [1, '#d02020'],
      ])
        engine
          .createMesh()
          .setGeometry(box(1.4, 1.4, 0.2))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color, roughness: 1 }));
      const grade = new Grade(),
        tonemap = Tonemap.attach(engine, {});
      window.t = {
        engine,
        tonemap,
        grade,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (set) => {
      await page.evaluate(`(${set})(window.t.tonemap.options, window.t.grade); window.t.frame()`);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const plain = await frame('() => {}');
    const identity = await frame('(o, g) => { o.extensions = [g]; }');
    const shadows = await frame('(o, g) => { g.options.shadows = [0, 0, 0.1]; }');
    const highlights = await frame('(o, g) => { g.options.shadows = undefined; g.options.highlights = [-0.2, 0, 0]; }');
    const grey = await frame(
      '(o, g) => { g.options.highlights = undefined; g.options.hueSaturation = [0, 0, 0, 0, 0, 0]; }',
    );
    const flat = await frame(
      '(o, g) => { g.options.hueSaturation = undefined; g.options.curves = { master: [[0, 0.5], [1, 0.5]] }; }',
    );
    const pixels = (img) =>
      Array.from({ length: img.width * img.height }, (_, i) => [...img.data.subarray(4 * i, 4 * i + 3)]);
    const p0 = pixels(plain),
      dark = p0.map((p, i) => (Math.max(...p) < 40 ? i : -1)).filter((i) => i >= 0),
      bright = p0.map((p, i) => (Math.min(...p) > 150 ? i : -1)).filter((i) => i >= 0);
    const mean = (img, set, c) => set.reduce((s, i) => s + img.data[4 * i + c] - plain.data[4 * i + c], 0) / set.length;
    let identityDiff = 0,
      greyDiff = 0,
      flatDiff = 0;
    for (let i = 0; i < p0.length; i++)
      for (let c = 0; c < 3; c++) {
        identityDiff = Math.max(identityDiff, Math.abs(identity.data[4 * i + c] - plain.data[4 * i + c]));
        greyDiff = Math.max(greyDiff, Math.abs(grey.data[4 * i + c] - grey.data[4 * i + 1]));
        flatDiff = Math.max(flatDiff, Math.abs(flat.data[4 * i + c] - 188));
      }
    // The highlights frame against a CPU oracle of the shader's wheel step on the plain frame's bright pixels: decode
    // sRGB, luminance l, weight smoothstep(0.5, 1, l), red minus 0.2 times it, encode (8-bit input: within 2 levels).
    const decode = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
      encode = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
      smooth = (a, b, x) => ((x = Math.min(1, Math.max(0, (x - a) / (b - a)))), x * x * (3 - 2 * x));
    let oracle = 0;
    for (const i of bright) {
      const [R, G, B] = p0[i].map(decode),
        w = smooth(0.5, 1, 0.2126 * R + 0.7152 * G + 0.0722 * B);
      oracle = Math.max(oracle, Math.abs(encode(Math.max(0, R - 0.2 * w)) - highlights.data[4 * i]));
    }
    const r = {
      oracle,
      dark: dark.length,
      bright: bright.length,
      identityDiff,
      shadowsDarkBlue: mean(shadows, dark, 2),
      shadowsDarkRed: mean(shadows, dark, 0),
      shadowsBrightBlue: mean(shadows, bright, 2),
      highlightsBrightRed: mean(highlights, bright, 0),
      highlightsDarkRed: mean(highlights, dark, 0),
      greyDiff,
      flatDiff,
    };
    console.log(JSON.stringify(r));
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(r.dark > 1000 && r.bright > 1000, 'both dark and bright pixels on screen');
    assert.ok(identityDiff <= 1, `default Grade changes nothing: ${identityDiff}`);
    assert.ok(r.shadowsDarkBlue > 20 && Math.abs(r.shadowsDarkRed) < 1, 'shadows offset lifts the blue of the darks');
    assert.ok(Math.abs(r.shadowsBrightBlue) < 3, 'and leaves the brights');
    assert.ok(
      r.highlightsBrightRed < -3 && Math.abs(r.highlightsDarkRed) < 1,
      'highlights cut lowers the red of the brights only',
    );
    assert.ok(oracle <= 2, `the red of every bright pixel is where the wheel math puts it: ${oracle} levels`);
    assert.ok(greyDiff <= 1, `saturation 0 makes every pixel grey: ${greyDiff}`);
    assert.ok(flatDiff <= 1, `a flat curve at 0.5 gives sRGB 188 everywhere: ${flatDiff}`);
  },
);
