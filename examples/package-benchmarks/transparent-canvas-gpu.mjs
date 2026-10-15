// Real-GPU check of TransparentCanvas from @margoengine/environment (run on AC power, holding the GPU lock, after npm run build:packages, with the
// pre-fix post build copied to test-results/post-before):
//   node examples/package-benchmarks/transparent-canvas-gpu.mjs
// 1. Transparent canvas over a magenta page: empty pixels show the page, the box covers it, and silhouette pixels are
//    valid premultiplied blends (the frame over black and over white gives alpha and premultiplied colour): core
//    WebGPU, after a device restore, the transparent WebGL renderer, Tonemap, FXAA, Bloom, SSAO and a PostStack.
//    After dispose() the canvas is opaque again.
// 2. Opaque canvas: FXAA, Bloom, SSAO and the stack render byte-identical frames before and after the alpha fixes.
// Frames go to test-results/transparent-*.png.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {openBrowser} from '../../scripts/browser.js';
import {decodePNG} from '../../tests/support/png.js';

const ac = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim();
assert.equal(ac(), 'True', 'measure on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/transparent-canvas.html', port: 5223}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
const report = {gpu: hardware.webgpu, browser: hardware.browserName + ' ' + hardware.browserVersion, transparent: {}, opaque: {}};
const grab = async name => await decodePNG(await page.locator('canvas').screenshot(name ? {path: `test-results/transparent-${name}.png`} : {}));
// The same frame over black and white recovers each pixel's alpha (1 - (white - black) / 255) and premultiplied colour (the black shot).
const shot = async (scenario, layers = false) => {
  const result = await page.evaluate(s => window.check.run(s), scenario), png = await grab(scenario.replaceAll(':', '-'));
  let black, white; if (layers) {await page.evaluate(() => window.check.background('#000')); black = await grab(); await page.evaluate(() => window.check.background('#fff')); white = await grab();}
  await page.evaluate(() => window.check.clear()); return {result, png, black, white};
};
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60000});
  for (const effect of ['none', 'restore', 'tonemap', 'fxaa', 'bloom', 'ssao', 'stack', 'webgl']) {
    const {result, png, black, white} = await shot(effect === 'webgl' ? 'new:none:webgl2:t' : `new:${effect}:webgpu:t`, true), at = (x, y) => Array.from(png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 3));
    let partial = 0, fringe = 0, worst = 0;
    for (let i = 0; i < black.data.length; i += 4) {
      let alpha = 0; for (let c = 0; c < 3; c++) alpha += 1 - (white.data[i + c] - black.data[i + c]) / 255; alpha /= 3;
      if (alpha > 0.03 && alpha < 0.97) partial++;
      const excess = Math.max(...[0, 1, 2].map(c => black.data[i + c] - alpha * 255)); worst = Math.max(worst, excess); if (excess > 6) fringe++;
    }
    const row = report.transparent[effect] = {backend: result.backend, errors: result.errors, corner: at(2, 2), center: at(128, 128), partialPixels: partial, fringePixels: fringe, worstExcess: Math.round(worst)};
    console.log('transparent', effect, JSON.stringify(row));
    assert.deepEqual(result.errors, [], effect);
    assert.ok(Math.abs(row.corner[0] - 255) <= 2 && row.corner[1] <= 2 && Math.abs(row.corner[2] - 255) <= 2, `${effect}: empty pixels show the page`);
    assert.ok(row.center[1] > 60 && row.center[0] < 200, `${effect}: the box covers the page`);
  }
  {const {png} = await shot('new:removed:webgpu:t'), i = (2 * png.width + 2) * 4, corner = Array.from(png.data.slice(i, i + 3));
    report.removed = {corner}; console.log('removed', JSON.stringify(report.removed)); assert.ok(corner[0] < 40 && corner[2] < 40, 'dispose() makes the canvas opaque again');}
  for (const effect of ['fxaa', 'bloom', 'ssao', 'stack']) {
    const a = (await shot(`old:${effect}:webgpu:o`)).png, b = (await shot(`new:${effect}:webgpu:o`)).png;
    let max = 0, differing = 0; for (let i = 0; i < a.data.length; i++) if (i % 4 < 3) {const v = Math.abs(a.data[i] - b.data[i]); max = Math.max(max, v); if (v) differing++;}
    report.opaque[effect] = {maxDiff: max, differingChannels: differing}; console.log('opaque', effect, JSON.stringify(report.opaque[effect]));
  }
  assert.deepEqual(pageErrors, []);
} finally {await context.close();}
assert.equal(ac(), 'True', 'still on AC power');
for (const effect of ['none', 'restore', 'webgl']) assert.equal(report.transparent[effect].fringePixels, 0, `${effect}: premultiplied edges`);
for (const [effect, row] of Object.entries(report.opaque)) assert.equal(row.maxDiff, 0, `${effect}: opaque output unchanged`);
console.log(JSON.stringify(report));
console.log('transparent canvas GPU check passed');
