// Real-GPU check and cost of SSR (@margoengine/post/ssr). Run on AC power, holding the GPU lock, after npm run build:packages:
//   node examples/package-benchmarks/ssr-gpu.mjs [--rounds=3] [--frames=90] [--no-timing] [--diagnostic]
// Correctness (ssr.html): each scene is rendered with SSR on and off in the same PostStack pipeline.
// 1. Mirror floor (roughness 0), perspective 4x/1x and orthographic: the red box appears in the floor exactly inside the
//    projected planar-mirror bounds and at the mirrored centre; the floor's IBL specular is replaced, not added (green
//    at the mirrored centre falls from the grey environment reflection to the red box's).
// 2. Rough floor (0.45): the reflection is wider-edged (blurred) and weaker; roughness 0.8 (> maxRoughness): identical.
// 3. Box off-screen (above the view): SSR cannot see it, the floor keeps the IBL: the frame is unchanged.
// 4. With TAA and with SSAO in the stack: no errors, reflection present. No black (NaN) pixels anywhere.
// Timing: own GPU passes of SSR at 1280x720 and 1920x1080, 4x and 1x MSAA (bench scene: 14 boxes), alternating rounds.
// Run `node scripts/quiet-gate.mjs` first for publishable timings; --diagnostic labels them as taken on a busy machine.
// Writes examples/package-benchmarks/results/ssr-gpu.json, frames to test-results/ssr-*.png.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {openBrowser} from '../../scripts/browser.js';
import {decodePNG} from '../../tests/support/png.js';
import {acPower} from './cad/power.mjs';

