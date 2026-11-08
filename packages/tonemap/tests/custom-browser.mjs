// Real-GPU check of CustomCurve, built packages. Lit white, grey and blue boxes, Tonemap alone, at exposures -4 to 1
// in whole stops. The `linear` frame gives each pixel's HDR value where it is below white (decode its sRGB). A WGSL
// curve x / (x + k) with k = 1 from params, and a JavaScript curve x / (1 + x), must both match a CPU oracle of
// x / (1 + x) on every such pixel: inside what the curve gives over the input's half-level 8-bit interval, plus one
// level of output rounding (the sampled curve's log2 interpolation error is far below a level). A live params change (k = 0.25) moves the WGSL frame to x / (x + 0.25) without a
// recompile. The WGSL curve also compiles and renders without a GPU error under an HDR ColorOutput.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'tonemap-custom',
  5368,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js'),
        { CustomCurve } = await import('/packages/tonemap/dist/custom.js');
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
      const wgsl = new CustomCurve({
          wgsl: 'fn film(x: vec3f) -> vec3f { return x / (x + vec3f(curveParams[0].x)); }',
          params: [1],
        }),
        sampled = new CustomCurve({ curve: (x) => x / (1 + x) }),
        tonemap = Tonemap.attach(engine, { curve: 'linear' });
      window.t = {
        engine,
        tonemap,
        curves: { none: [], wgsl: [wgsl], sampled: [sampled] },
        wgsl,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (curve, exposure, k = 1) => {
      await page.evaluate(
        `window.t.wgsl.options.params = [${k}]; Object.assign(window.t.tonemap.options, {extensions: window.t.curves.${curve}, exposure: ${exposure}}); window.t.frame()`,
      );
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const sets = [];
    for (let e = -4; e <= 1; e++)
      sets.push([await frame('none', e), await frame('wgsl', e), await frame('sampled', e), await frame('wgsl', e, 0.25)]);
    const decode = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
      encode = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    const r = { pixels: 0, wgsl: 0, sampled: 0, live: 0, spread: new Set() };
    for (const [linear, wgsl, sampled, live] of sets)
      for (let i = 0; i < linear.data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          const v = linear.data[i + c];
          if (v >= 250) continue;
          if (c === 0) r.pixels++;
          r.spread.add(v);
          // The 8-bit linear frame pins each input only to within half a level: the output must lie in the range
          // the curve maps that interval to, plus one level of output rounding (half a level each way, and the GPU's).
          const miss = (f, out) => {
            const lo = encode(f(decode(Math.max(0, v - 0.5)))),
              hi = encode(f(decode(v + 0.5)));
            return Math.max(0, lo - 1 - out, out - hi - 1);
          };
          const reinhard = (x) => x / (1 + x);
          r.wgsl = Math.max(r.wgsl, miss(reinhard, wgsl.data[i + c]));
          r.sampled = Math.max(r.sampled, miss(reinhard, sampled.data[i + c]));
          r.live = Math.max(r.live, miss((x) => x / (x + 0.25), live.data[i + c]));
        }
    r.spread = r.spread.size;
    // Under an HDR ColorOutput the curve goes into the output shader: it must compile and draw without a GPU error.
    r.hdrError = await page.evaluate(async () => {
      const { ColorOutput } = await import('/packages/environment/dist/index.js'),
        { engine, tonemap, curves } = window.t,
        output = ColorOutput.attach(engine, { force: true });
      tonemap.options.extensions = curves.wgsl;
      engine.gpu.pushErrorScope('validation');
      await window.t.frame();
      const error = await engine.gpu.popErrorScope();
      output.dispose();
      return error ? error.message : null;
    });
    console.log(JSON.stringify(r));
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(r.spread > 40, `many input levels are checked: ${r.spread}`);
    assert.ok(r.wgsl === 0, `the WGSL curve gives x / (1 + x): ${r.wgsl} levels`);
    assert.ok(r.sampled === 0, `the sampled JavaScript curve gives x / (1 + x): ${r.sampled} levels`);
    assert.ok(r.live === 0, `a live params change gives x / (x + 0.25): ${r.live} levels`);
    assert.equal(r.hdrError, null, 'the WGSL curve compiles under ColorOutput');
  },
);
