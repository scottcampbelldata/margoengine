// ShaderPass on the GPU: every program of test/glsl-pass-fixtures.js runs as the second stage of a PostStack, after a
// pass that draws a known image, and as GLSL in the browser's own WebGL over the oracle's drawing of that image; the
// two agree within 1 level per channel at every pixel, for the first uniform values and after a live change. Run
// natively and with --compat (the WebGL2 layer): both legs meet the same bound against the same oracle. Then
// ShaderPass.attach and NodePass.attach each run an inverting pass alone in a PostStack of their own.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { passFixtures } from './glsl-pass-fixtures.js';

const context = await openBrowser({ startPath: '/packages/shader/test/glsl-pass-check.html', port: 'free' }),
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
  return {
    max,
    mean: sum / actual.length,
    pixel:
      at < 0
        ? ''
        : ` at x ${Math.floor(at / 3) % 32}, y ${Math.floor(at / 96)} channel ${at % 3} (${actual[at]} vs ${expected[at]})`,
  };
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const rows = [];
  for (let i = 0; i < passFixtures.length; i++) {
    const f = passFixtures[i];
    assert.deepEqual(await page.evaluate((n) => window.check.draw(n), i), [], f.name);
    for (const which of [1, 2]) {
      if (which === 2) assert.deepEqual(await page.evaluate((n) => window.check.change(n), i), [], f.name);
      const got = await rgb(),
        want = await page.evaluate(([n, w]) => window.check.oracle(n, w), [i, which]),
        d = compare(got, want);
      assert.equal(got.length, want.length, 'pixel counts');
      assert.ok(new Set(want).size > 16, `${f.name}: the oracle image varies`);
      rows.push(`${f.name} (${which === 1 ? 'first' : 'changed'}): max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}`);
      assert.ok(
        d.max <= 1,
        `${f.name} (${which === 1 ? 'first' : 'changed'}) differs from the browser's own WebGL by ${d.max} levels${d.pixel}`,
      );
    }
  }
  // The static factories: the scene alone, then each pass attached by its own attach() inverting it.
  assert.deepEqual(await page.evaluate(() => window.check.plain()), []);
  const scene = await rgb(),
    inverted = scene.map((v) => 255 - v);
  assert.ok(
    scene.some((v) => v > 8 && v < 247),
    'the scene colour is not black or white, so inverting it shows',
  );
  for (const kind of ['shader', 'node']) {
    const name = kind === 'shader' ? 'ShaderPass' : 'NodePass',
      { errors: failures, plugins } = await page.evaluate((k) => window.check.attach(k), kind);
    assert.deepEqual(failures, [], name);
    assert.deepEqual(
      plugins,
      [`attached-${kind}-pass`, 'post:stack'],
      `${name}.attach adds the pass and its own PostStack`,
    );
    const d = compare(await rgb(), inverted);
    rows.push(`${name}.attach (inverts the scene): max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}`);
    assert.ok(d.max <= 1, `${name}.attach output differs from the inverted scene by ${d.max} levels${d.pixel}`);
    assert.deepEqual(
      await page.evaluate(() => window.check.detach()),
      [],
      `disposing the ${name} removes its PostStack`,
    );
  }
  assert.deepEqual(await page.evaluate(() => window.check.close()), []);
  assert.deepEqual(errors, []);
  console.log(rows.join('\n'));
  console.log(
    `ShaderPass ${compat ? 'WebGL2 layer' : 'native WebGPU'}: ${passFixtures.length} GLSL passes within 1 level of the browser's own WebGL, before and after a live change; ShaderPass.attach and NodePass.attach within 1 level of the inverted scene`,
  );
} finally {
  await context.close();
}
