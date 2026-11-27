// Real-GPU check of KB-CLEAR-CAPTURE1 and KB-CLEAR-DEFAULT1, built packages, on WebGPU and (--compat or MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/scene-background-browser.mjs [--compat]
// `engine.scene.background` (sRGB) is drawn with no effect, under Tonemap, Bloom and PostStack with a Tonemap, in an
// empty scene (core's clear joins the next pass), beside a mesh (core's own pass clears) and in a view of the left half
// of the canvas (core clears by drawing). With no effect the colour shows as given; under an effect it is linear light
// the effect tone-maps (Khronos PBR Neutral, then the sRGB encoding, IEC 61966-2-1), the pixel ColorBackground of
// @margoengine/environment draws. Before the fix the capture was cleared with the sRGB bytes and encoded again: #808080
// drew 181 where 116 is right. With no background set, core's own clear colour (display 0.018, 0.023, 0.035) takes the
// same path: 5,6,9 with no effect, and under an effect its decoded values tone-mapped, the pixel a background of
// #050609 draws there. Before KB-CLEAR-DEFAULT1 it was written to the capture undecoded and drew 7,20,38 under Tonemap.
// Every case is drawn before the check fails, so one run lists all that are wrong.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { pbrNeutral } from '../../shared/display.js';
import { postBrowser } from './post-browser.mjs';

const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
  encode = (v) => (v < 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
  bytes = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
  shown = (display) => pbrNeutral(display.map(decode)).map((v) => Math.round(encode(v) * 255)),
  displayed = (hex) => shown(bytes(hex).map((b) => b / 255));
// Core's own clear colour (packages/shared/clear-color.js), and the background that displays as the same bytes.
const coreClear = [0.018, 0.023, 0.035],
  coreHex = '#050609';
const colours = ['#808080', '#07090f', '#2a6cba'],
  effects = ['Tonemap', 'Bloom', 'PostStack'];

await postBrowser(
  'post-scene-background',
  compatRun() ? 5444 : 5443,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { ColorBackground } = await import('/packages/environment/dist/index.js'),
        { Bloom, PostStack } = await import('/packages/post/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js');
      const attach = {
        none: () => {},
        Tonemap: (engine) => Tonemap.attach(engine),
        Bloom: (engine) => Bloom.attach(engine),
        PostStack: (engine) => PostStack.attach(engine, [new Tonemap()]),
      };
      window.t = {
        // One frame of `effect` over `colour`, as the scene's background or (`by` 'ColorBackground') that plugin's.
        async draw(effect, colour, by, mesh, half) {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 6], target: [0, 0, 0] },
          });
          engine.stop();
          if (by === 'ColorBackground') ColorBackground.attach(engine, { color: colour });
          else if (colour) engine.scene.background = colour;
          if (mesh)
            engine
              .createMesh()
              .setGeometry(box(1, 1, 1))
              .setMaterial(new PbrMaterial({ color: '#e0a050' }));
          attach[effect](engine);
          engine.render({
            delta: 1 / 60,
            views: half ? [{ camera: engine.camera, viewport: [0, 0, 0.5, 1] }] : undefined,
          });
          await engine.gpu.queue.onSubmittedWorkDone();
          this.engine = engine;
        },
        dispose() {
          this.engine.dispose();
        },
      };
    });
    const pixel = async (effect, colour, by, mesh, half) => {
      await page.evaluate(([e, c, b, m, h]) => window.t.draw(e, c, b, m, h), [effect, colour, by, mesh, half]);
      const image = await shot();
      await page.evaluate(() => window.t.dispose());
      // A corner pixel, away from the mesh.
      const i = (8 * image.width + 8) * 4;
      return [...image.data.subarray(i, i + 3)];
    };
    const wrong = [],
      check = (actual, expected, label, tolerance) => {
        const ok = actual.every((v, k) => Math.abs(v - expected[k]) <= tolerance);
        console.log(`${ok ? 'ok' : 'WRONG'} ${label}: drew ${actual}, expected ${expected}`);
        if (!ok) wrong.push(label);
      };
    for (const scene of ['empty scene', 'beside a mesh', 'half view']) {
      const mesh = scene === 'beside a mesh',
        half = scene === 'half view';
      for (const colour of colours) {
        // No capture: the colour as given, byte for byte.
        check(await pixel('none', colour, 'background', mesh, half), bytes(colour), `none ${colour} ${scene}`, 0);
        for (const effect of effects) {
          const drawn = await pixel(effect, colour, 'background', mesh, half),
            label = `${effect} ${colour} ${scene}`;
          check(drawn, displayed(colour), label, 1);
          check(
            drawn,
            await pixel(effect, colour, 'ColorBackground', mesh, half),
            `${label} against ColorBackground`,
            1,
          );
        }
      }
      // No background (KB-CLEAR-DEFAULT1): core's own clear colour as given, and under an effect as a background is.
      check(await pixel('none', undefined, 'background', mesh, half), bytes(coreHex), `none unset ${scene}`, 0);
      for (const effect of effects) {
        const drawn = await pixel(effect, undefined, 'background', mesh, half),
          label = `${effect} unset ${scene}`;
        check(drawn, shown(coreClear), label, 1);
        check(drawn, await pixel(effect, coreHex, 'background', mesh, half), `${label} against ${coreHex}`, 1);
      }
    }
    assert.deepEqual(wrong, []);
    console.log(`ok scene background on ${compatRun() ? 'the WebGL2 layer' : 'WebGPU'}`);
  },
  { seconds: 600 },
);
