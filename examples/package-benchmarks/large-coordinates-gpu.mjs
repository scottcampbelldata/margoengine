// Real-GPU jitter of a 10 mm flange 0 m / 1 km / 100 km / 6,000 km from the origin, core alone vs FloatingOrigin.
// Run on AC power holding the GPU lock, after npm run build:packages (timing part: node scripts/quiet-gate.mjs first):
//   node examples/package-benchmarks/large-coordinates-gpu.mjs [--cost]
// Each (kind, mode, distance) renders the same 40-frame orbit + dolly; every frame is compared with the same kind
// rendered by core near the origin. Per frame: silhouette centroid offset (px, sub-pixel) and pixels whose coverage
// differs (XOR of the masks). Jitter = largest frame-to-frame change of the centroid offset. Results:
// examples/package-benchmarks/results/large-coordinates-gpu.json, frame 0 PNGs in test-results/large-coordinates-*.png.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {openBrowser} from '../../scripts/browser.js';
import {decodePNG} from '../../tests/support/png.js';
import {DISTANCES, FRAMES} from './large-coordinates-scene.js';

const ac = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim();
assert.equal(ac(), 'True', 'measure on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/large-coordinates.html', port: 5233}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
const result = {gpu: hardware.webgpu, browser: hardware.browserName + ' ' + hardware.browserVersion, runs: [], cost: []};
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60000});
  const capture = async path => {
    const png = await decodePNG(await page.locator('canvas').screenshot(path ? {path} : {})), {width, height, data} = png, mask = new Uint8Array(width * height);
    const bg = data.slice(0, 3); let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < width * height; i++) if (Math.max(...[0, 1, 2].map(c => Math.abs(data[i * 4 + c] - bg[c]))) > 16) {mask[i] = 1; n++; sx += i % width; sy += Math.floor(i / width);}
    return {mask, n, cx: sx / n, cy: sy / n, data};
  };
  for (const kind of ['core', 'gltf']) {
    const reference = [];
    for (const mode of ['core', 'origin']) for (const distance of DISTANCES) {
      const setup = await page.evaluate(([k, m, d]) => window.check.setup(k, m, d), [kind, mode, distance]); assert.deepEqual(setup.errors, []);
      const frames = []; let rebases = 0;
      for (let k = 0; k < FRAMES; k++) {
        const r = await page.evaluate(k => window.check.frame(k), k); assert.deepEqual(r.errors, []); rebases = r.rebases;
        const shot = await capture(k === 0 ? `test-results/large-coordinates-${kind}-${mode}-${distance}.png` : undefined);
        if (mode === 'core' && distance === 0) reference.push(shot);
        const ref = reference[k]; let xor = 0, diff = 0;
        for (let i = 0; i < shot.mask.length; i++) {xor += shot.mask[i] ^ ref.mask[i]; for (let c = 0; c < 3; c++) diff += Math.abs(shot.data[i * 4 + c] - ref.data[i * 4 + c]);}
        frames.push({dx: shot.n ? shot.cx - ref.cx : NaN, dy: shot.n ? shot.cy - ref.cy : NaN, xor, pixels: shot.n, meanDiff: diff / shot.mask.length / 3});
      }
      // Pick a pixel well inside the reference silhouette of the last frame (the flange centre is its hole).
      const last = reference[FRAMES - 1], inside = i => [-3, 0, 3].every(dy => [-3, 0, 3].every(dx => last.mask[i + dy * 640 + dx])), at = last.mask.findIndex((v, i) => v && inside(i));
      const pick = await page.evaluate(([x, y]) => window.check.pick(x, y), [at % 640, Math.floor(at / 640)]);
      let jitter = 0; for (let k = 1; k < FRAMES; k++) jitter = Math.max(jitter, Math.hypot(frames[k].dx - frames[k - 1].dx, frames[k].dy - frames[k - 1].dy));
      const run = {kind, mode, distance, rebases, pick, coveredPixels: frames[0].pixels,
        maxOffsetPx: Math.max(...frames.map(f => Math.hypot(f.dx, f.dy))), jitterPx: jitter, maxXorPixels: Math.max(...frames.map(f => f.xor)), maxMeanColorDiff: Math.max(...frames.map(f => f.meanDiff))};
      result.runs.push(run);
      const fmt = v => Number.isNaN(v) ? 'gone' : v.toFixed(3);
      console.log(`${kind.padEnd(4)} ${mode.padEnd(6)} ${String(distance).padStart(8)} m: offset ${fmt(run.maxOffsetPx)} px, jitter ${fmt(run.jitterPx)} px, xor ${run.maxXorPixels} of ${run.coveredPixels} px, colour ${run.maxMeanColorDiff.toFixed(3)}, pick ${pick}, rebases ${rebases}`);
    }
  }
  if (process.argv.includes('--cost')) for (const n of [10_000, 50_000]) {const r = await page.evaluate(n => window.check.cost(n), n); assert.deepEqual(r.errors, []); result.cost.push(r); console.log(JSON.stringify(r));}
  assert.deepEqual(pageErrors, []);
} finally {await context.close();}
assert.equal(ac(), 'True', 'still on AC power');
writeFileSync('examples/package-benchmarks/results/large-coordinates-gpu.json', JSON.stringify(result, (k, v) => Number.isNaN(v) ? null : v, 2) + '\n');
console.log('large coordinates GPU check done');
