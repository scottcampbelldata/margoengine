// Real-GPU check of Grade, built packages. A white box and a red box on the dark background, Tonemap alone. Default
// Grade options change nothing (within one level of rounding). A blue shadows offset lifts the blue of the dark pixels
// and leaves the bright ones; a red highlights cut lowers the red of the bright pixels by what the wheel weights give
// (a CPU oracle) and leaves the dark ones; hue saturation 0 everywhere makes every pixel grey; a flat master curve at
// 0.5 makes every pixel sRGB 0.5 (188). Lift raises the darks most, gain lowers the brights most,
// gamma 2 brightens the midtones, saturation 0 greys and 2 deepens colour, and back at their defaults the frame is the
// default Grade's. Ranges (global, shadows, midtones, highlights), alone and in a HueGrade with the primaries: every
// pixel is where a CPU oracle written from the README's formula puts the plain frame's pixel, and cleared they leave the
// default Grade's frame.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';
import { rangesOracle } from './support/ranges-oracle.mjs';

const RANGES = {
  global: { hue: 120, density: 0.15, saturation: 1.1, exposure: 0.2 },
  shadows: { hue: 240, density: 0.7, exposure: 0.8 },
  midtones: { saturation: 0.3, exposure: -0.3 },
  highlights: { hue: 30, density: 0.5, saturation: 1.4, exposure: -0.6 },
};

await postBrowser(
  'tonemap-grade',
  5366,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js'),
        { Grade } = await import('/packages/tonemap/dist/grade.js'),
        { HueGrade } = await import('/packages/tonemap/dist/hue.js');
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
        HueGrade,
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
    // The primaries (lift, gamma, gain, saturation): lift raises the darks more than the brights, gain lowers the brights
    // more than the darks, gamma 2 brightens the red box's midtone green, saturation 0 greys and 2 deepens the red box.
    const lift = await frame('(o, g) => { g.options.curves = undefined; g.options.lift = [0.2, 0.2, 0.2]; }'),
      gain = await frame('(o, g) => { g.options.lift = undefined; g.options.gain = [0.5, 0.5, 0.5]; }'),
      gamma = await frame('(o, g) => { g.options.gain = undefined; g.options.gamma = [2, 2, 2]; }'),
      desaturated = await frame('(o, g) => { g.options.gamma = undefined; g.options.saturation = 0; }'),
      saturated = await frame('(o, g) => { g.options.saturation = 2; }'),
      reset = await frame('(o, g) => { g.options.saturation = 1; }'),
      ranged = await frame(`(o, g) => { g.options.ranges = ${JSON.stringify(RANGES)}; }`),
      cleared = await frame('(o, g) => { g.options.ranges = undefined; }'),
      // saturation 1 with a gain a hair off 1 compiles the primaries too; HueGrade turns a full circle.
      rangedHue = await frame(
        `(o) => { o.extensions = [new window.t.HueGrade({ gain: [1, 1, 1.000001], hueShift: 360, ranges: ${JSON.stringify(RANGES)} })]; }`,
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
    const r_primaries = {};
    let oracle = 0;
    for (const i of bright) {
      const [R, G, B] = p0[i].map(decode),
        w = smooth(0.5, 1, 0.2126 * R + 0.7152 * G + 0.0722 * B);
      oracle = Math.max(oracle, Math.abs(encode(Math.max(0, R - 0.2 * w)) - highlights.data[4 * i]));
    }
    let resetDiff = 0,
      desaturatedDiff = 0;
    for (let i = 0; i < p0.length; i++)
      for (let c = 0; c < 3; c++) {
        resetDiff = Math.max(resetDiff, Math.abs(reset.data[4 * i + c] - identity.data[4 * i + c]));
        desaturatedDiff = Math.max(
          desaturatedDiff,
          Math.abs(desaturated.data[4 * i + c] - desaturated.data[4 * i + 1]),
        );
      }
    const redBox = p0.map((p, i) => (p[0] > 120 && p[1] < 90 ? i : -1)).filter((i) => i >= 0),
      chroma = (img, set) => set.reduce((s, i) => s + img.data[4 * i] - img.data[4 * i + 2], 0) / set.length;
    Object.assign(r_primaries, {
      liftDark: mean(lift, dark, 1),
      liftBright: mean(lift, bright, 1),
      gainBright: mean(gain, bright, 1),
      gainDark: mean(gain, dark, 1),
      gammaRedGreen: mean(gamma, redBox, 1),
      redChroma: chroma(plain, redBox),
      saturatedChroma: chroma(saturated, redBox),
      desaturatedDiff,
      resetDiff,
      redBox: redBox.length,
    });
    let rangesDiff = 0,
      rangesHueDiff = 0,
      rangesMoved = 0,
      clearedDiff = 0;
    for (let i = 0; i < p0.length; i++) {
      const want = rangesOracle(p0[i].map(decode), RANGES).map(encode);
      for (let c = 0; c < 3; c++) {
        rangesDiff = Math.max(rangesDiff, Math.abs(want[c] - ranged.data[4 * i + c]));
        rangesHueDiff = Math.max(rangesHueDiff, Math.abs(want[c] - rangedHue.data[4 * i + c]));
        rangesMoved = Math.max(rangesMoved, Math.abs(ranged.data[4 * i + c] - plain.data[4 * i + c]));
        clearedDiff = Math.max(clearedDiff, Math.abs(cleared.data[4 * i + c] - identity.data[4 * i + c]));
      }
    }
    const r = {
      rangesDiff,
      rangesHueDiff,
      rangesMoved,
      clearedDiff,
      ...r_primaries,
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
    assert.ok(r.redBox > 500, 'the red box on screen');
    // Lift weighs on the darks (1 - x), gain on the brights (x): each moves its end at least twice as far as the other.
    assert.ok(r.liftDark > 20 && r.liftDark > 2 * r.liftBright, `lift raises the darks most: ${JSON.stringify(r)}`);
    assert.ok(
      r.gainBright < -40 && 2 * Math.abs(r.gainDark) < -r.gainBright,
      `gain lowers the brights most: ${JSON.stringify(r)}`,
    );
    assert.ok(r.gammaRedGreen > 10, `gamma 2 brightens the midtones: ${r.gammaRedGreen}`);
    assert.ok(r.desaturatedDiff <= 1, `saturation 0 greys every pixel: ${r.desaturatedDiff}`);
    assert.ok(r.saturatedChroma > r.redChroma + 5, `saturation 2 deepens the red: ${JSON.stringify(r)}`);
    assert.ok(r.resetDiff <= 0, `back at the defaults the frame is the default Grade's: ${r.resetDiff}`);
    assert.ok(rangesMoved > 20, `ranges change the picture: ${rangesMoved}`);
    assert.ok(rangesDiff <= 2, `every ranged pixel is where the oracle puts it: ${rangesDiff} levels`);
    assert.ok(rangesHueDiff <= 2, `the same through HueGrade with the primaries: ${rangesHueDiff} levels`);
    assert.equal(clearedDiff, 0, 'cleared ranges leave the default frame');
  },
);
