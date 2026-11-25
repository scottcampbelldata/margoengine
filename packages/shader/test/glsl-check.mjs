// glslFn on the GPU: every fixture of test/glsl-fixtures.js runs as GLSL in the browser's own WebGL2 compiler (the
// oracle) and as glslFn in a NodePass; the two agree within 1 level per channel on every pixel. Run natively and with
// --compat (the WebGL2 layer): both legs meet the same bound against the same oracle, so native and layer differ by
// at most 2 levels anywhere, inside the roadmap's bound (at most 0.1 % of pixels over 2 levels, mean at most 0.25).
// NodeMaterials built from GLSL match the same graphs written in WGSL and texture(); every toGLSL program compiles and
// links in raw WebGL2.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { glslFixtures } from './glsl-fixtures.js';

const context = await openBrowser({ startPath: '/packages/shader/test/glsl-check.html', port: 'free' }),
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
    sum = 0;
  actual.forEach((v, i) => {
    const d = Math.abs(v - expected[i]);
    max = Math.max(max, d);
    sum += d;
  });
  return { max, mean: sum / actual.length };
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const rows = [];
  for (let i = 0; i < glslFixtures.length; i++)
    for (const t of [0.25, 0.75]) {
      assert.deepEqual(await page.evaluate(([n, v]) => window.check.pass(n, v), [i, t]), [], glslFixtures[i].name);
      const got = await rgb(),
        want = await page.evaluate(([n, v]) => window.check.oracle(n, v), [i, t]),
        d = compare(got, want);
      assert.equal(got.length, want.length, 'pixel counts');
      rows.push(`${glslFixtures[i].name} t=${t}: max ${d.max}, mean ${d.mean.toFixed(4)}`);
      assert.ok(
        d.max <= 1,
        `${glslFixtures[i].name} at t=${t} differs from the native WebGL2 oracle by ${d.max} levels`,
      );
    }
  for (const kind of ['tint', 'pick']) {
    assert.deepEqual(await page.evaluate(([k]) => window.check.material(k, false), [kind]), []);
    const twin = await rgb();
    assert.deepEqual(await page.evaluate(([k]) => window.check.material(k, true), [kind]), []);
    const d = compare(await rgb(), twin);
    rows.push(`NodeMaterial ${kind}: max ${d.max}, mean ${d.mean.toFixed(4)}`);
    assert.ok(d.max <= 1, `NodeMaterial ${kind} from GLSL differs from its WGSL twin by ${d.max} levels`);
    assert.ok(
      twin.some((v) => v > 0),
      'the material draws',
    );
  }
  const compiled = await page.evaluate(() => window.check.compile());
  assert.deepEqual(compiled.failed, [], 'every toGLSL program compiles and links in WebGL2');
  // The layer translates WGSL without WebGPU's uniformity analysis, so only native WebGPU can refuse strict code.
  assert.equal(await page.evaluate(() => window.check.strict(false)), 0);
  if (!compat)
    assert.ok((await page.evaluate(() => window.check.strict(true))) > 0, 'strict keeps the uniformity rule');
  assert.deepEqual(await page.evaluate(() => window.check.close()), []);
  assert.deepEqual(errors, []);
  console.log(rows.join('\n'));
  console.log(
    `glslFn ${compat ? 'WebGL2 layer' : 'native WebGPU'}: ${glslFixtures.length} fixtures within 1 level of the native WebGL2 oracle, NodeMaterial twins matched, ${compiled.count} toGLSL programs linked`,
  );
} finally {
  await context.close();
}
