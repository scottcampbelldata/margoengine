// Minimal repro of the MARGO_COMPAT=1 meadow difference on ANGLE Metal (docs/known-bugs.md, "meadow 4x frame 1"):
//   MARGO_COMPAT=1 node scripts/gpu-lock.mjs run --gpu=sky-compat-probe --owner=<you> -- node packages/sky/test/compat-night-probe.mjs
// Renders meadow with the full Sky, then with the narrow Sky (bruneton, clouds, lighting) whose translated GLSL fragment
// shader is swapped, just before compiling, for a variant of it. Prints the differing scene pixels per frame. On the M6
// (2026-11-10): `narrow` [0,2,0]; `withNight` (the emitted GLSL of narrow plus night, which meadow never takes)
// [0,0,0]; `withNightUncalled` (same text, the uniform branch that calls stylizedNight removed) [0,2,0]; `trivialNight`
// (stylizedNight's body replaced by `return vec3(footprint)`) [0,2,0]. Only a call to the full stylizedNight body in a
// branch the frame never takes moves the live cloud arithmetic; the emitted shared code is identical
// (test/compat-night-glsl.test.js). Native WebGPU passes the same meadow comparison (browser-check.mjs).
import { openBrowser } from '../../../scripts/browser.js';
import { Sky } from '../dist/base.js';
import { bruneton } from '../dist/bruneton.js';
import { clouds } from '../dist/clouds.js';
import { lighting } from '../dist/lighting.js';
import { night } from '../dist/night.js';
import { translateWGSL } from '../../webgl2-compat/dist/glsl.js';

const code = new Sky({ model: 'bruneton' }, { bruneton, clouds, lighting, night }).code,
  NIGHT = translateWGSL({ vertex: { source: code }, fragment: { source: code } }).fragment.source,
  branch = /  if \(\(uintBitsToFloat\(_uf0_0\[15\]\.w\) > 0\.5\)\) \{\n {4}return qstylizedNight\([^\n]*\n {2}\}\n/,
  variants = {
    narrow: (s) => s,
    withNight: () => NIGHT,
    withNightUncalled: () => NIGHT.replace(branch, ''),
    trivialNight: () =>
      NIGHT.replace(/(vec3 qstylizedNight\(vec3 (\w+), float (\w+)\) \{\n)[\s\S]*?\n\}\n/, '$1  return vec3($3);\n}\n'),
  };
const context = await openBrowser({ startPath: '/packages/sky/test/browser-check.html', port: 5219 }),
  { page } = context;
try {
  for (const [name, patch] of Object.entries(variants)) {
    const text = patch('');
    await page.goto('http://127.0.0.1:5219/packages/sky/test/browser-check.html');
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    await page.evaluate((text) => {
      const original = WebGL2RenderingContext.prototype.shaderSource;
      WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
        // The narrow sky's fragment shader; the lighting compute program also carries nightSky but no qfragment.
        if (window.swap && text && source.includes('qnightSky(') && source.includes('qfragment(')) source = text;
        return original.call(this, shader, source);
      };
    }, text);
    await page.evaluate(() => window.check.run('meadow', 'full'));
    await page.evaluate(() => (window.swap = true));
    const run = await page.evaluate(() => window.check.run('meadow', 'narrow'));
    const frames = await page.evaluate(() => window.check.compare('full', 'narrow'));
    console.log(name, run.error ?? 'ok', JSON.stringify(frames.map((f) => f.scene.differing)));
  }
} finally {
  await context.close();
}