const arg = (name, fallback) => {const a = process.argv.find(v => v.startsWith(`--${name}`)); return a ? (a.includes('=') ? +a.split('=')[1] : true) : fallback;};
const rounds = arg('rounds', 3), frames = arg('frames', 90);
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim(), acPowerBefore: acPower(), checks: {}, timing: {}, timingLabel: arg('diagnostic', false) ? 'diagnostic (machine not quiet-gated)' : 'after scripts/quiet-gate.mjs'};
assert.equal(report.acPowerBefore, true, 'run on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/ssr.html', port: 5251, args: ['--enable-webgpu-developer-features']}), {page, hardware} = context, pageErrors = [];
page.setDefaultTimeout(120_000);
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
report.gpu = hardware.webgpu; report.browser = hardware.browserName + ' ' + hardware.browserVersion;
const px = (img, x, y) => {const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]];};
const grab = async name => decodePNG(await page.locator('canvas').screenshot({path: `test-results/ssr-${name}.png`}));
async function pair(name, config) {
  const info = await page.evaluate(c => window.check.run(c), config); assert.deepEqual(info.errors, [], name);
  const on = await grab(name + '-on'); assert.deepEqual((await page.evaluate(() => window.check.toggle(false))).errors, [], name);
  const off = await grab(name + '-off');
  // Pixels the effect changed into "red" (R - G > 60 with SSR, not without), their bounds, and black pixels SSR introduced.
  let red = 0, outside = 0, black = 0, maxDiff = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; const [mx0, my0, mx1, my1] = info.mirror;
  for (let y = 0; y < on.height; y++) for (let x = 0; x < on.width; x++) {
    const a = px(on, x, y), b = px(off, x, y); maxDiff = Math.max(maxDiff, ...a.map((v, i) => Math.abs(v - b[i])));
    if (a[0] + a[1] + a[2] === 0 && b[0] + b[1] + b[2] > 0) black++;
    if (a[0] - a[1] > 60 && !(b[0] - b[1] > 60)) {red++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); if (x < mx0 - 3 || x > mx1 + 3 || y < my0 - 3 || y > my1 + 3) outside++;}
  }
  const [cx, cy] = info.center, inside = cx >= 0 && cy >= 0 && cx < on.width && cy < on.height;
  return {name, info, on, off, row: {mirrorBounds: info.mirror, mirroredCenter: info.center, redPixels: red, redBounds: red ? [x0, y0, x1, y1] : null, redOutsideMirror: outside, blackIntroduced: black, maxDiff,
    centerOn: inside ? px(on, cx, cy) : null, centerOff: inside ? px(off, cx, cy) : null}};
}
// 10-90% edge width of the reflection along the mirrored centre row (left edge), in pixels.
function edgeWidth(img, info) {
  const y = info.center[1], from = Math.max(0, info.mirror[0] - 30), to = info.center[0], v = []; for (let x = from; x <= to; x++) {const p = px(img, x, y); v.push(p[0] - p[1]);}
  const lo = Math.min(...v), hi = Math.max(...v), a = v.findIndex(s => s > lo + 0.1 * (hi - lo)), b = v.findIndex(s => s > lo + 0.9 * (hi - lo)); return {width: b - a, contrast: hi - lo};
}
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60_000});
  const results = {};
  for (const [name, config] of Object.entries({
    'mirror-4x': {roughness: 0}, 'mirror-1x': {roughness: 0, samples: 1}, 'ortho-4x': {roughness: 0, camera: 'ortho'},
    'rough-0.3': {roughness: 0.3}, 'rough-0.45': {roughness: 0.45}, 'rough-0.8': {roughness: 0.8}, 'offscreen': {roughness: 0, camera: 'offscreen'},
    'taa': {roughness: 0, taa: true, frames: 24}, 'ssao+ssr': {roughness: 0, ssao: true},
  })) {const r = results[name] = await pair(name, config); report.checks[name] = r.row; console.log(name, JSON.stringify(r.row));}
  for (const [name, r] of Object.entries(results)) assert.equal(r.row.blackIntroduced, 0, `${name}: SSR introduced black (NaN) pixels`);
  for (const name of ['mirror-4x', 'mirror-1x', 'ortho-4x', 'taa', 'ssao+ssr']) {
    const r = results[name].row;
    assert.ok(r.redPixels > 200, `${name}: no reflection`);
    // 4x silhouette pixels resolve the box's and the floor's materials together (a few px); TAA's jitter and history blur edges.
    if (name !== 'taa') assert.ok(r.redOutsideMirror <= Math.max(8, r.redPixels * 0.002), `${name}: reflected pixels outside the planar-mirror bounds`);
    assert.ok(r.centerOn[0] - r.centerOn[1] > 60, `${name}: mirrored centre is not red`);
    // Double counting check: without SSR the floor shows the grey IBL reflection (G high); with SSR that specular is
    // replaced by the red box (G drops to the box's own small green). Added on top, G would stay at least as high.
    assert.ok(r.centerOn[1] < 0.5 * r.centerOff[1], `${name}: IBL specular not replaced (G ${r.centerOn[1]} vs ${r.centerOff[1]})`);
  }
  const sharp = edgeWidth(results['mirror-4x'].on, results['mirror-4x'].info), soft = edgeWidth(results['rough-0.3'].on, results['rough-0.3'].info);
  report.checks.blur = {mirrorEdge: sharp, rough03Edge: soft}; console.log('blur', JSON.stringify(report.checks.blur));
  assert.ok(soft.width > sharp.width + 2, 'rough floor: reflection not blurred');
  assert.ok(results['rough-0.45'].row.centerOn[0] - results['rough-0.45'].row.centerOn[1] < results['mirror-4x'].row.centerOn[0] - results['mirror-4x'].row.centerOn[1], 'rough floor: reflection not weaker');
  assert.ok(results['rough-0.8'].row.maxDiff <= 1, 'roughness above maxRoughness must be untouched');
  const off = results.offscreen;
  assert.ok(off.info.boxBottom < 0 && off.info.mirror[1] >= 0 && off.info.mirror[3] < off.on.height, 'offscreen scene: box above the view, its mirror image inside it');
  assert.ok(off.row.maxDiff <= 1 && off.row.redPixels === 0, 'off-screen box: SSR must fall back to IBL (frame unchanged)');

  if (!arg('no-timing', false)) {
    const configs = []; for (const size of [[1280, 720], [1920, 1080]]) for (const samples of [4, 1]) configs.push({size, samples, scene: 'bench', roughness: 0.1});
    const samples = {};
    for (let round = 0; round < rounds; round++) for (const config of round % 2 ? [...configs].reverse() : configs) for (const ssr of [true, false]) {
      assert.notEqual(acPower(), false, 'On battery mid-run');
      const key = `${config.size.join('x')} ${config.samples}x ${ssr ? 'ssr' : 'off'}`;
      const info = await page.evaluate(c => window.check.run(c), {...config, ssr, frames: 2}); assert.deepEqual(info.errors, [], key);
      let m; for (let attempt = 0; attempt < 3 && !(m && !m.error); attempt++) m = await page.evaluate(f => window.check.measure(f), frames); // Dawn sometimes zeroes a whole batch
      assert.ok(!m.error, m.error); assert.deepEqual(m.errors, [], key); m.ownerMs.ssr = Object.entries(m.ownerMs).filter(([k]) => k.startsWith('ssr')).reduce((t, [, v]) => t + v, 0);
      (samples[key] ??= []).push(m); console.log('round', round + 1, key, JSON.stringify({gpuMs: m.gpuMs, ssrMs: m.ownerMs.ssr}));
    }
    const median = a => {const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(3);};
    for (const [key, list] of Object.entries(samples)) report.timing[key] = {frameGpuMs: median(list.map(m => m.gpuMs)), ssrOwnMs: median(list.map(m => m.ownerMs.ssr ?? 0)), gbufferMs: median(list.map(m => m.ownerMs['ssr:gbuffer'] ?? 0)), traceMs: median(list.map(m => m.ownerMs['ssr:trace'] ?? 0)), stackMs: median(list.map(m => m.ownerMs.stack ?? 0)), sceneMs: median(list.map(m => m.ownerMs.scene ?? 0)), zeroFrames: list.reduce((t, m) => t + m.zeroFrames, 0)};
    console.log('timing', JSON.stringify(report.timing, null, 1));
  }
  await page.evaluate(() => window.check.teardown());
  assert.deepEqual(pageErrors, []);
} finally {await context.close();}
report.acPowerAfter = acPower(); assert.equal(report.acPowerAfter, true, 'ended on battery: discard this run');
writeFileSync('examples/package-benchmarks/results/ssr-gpu.json', JSON.stringify(report, null, 1) + '\n');
console.log('SSR GPU check passed; wrote examples/package-benchmarks/results/ssr-gpu.json');
