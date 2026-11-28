// KB-WEATHER-MATERIALSWET1: Puddles and Snow wet a @margoengine/materials Material as they wet a core PbrMaterial of
// the same inputs, on WebGPU and (with --compat) on the WebGL2 layer. Run from the repository root:
//   node packages/weather/tests/material-wet-browser.mjs [--compat]
// Before the fix a Material mesh stayed dry under the weather, so its wet and snowy pictures were the dry one.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close } = await openBrowser({ startPath: '/packages/weather/tests/material-wet-check.html', port: 'free' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.run());
  const receipt = JSON.stringify(r);
  assert.deepEqual(errors, []);
  assert.deepEqual(r.errors, [], receipt);
  assert.equal(r.validation, null, receipt);
  assert.equal(r.compat, process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1', receipt);
  // Dry, the two renderers draw the same ground: the baseline the wet comparison rests on.
  assert.ok(r.dry.pixels > 20_000 && r.dry.off === 0 && r.dry.mean < 1e-5, `dry: ${receipt}`);
  // Wet (with standing water and rain rings) and snowed on, the Material matches the core surface.
  for (const leg of ['wet', 'snow'])
    assert.ok(r[leg].pixels > 20_000 && r[leg].off === 0 && r[leg].mean < 1e-5, `${leg}: ${receipt}`);
  // The weather changes both, so the match is not two dry pictures.
  for (const leg of ['coreWetChange', 'materialWetChange', 'coreSnowChange', 'materialSnowChange'])
    assert.ok(r[leg].off > 0.5 * r[leg].pixels, `${leg}: ${receipt}`);
  // Removing the weather dries the Material again, and a mesh with sceneSurfaces false never gets wet.
  assert.equal(r.restored.off + r.coreRestored.off, 0, receipt);
  assert.equal(r.optOut.off, 0, receipt);
  console.log(
    `KB-WEATHER-MATERIALSWET1 ${r.compat ? 'WebGL2 layer' : 'WebGPU'}: wet Material matches core over ${r.wet.pixels} px (mean ${r.wet.mean.toExponential(1)}), snow over ${r.snow.pixels} px (mean ${r.snow.mean.toExponential(1)}).`,
  );
} finally {
  await close();
}
