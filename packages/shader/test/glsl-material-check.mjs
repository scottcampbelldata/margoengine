// ShaderMaterial on the GPU: every program of test/glsl-material-fixtures.js runs as GLSL in the browser's own WebGL
// compiler (the oracle: WebGL 1 for GLSL ES 1.00, WebGL 2 for 3.00) and as a ShaderMaterial on a RawMesh, with the same
// vertices and uniform values; the two agree within 1 level per channel at every pixel, for the first values and again
// after a live change (new uniform values without a translation, or new defines with one). Run natively and with
// --compat (the WebGL2 layer): both legs meet the same bound against the same oracle, so native and layer differ by at
// most 2 levels anywhere (the roadmap bound: at most 0.1 % of pixels over 2 levels, mean at most 0.25).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { programFixtures } from './glsl-material-fixtures.js';
import { builtinFixtures } from './glsl-material-builtins-fixtures.js';
import { dataFixtures } from './glsl-material-data-fixtures.js';
import { sceneFixtures } from './glsl-material-scene-fixtures.js';

const fixtures = [...programFixtures, ...builtinFixtures, ...dataFixtures, ...sceneFixtures];

const context = await openBrowser({ startPath: '/packages/shader/test/glsl-material-check.html', port: 'free' }),
  { page } = context,
  errors = [],
  compat = compatRun();
page.on('pageerror', (e) => errors.push(e.message));
const rgb = async () => {
  const p = await decodePNG(await page.locator('canvas').screenshot());
  assert.equal(p.width, 32, 'one screenshot pixel per canvas pixel');
  const out = [];
  for (let i = 0; i < p.width * p.height; i++) out.push(...p.data.slice(i * 4, i * 4 + 3));
  return out;
};
const compare = (actual, expected) => {
  let max = 0,
    sum = 0,
    at = -1;
  actual.forEach((v, i) => {
    const d = Math.abs(v - expected[i]);
    if (d > max) (max = d), (at = i);
    sum += d;
  });
  return { max, mean: sum / actual.length, pixel: at < 0 ? '' : ` at x ${Math.floor(at / 3) % 32}, y ${Math.floor(at / 96)} channel ${at % 3} (${actual[at]} vs ${expected[at]})` };
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const rows = [];
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    assert.deepEqual(await page.evaluate((n) => window.check.draw(n), i), [], f.name);
    for (const which of [1, 2]) {
      if (which === 2) {
        const changed = await page.evaluate((n) => window.check.change(n), i);
        assert.deepEqual(changed.errors, [], f.name);
        assert.equal(changed.translations, f.defines?.[1] ? 1 : 0, `${f.name}: translations for the change`);
      }
      const got = await rgb(),
        want = await page.evaluate(([n, w]) => window.check.oracle(n, w), [i, which]),
        d = compare(got, want);
      assert.equal(got.length, want.length, 'pixel counts');
      assert.ok(want.some((v) => v > 0) && got.some((v) => v > 0), `${f.name} draws`);
      rows.push(`${f.name} (${which === 1 ? 'first' : 'changed'}): max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}`);
      assert.ok(d.max <= 1, `${f.name} (${which === 1 ? 'first' : 'changed'}) differs from the browser's own WebGL by ${d.max} levels${d.pixel}`);
    }
  }
  // KB-GLSLP1: two side by side views; each point is 8 pixels of its own view, and viewport_size is the view's size.
  {
    assert.deepEqual(await page.evaluate(() => window.check.views()), [], 'two views');
    const got = await rgb(),
      want = await page.evaluate(() => window.check.viewOracle()),
      d = compare(got, want),
      lit = [0, 16].map((x0) => {
        let n = 0;
        for (let y = 0; y < 32; y++) for (let x = x0; x < x0 + 16; x++) if (got[(y * 32 + x) * 3 + 1] > 0) n++;
        return n;
      });
    rows.push(`sized points in two views: max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}, lit pixels ${lit.join(' and ')}`);
    assert.deepEqual(lit, [64, 64], 'an 8 pixel point in each 16 x 32 view covers 64 pixels');
    assert.ok(d.max <= 1, `sized points in two views differ from the browser's own WebGL by ${d.max} levels${d.pixel}`);
  }
  // Depth against a core mesh, both ways round: the nearer surface shows at the centre (red: the GLSL quad).
  for (const [z, front] of [[0.5, true], [-0.5, false]]) {
    assert.deepEqual(await page.evaluate((v) => window.check.depthOrder(v), z), [], 'depth order');
    const p = await rgb(),
      c = (16 * 32 + 16) * 3,
      red = p[c] > 200 && p[c + 1] < 40 && p[c + 2] < 40;
    assert.equal(red, front, `GLSL quad at z ${z} ${front ? 'in front of' : 'behind'} the core box: centre pixel ${p.slice(c, c + 3)}`);
    rows.push(`depth order, GLSL quad ${front ? 'in front' : 'behind'}: centre ${p.slice(c, c + 3)}`);
  }
  assert.deepEqual(await page.evaluate(() => window.check.close()), []);
  assert.deepEqual(errors, []);
  console.log(rows.join('\n'));
  console.log(
    `ShaderMaterial ${compat ? 'WebGL2 layer' : 'native WebGPU'}: ${fixtures.length} GLSL programs within 1 level of the browser's own WebGL, before and after a live change`,
  );
} finally {
  await context.close();
}
