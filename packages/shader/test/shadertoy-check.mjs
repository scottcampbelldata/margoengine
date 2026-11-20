// Shadertoy on the GPU: every source of test/shadertoy-fixtures.js runs as toy.pass() in a PostStack, as toy.texture
// shown by a pass, and as toy.material() on a quad, and as the same wrapped GLSL in the browser's own WebGL2 with the
// same inputs, textures and GL matrices; the two agree within 1 level per channel at every pixel, at the first inputs
// and after a live change. Run natively and with --compat (the WebGL2 layer): both legs meet the same bound.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { toyFixtures, multiFixtures, cubeFixtures, cubeDirection, vrFixture, soundFixtures } from './shadertoy-fixtures.js';

const context = await openBrowser({ startPath: '/packages/shader/test/shadertoy-check.html', port: 'free' }),
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
  let runs = 0;
  for (let i = 0; i < toyFixtures.length; i++) {
    const f = toyFixtures[i];
    for (const mode of await page.evaluate((n) => window.check.modes(n), i)) {
      assert.deepEqual(await page.evaluate(([n, m]) => window.check.draw(n, m), [i, mode]), [], `${f.name} as ${mode}`);
      for (const which of [1, 2]) {
        if (which === 2) assert.deepEqual(await page.evaluate(() => window.check.change()), [], `${f.name} as ${mode}`);
        const got = await rgb(),
          want = await page.evaluate(([n, m, w]) => window.check.oracle(n, m, w), [i, mode, which]),
          d = compare(got, want),
          label = `${f.name} as ${mode} (${which === 1 ? 'first' : 'changed'})`;
        assert.equal(got.length, want.length, 'pixel counts');
        assert.ok(new Set(want).size > 16, `${label}: the oracle image varies`);
        rows.push(`${label}: max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}`);
        assert.ok(d.max <= 1, `${label} differs from the browser's own WebGL2 by ${d.max} levels${d.pixel}`);
        runs++;
      }
    }
  }
  // Multipass: buffers fed back over several frames, keyboard, audio and video channels, after the last frame.
  for (let i = 0; i < multiFixtures.length; i++) {
    const f = multiFixtures[i];
    for (const mode of await page.evaluate((n) => window.check.multiModes(n), i)) {
      assert.deepEqual(await page.evaluate(([n, m]) => window.check.multi(n, m), [i, mode]), [], `${f.name} as ${mode}`);
      const got = await rgb(),
        want = await page.evaluate(([n, m]) => window.check.multiOracle(n, m), [i, mode]),
        d = compare(got, want),
        label = `${f.name} as ${mode} (${f.frames} frames)`;
      assert.equal(got.length, want.length, 'pixel counts');
      assert.ok(new Set(want).size > 16, `${label}: the oracle image varies`);
      rows.push(`${label}: max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}`);
      assert.ok(d.max <= 1, `${label} differs from the browser's own WebGL2 by ${d.max} levels${d.pixel}`);
      runs++;
    }
  }
  // Cube A, through the same multipass check; the first fixture's image is also held against the directions it asks
  // for (0.5 + 0.5 x the unit direction), which tests the face layout against the browser's own cube lookups.
  for (let i = 0; i < cubeFixtures.length; i++) {
    const f = cubeFixtures[i];
    for (const mode of await page.evaluate((n) => window.check.multiModes(n, 'cube'), i)) {
      assert.deepEqual(await page.evaluate(([n, m]) => window.check.multi(n, m, 'cube'), [i, mode]), [], `${f.name} as ${mode}`);
      const got = await rgb(),
        want = await page.evaluate(([n, m]) => window.check.multiOracle(n, m, 'cube'), [i, mode]),
        d = compare(got, want),
        label = `${f.name} as ${mode} (${f.frames} frames)`;
      assert.equal(got.length, want.length, 'pixel counts');
      assert.ok(new Set(want).size > 16, `${label}: the oracle image varies`);
      rows.push(`${label}: max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}`);
      assert.ok(d.max <= 1, `${label} differs from the browser's own WebGL2 by ${d.max} levels${d.pixel}`);
      runs++;
      if (f.analytic && mode === 'pass') {
        const expected = [];
        for (let y = 0; y < 32; y++)
          for (let x = 0; x < 32; x++) {
            const v = cubeDirection(x + 0.5, 31 - y + 0.5, 32, 32),
              l = Math.hypot(...v);
            for (const c of v) expected.push(Math.round((0.5 + (0.5 * c) / l) * 255));
          }
        const a = compare(want, expected);
        rows.push(`${f.name}: the browser's cube lookups against the directions: max ${a.max}, mean ${a.mean.toFixed(4)}${a.pixel}`);
        assert.ok(a.max <= 1, `the faces of Cube A are laid out against the browser's cube lookups: ${a.max} levels${a.pixel}`);
      }
    }
  }
  // mainVR from a fixed pair of eyes, as a pass and as a mesh material.
  for (let eye = 0; eye < vrFixture.eyes.length; eye++)
    for (const mode of ['pass', 'mesh']) {
      assert.deepEqual(await page.evaluate(([e, m]) => window.check.vr(e, m), [eye, mode]), [], `mainVR eye ${eye} as ${mode}`);
      const got = await rgb(),
        want = await page.evaluate(([e, m]) => window.check.vrOracle(e, m), [eye, mode]),
        d = compare(got, want),
        label = `${vrFixture.name}, eye ${eye} as ${mode}`;
      assert.ok(new Set(want).size > 16, `${label}: the oracle image varies`);
      rows.push(`${label}: max ${d.max}, mean ${d.mean.toFixed(4)}${d.pixel}`);
      assert.ok(d.max <= 1, `${label} differs from the browser's own WebGL2 by ${d.max} levels${d.pixel}`);
      runs++;
    }
  // mainSound: every sample against WebGL2 after 16-bit quantisation.
  for (let i = 0; i < soundFixtures.length; i++) {
    const f = soundFixtures[i],
      r = await page.evaluate((n) => window.check.sound(n), i),
      n = Math.ceil(f.seconds * f.sampleRate);
    assert.deepEqual(r.errors, [], f.name);
    assert.deepEqual(r.length, [n, n, n], `${f.name}: one sample per channel per 1/sampleRate`);
    assert.equal(r.checked, 2 * n);
    assert.equal(r.sampleRate, f.sampleRate);
    assert.ok(r.same, `${f.name}: audioBuffer holds the samples`);
    assert.equal(r.reason, 'stopped', `${f.name}: an aborted render rejects with the signal's reason`);
    if (i === 0) assert.ok(r.ends > 0, `${f.name}: values past 1 are clamped`);
    rows.push(`${f.name}: ${n} samples, max ${r.max} steps of 1/32767${r.where < 0 ? '' : ` at sample ${r.where}`}`);
    assert.ok(r.max <= 1, `${f.name} differs from the browser's own WebGL2 by ${r.max} steps at sample ${r.where}`);
    runs++;
  }
  assert.deepEqual(await page.evaluate(() => window.check.close()), []);
  assert.deepEqual(errors, []);
  console.log(rows.join('\n'));
  console.log(
    `Shadertoy ${compat ? 'WebGL2 layer' : 'native WebGPU'}: ${runs} images and sounds of ${toyFixtures.length + multiFixtures.length + cubeFixtures.length + 1 + soundFixtures.length} programs within 1 level (a sound within 1 step of 1/32767) of the browser's own WebGL2`,
  );
} finally {
  await context.close();
}
