// KB5700f regression: a sciviz surface captured unchanged repeats byte for byte where the GPU allows it. Opaque
// surfaces (opacity 1: no blending, depth write) and translucent surfaces that cover each pixel once (flat, tilted)
// must repeat exactly on WebGPU and on the WebGL2 compatibility layer. A translucent surface that folds over itself in
// its one draw is not bit-stable on NVIDIA (RTX A6000, D3D12 and ANGLE D3D11) and is stable on Apple M6 (Metal), with a
// raw-API page alone (scripts/reference-rendering/fold-blend-repeat.html; docs/limits.md, docs/upstream-reports/KB5700f):
// that case is reported, not asserted. From the repository root, with the GPU lock held:
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sciviz/tests/surface-repeat-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/surface-repeat.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => window.ready);
    const run = (o) => browser.page.evaluate((options) => window.repeat(options), o);
    const stable = [
      await run({ shape: 'folded', opacity: 1 }),
      await run({ shape: 'flat', opacity: 0.85 }),
      await run({ shape: 'tilted', opacity: 0.85 }),
    ];
    const folded = await run({ shape: 'folded', opacity: 0.85 });
    console.log(compat ? 'webgl2' : 'webgpu', JSON.stringify({ stable, folded, adapter: browser.hardware?.webgpu }));
    for (const r of stable) {
      assert.ok(r.drawn > 1000, `${r.shape} at ${r.opacity} draws the surface: ${r.drawn} pixels`);
      assert.equal(r.differing, 0, `${r.shape} at opacity ${r.opacity} repeats exactly: ${JSON.stringify(r)}`);
    }
    assert.ok(folded.drawn > 20000, 'the folded translucent surface draws');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
console.log('sciviz surface repeat check passed');
