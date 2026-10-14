// Real-GPU check of texture atlases and vertex animation textures (serial, under the GPU lock, on AC power).
// Run from the repository root after building packages: node examples/package-benchmarks/atlas-vat/check.mjs
//  - separate vs merged: 64 boxes with their own checker textures, then one atlas-mapped merged mesh: same image, 64 -> 1 draws.
//  - gltf vs vat1: RobotExpressive at Walking 0.37 s through gltf-pro + GPU skinning, then one VATCrowd instance at the same
//    time: the silhouettes must match (proves bake rows, texel indexing and frame interpolation on the GPU).
//  - crowd: 1,024 walking robots in one draw, per-instance clip time and atlas tint; frame times recorded.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const context = await openBrowser({startPath: '/examples/package-benchmarks/atlas-vat/check.html', port: 5233}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());});
const shot = async name => decodePNG(await page.locator('canvas').screenshot({path: `test-results/atlas-vat-${name}.png`}));
const mode = async name => {const r = await page.evaluate(n => window.check.mode(n), name); assert.equal(r.error, null, name); assert.deepEqual(r.errors, [], name); return r;};
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 120000});
  const results = {adapter: hardware.webgpu, browser: hardware.browserVersion, ...(await page.evaluate(() => window.check.info()))}, images = {};
  for (const name of ['separate', 'merged', 'gltf', 'vat1', 'crowd']) {results[name] = await mode(name); images[name] = await shot(name); console.log(name, JSON.stringify(results[name]));}
  results.crowd.timing = await page.evaluate(() => window.check.measure(120));
  const diff = (a, b) => {let d = 0; for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) d += Math.abs(a.data[i + c] - b.data[i + c]); return +(d / (a.width * a.height * 3)).toFixed(2);};
  // Covered = differs from the clear colour (top-left pixel): dark robot parts still count as robot.
  const mask = (img, i) => Math.abs(img.data[i] - img.data[0]) + Math.abs(img.data[i + 1] - img.data[1]) + Math.abs(img.data[i + 2] - img.data[2]) > 6;
  let both = 0, either = 0; const a = images.gltf, b = images.vat1;
  for (let i = 0; i < a.data.length; i += 4) {const x = mask(a, i), y = mask(b, i); if (x && y) both++; if (x || y) either++;}
  results.atlasMeanAbsDiff = diff(images.separate, images.merged); results.vatSilhouetteIoU = +(both / either).toFixed(4); results.vatPixels = either;
  console.log(JSON.stringify({atlasMeanAbsDiff: results.atlasMeanAbsDiff, vatSilhouetteIoU: results.vatSilhouetteIoU, crowd: results.crowd}));
  assert.equal(results.separate.drawCalls, 64); assert.equal(results.merged.drawCalls, 1); assert.ok(results.atlasMeanAbsDiff < 2, 'merged atlas frame looks like the separate one');
  assert.equal(results.vat1.drawCalls, 1); assert.equal(results.crowd.drawCalls, 1); assert.ok(either > 5000 && results.vatSilhouetteIoU > 0.97, 'VAT pose matches the GPU-skinned pose');
  assert.deepEqual(pageErrors, []); await writeFile('test-results/atlas-vat-check.json', JSON.stringify(results, null, 1)); console.log('atlas + VAT browser check passed');
} finally {await context.close();}
