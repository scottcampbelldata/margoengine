// Real-GPU check of shadows for deformed casters and lighting for VAT crowds (HANDOFF 5l.j). Run from the repository root
// after `npm run build:packages`, with the GPU lock held:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/deformed-shadows/check.mjs [--timing]
//  - skinned: RobotExpressive walking (gltf-pro + GPU skinning) as the only caster; the shadow map's silhouette at two clip
//    times must differ, repeat exactly at the same time, and differ from the bind pose (Shadows reads the deformed buffer).
//  - crowd: 25 VAT robots under a floating slab. Without `shadows.add(crowd)` (B), without the crowd (C, which gives the
//    crowd's pixels), with it (A: the crowd casts onto the floor and is shadowed), then with EnvironmentLighting IBL (D).
//  - --timing: frame times (render + GPU completion) with and without casting; diagnostic unless the quiet gate passed.
// Writes test-results/deformed-shadows-*.png and test-results/deformed-shadows.json (with --timing also
// examples/package-benchmarks/results/deformed-shadows.json).
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
import {onAC, cpuLoad, waitForQuiet} from '../../../scripts/quiet-gate.mjs';

const context = await openBrowser({startPath: '/examples/package-benchmarks/deformed-shadows/check.html', port: 5239}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());});
const shot = async name => decodePNG(await page.locator('canvas').screenshot({path: `test-results/deformed-shadows-${name}.png`}));
const luma = (img, i) => 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 120000});
  const results = {adapter: hardware.webgpu, browser: hardware.browserVersion, acPower: onAC()};
  results.skinned = await page.evaluate(() => window.check.skinned(0.25, 0.75));
  for (const [name, t] of [['walk-0.25', 0.25], ['walk-0.75', 0.75]]) {assert.deepEqual(await page.evaluate(t => window.check.pose(t, true), t), [], name); await shot(name);}
  // Screen-space shadow of the robot: pixels darker with the robot casting than without, at each time.
  const poses = {};
  for (const t of [0.25, 0.75]) {await page.evaluate(t => window.check.pose(t, false), t); const plain = await shot(`walk-${t}-plain`); await page.evaluate(t => window.check.pose(t, true), t); const cast = await shot(`walk-${t}`);
    poses[t] = Array.from({length: plain.width * plain.height}, (_, p) => luma(plain, p * 4) - luma(cast, p * 4) > 12);}
  let both = 0, either = 0; for (let p = 0; p < poses[0.25].length; p++) {if (poses[0.25][p] && poses[0.75][p]) both++; if (poses[0.25][p] || poses[0.75][p]) either++;}
  results.skinned.screenShadow = {pixels025: poses[0.25].filter(Boolean).length, pixels075: poses[0.75].filter(Boolean).length, iou: +(both / either).toFixed(4)};
  const images = {};
  for (const step of ['B', 'C', 'A', 'D']) {results['crowd' + step] = await page.evaluate(s => window.check.crowd(s), step); images[step] = await shot('crowd-' + step);}
  const {B, C, A, D} = images, crowd = [], floor = [];
  for (let i = 0; i < B.data.length; i += 4) (Math.abs(luma(B, i) - luma(C, i)) > 6 ? crowd : floor).push(i);
  const mean = (img, set) => +(set.reduce((s, i) => s + luma(img, i), 0) / set.length).toFixed(2);
  results.crowd = {crowdPixels: crowd.length, crowdLuma: {B: mean(B, crowd), A: mean(A, crowd), D: mean(D, crowd)},
    floorDarkenedByCrowd: floor.filter(i => luma(B, i) - luma(A, i) > 12).length, crowdPixelsChangedByIbl: crowd.filter(i => Math.abs(luma(D, i) - luma(A, i)) > 6).length};
  if (process.argv.includes('--timing')) {
    let quiet = null; try {quiet = await waitForQuiet({timeout: 300});} catch (error) {quiet = {passed: false, reason: error.message, cpu: cpuLoad()};}
    results.timing = {...await page.evaluate(() => window.check.timing()), quiet, status: quiet?.passed === false ? 'diagnostic' : 'quiet-gated'};
  }
  console.log(JSON.stringify(results, null, 1));
  await writeFile('test-results/deformed-shadows.json', JSON.stringify(results, null, 1));
  if (results.timing) await writeFile('examples/package-benchmarks/results/deformed-shadows.json', JSON.stringify({recordedAt: new Date().toISOString(), ...results}, null, 1) + '\n');
  const s = results.skinned;
  assert.ok(s.texels.t1 > 500 && s.texels.t2 > 500, 'the walking robot casts');
  assert.equal(s.iou.t1_again, 1, 'same time, same silhouette');
  assert.ok(s.iou.t1_t2 < 0.9, `the shadow follows the pose (IoU ${s.iou.t1_t2})`); assert.ok(s.iou.t1_bind < 0.9, `the shadow is not the bind pose (IoU ${s.iou.t1_bind})`);
  assert.ok(s.screenShadow.pixels025 > 300 && s.screenShadow.iou < 0.9, 'the visible floor shadow changes with the pose');
  assert.ok(results.crowdA.silhouetteTexels > 1000, 'the VAT crowd is in the shadow map');
  assert.ok(results.crowd.floorDarkenedByCrowd > 500, 'the crowd casts onto the floor');
  assert.ok(results.crowd.crowdLuma.A < results.crowd.crowdLuma.B - 2, 'the crowd receives shadows');
  assert.ok(results.crowd.crowdPixelsChangedByIbl > results.crowd.crowdPixels * 0.3, 'IBL lights the crowd');
  for (const step of ['B', 'C', 'A', 'D']) assert.deepEqual(results['crowd' + step].errors, [], step);
  assert.deepEqual(s.errors, []); assert.deepEqual(results.timing?.errors ?? [], []); assert.deepEqual(pageErrors, []);
  console.log('deformed shadows GPU check passed');
} finally {await context.close();}
