import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const half = (h) => {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >> 10) & 31,
    m = h & 1023;
  return s * (e ? 2 ** (e - 15) * (1 + m / 1024) : (2 ** -14 * m) / 1024);
};
const maximum = (a, b) => a.reduce((max, v, i) => Math.max(max, Math.abs(half(v) - half(b[i]))), 0);
const report = { checks: [], samples: [] };
for (const samples of [1, 4]) {
  const h = await openBrowser({
    startPath: `/packages/loaders/tests/render-browser.html?samples=${samples}`,
    port: 5197,
  });
  try {
    const errors = [];
    h.page.on('pageerror', (e) => errors.push(e.message));
    if (process.env.LOADER_RENDER_FAULT === 'opacity') {
      await h.page.route('**/packages/loaders/dist/render.js*', async (route) => {
        const response = await route.fetch(),
          body = await response.text();
        const faulty = body.replace('const alpha = opacity?.[source] ?? fallback?.[3] ?? 1;', 'const alpha = 1;');
        assert.notEqual(body, faulty, 'opacity fault control was not applied');
        await route.fulfill({ response, body: faulty });
      });
      await h.page.reload();
    }
    await h.page.waitForFunction(() => window.loaderRenderFixture);
    const draw = (options) => h.page.evaluate((o) => window.loaderRenderFixture.draw(o), options);
    const actual = await draw(),
      reference = await draw({ reference: true });
    const controlError = maximum(actual, reference);
    assert.ok(controlError <= 0.0005, `reference difference ${controlError}`);
    const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const colors = [
        [0.8, 0.2, 0.1],
        [0.1, 0.7, 0.3],
        [0.2, 0.3, 0.9],
      ].map((c) => c.map(linear)),
      opacity = [0.2, 0.6, 1],
      factor = [0.7, 0.8, 0.6, 0.75];
    const background = actual.slice(0, 3).map(half);
    let analyticError = 0;
    for (const [x, y] of [
      [96, 160],
      [160, 160],
      [128, 96],
      [128, 176],
    ]) {
      const px = (x + 0.5) / 64 - 2,
        py = 2 - (y + 0.5) / 64,
        c = (py + 1.5) / 3,
        b = (px + 1.5 - 1.5 * c) / 3,
        weights = [1 - b - c, b, c];
      const alpha = weights.reduce((sum, w, i) => sum + w * opacity[i], 0) * factor[3];
      for (let k = 0; k < 3; k++) {
        const expected =
          weights.reduce((sum, w, i) => sum + w * colors[i][k], 0) * factor[k] * alpha + background[k] * (1 - alpha);
        analyticError = Math.max(analyticError, Math.abs(half(actual[(y * 256 + x) * 4 + k]) - expected));
      }
    }
    assert.ok(analyticError < 0.001, `analytic RGBA error ${analyticError}`);
    const fault = await draw({ fault: true }),
      faultDifference = maximum(actual, fault);
    assert.ok(faultDifference > 0.1, `averaged RGBA fault was not detected ${faultDifference}`);
    const mirrorReference = await draw({ reference: true, mirror: true }),
      mirrored = await draw({ mirror: true });
    assert.ok(maximum(mirrored, mirrorReference) <= 0.0005);
    const restored = await h.page.evaluate(() => window.loaderRenderFixture.restore());
    assert.equal(restored.replaced, true);
    assert.equal(maximum(mirrored, restored.image), 0);
    const fallback = await draw({ groupFallback: true });
    const expectedFallback = [0.5, 0.25, 0.75].map(
      (c, i) => linear(c) * factor[i] * 0.4 * factor[3] + background[i] * (1 - 0.4 * factor[3]),
    );
    expectedFallback.forEach((v, i) => assert.ok(Math.abs(half(fallback[(160 * 256 + 128) * 4 + i]) - v) < 0.001));
    const cleared = await h.page.evaluate(() => window.loaderRenderFixture.clear());
    assert.equal(cleared.meshes, 0);
    assert.ok(cleared.image.every((v, i) => v === actual[i % 4]));
    assert.deepEqual(restored.errors, []);
    assert.deepEqual(cleared.errors, []);
    assert.deepEqual(errors, []);
    report.samples.push({
      samples,
      controlError,
      analyticError,
      faultDifference,
      restoredIdentical: true,
      hardware: h.hardware,
    });
    report.checks.push(
      `${samples}x RGBA analytic + independent PBR control, material multiplier, fault control, mirrored front face, group fallback, device replacement, disposal`,
    );
    await h.page.evaluate(() => window.loaderRenderFixture.dispose());
  } finally {
    await h.close();
  }
}
await writeFile('test-results/loaders-render-browser.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
