// Real-GPU check of @margoengine/oit (run on AC power, holding the GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/oit-gpu.mjs [--only=colours,transparent,post,popping,timing]
// 1. Colours: 1, 2 and 4 unlit translucent planes (materials 'basic') over an opaque grey plane, MSAA 1x/4x, perspective
//    and orthographic: OIT against analytic sorted blending (the WBOIT approximation error) and against the WBOIT formula
//    (the implementation error); gltf-pro's sorted path against analytic blending as a control.
// 2. TransparentCanvas: OIT layers over an empty canvas give valid premultiplied alpha (frame over black and over white).
// 3. PostStack (Bloom + FXAA, HDR capture): no GPU errors; one layer equals the sorted path.
// 4. Popping: a 50% housing over two opaque gears and a 55% translucent gear (gltf-pro BLEND), orbited in 3 degree steps,
//    sorted and OIT against a per-triangle sorted reference: error per frame, its largest frame-to-frame jump, and the
//    pixels that change sharply between frames beyond what the reference itself changes (popping).
// 5. GPU time (Stats timestamp profiler, median) at 1280x720 and 1920x1080, MSAA 4x: opaque only, sorted, OIT; after
//    scripts/quiet-gate.mjs (numbers without a quiet machine are marked diagnostic).
// Writes results/oit-gpu.json and frames to test-results/oit-*.png.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openBrowser} from '../../scripts/browser.js';
import {waitForQuiet} from '../../scripts/quiet-gate.mjs';
import {decodePNG} from '../../tests/support/png.js';

const ac = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim();
const powerBefore = ac(); assert.equal(powerBefore, 'True', 'measure on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/oit.html', port: 5231}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
const report = {benchmark: 'oit-gpu', recordedAt: new Date().toISOString(), hardware: hardware.webgpu, browser: hardware.browserName + ' ' + hardware.browserVersion, powerOnline: {before: powerBefore}};

// Same values as oit.html.
const layerColors = [[0.9, 0.1, 0.1, 0.5], [0.1, 0.8, 0.2, 0.4], [0.1, 0.2, 0.9, 0.6], [0.9, 0.8, 0.1, 0.5]], layerZ = [0.6, 0.3, 0, -0.3], grey = 0.2, eye = 4;
const encode = x => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255;
const weight = d => Math.min(1000, Math.max(0.01, 10 / (d / eye) ** 6));
function expected(count, background = encode(grey)) {
  const layers = layerColors.slice(0, count).map(([r, g, b, a], i) => ({e: [r, g, b].map(encode), a, w: weight(eye - layerZ[i])}));
  let sorted = [background, background, background];
  for (let i = count - 1; i >= 0; i--) sorted = sorted.map((v, k) => layers[i].e[k] * layers[i].a + v * (1 - layers[i].a));
  const T = layers.reduce((t, l) => t * (1 - l.a), 1), sum = layers.reduce((s, l) => s + l.a * l.w, 0);
  const average = [0, 1, 2].map(k => layers.reduce((s, l) => s + l.e[k] * l.a * l.w, 0) / sum);
  return {sorted, wboit: average.map(v => v * (1 - T) + background * T), average, alpha: 1 - T};
}
const shot = async path => decodePNG(await page.locator('canvas').screenshot(path ? {path} : {}));
const centre = (png, size = 12) => {
  const s = [0, 0, 0]; let n = 0;
  for (let y = (png.height - size) >> 1; y < (png.height + size) >> 1; y++) for (let x = (png.width - size) >> 1; x < (png.width + size) >> 1; x++) {for (let k = 0; k < 3; k++) s[k] += png.data[(y * png.width + x) * 4 + k]; n++;}
  return s.map(v => v / n);
};
const maxDiff = (a, b) => +Math.max(...a.map((v, k) => Math.abs(v - b[k]))).toFixed(2);
const build = async options => {const info = await page.evaluate(o => window.check.build(o), options); const r = await page.evaluate(() => window.check.frames(4)); assert.deepEqual(r.errors, [], JSON.stringify(options)); return {...info, labels: r.labels};};
const clear = () => page.evaluate(() => window.check.clear());
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(','), want = name => !only || only.includes(name);

try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60000});
  // 1. Colours.
  if (want('colours')) report.colours = [];
  if (want('colours')) for (const samples of [1, 4]) for (const ortho of [false, true]) for (const mode of ['sorted', 'oit']) for (const count of [1, 2, 4]) {
    const info = await build({scene: 'layers', mode, samples, ortho, count, width: 256, height: 256});
    const pixel = centre(await shot(samples === 4 && !ortho && count === 4 ? `test-results/oit-layers-${mode}.png` : undefined)), want = expected(count);
    const row = {mode, samples, camera: ortho ? 'orthographic' : 'perspective', layers: count, pixel: pixel.map(v => +v.toFixed(1)), analytic: want.sorted.map(v => +v.toFixed(1)), wboitFormula: want.wboit.map(v => +v.toFixed(1)),
      errorVsAnalytic: maxDiff(pixel, want.sorted), errorVsFormula: maxDiff(pixel, want.wboit), passes: info.labels.filter(l => l.startsWith('oit:'))};
    report.colours.push(row); console.log(JSON.stringify(row)); await clear();
    if (mode === 'sorted') assert.ok(row.errorVsAnalytic <= 3, `sorted control ${JSON.stringify(row)}`);
    else {assert.ok(row.errorVsFormula <= 3, `OIT implementation ${JSON.stringify(row)}`); assert.deepEqual(row.passes, ['oit:accumulate', 'oit:composite']); if (count === 1) assert.ok(row.errorVsAnalytic <= 3, 'one layer is exact');}
  }
  // 2. TransparentCanvas: premultiplied alpha over the page.
  if (want('transparent')) report.transparentCanvas = [];
  if (want('transparent')) for (const count of [1, 2, 4]) {
    await build({scene: 'layers', mode: 'oit', samples: 4, count, width: 256, height: 256, transparent: true, background: false});
    await page.evaluate(() => window.check.background('#000')); const black = centre(await shot());
    await page.evaluate(() => window.check.background('#fff')); const white = centre(await shot());
    const want = expected(count, 0), alpha = 1 - (white[0] - black[0]) / 255, premultiplied = want.average.map(v => v * want.alpha);
    const row = {layers: count, alpha: +alpha.toFixed(3), expectedAlpha: +want.alpha.toFixed(3), overBlack: black.map(v => +v.toFixed(1)), expectedPremultiplied: premultiplied.map(v => +v.toFixed(1)), error: maxDiff(black, premultiplied),
      valid: black.every(v => v <= alpha * 255 + 2)};
    report.transparentCanvas.push(row); console.log('transparent', JSON.stringify(row)); await clear();
    assert.ok(Math.abs(alpha - want.alpha) <= 0.02 && row.error <= 3 && row.valid, `transparent canvas ${JSON.stringify(row)}`);
  }
  // 3. PostStack (HDR capture): OIT draws and composites inside the capture.
  if (want('post')) report.postStack = [];
  if (want('post')) for (const count of [1, 2, 4]) {
    const pixels = {};
    for (const mode of ['sorted', 'oit']) {const info = await build({scene: 'layers', mode, samples: 4, count, width: 256, height: 256, post: true}); pixels[mode] = centre(await shot()); pixels[mode + 'Passes'] = info.labels.filter(l => l.startsWith('oit:')); await clear();}
    const row = {layers: count, sorted: pixels.sorted.map(v => +v.toFixed(1)), oit: pixels.oit.map(v => +v.toFixed(1)), difference: maxDiff(pixels.sorted, pixels.oit), oitPasses: pixels.oitPasses};
    report.postStack.push(row); console.log('post', JSON.stringify(row));
    assert.deepEqual(row.oitPasses, ['oit:accumulate', 'oit:composite']); if (count === 1) assert.ok(row.difference <= 3, 'one layer under PostStack equals sorted');
  }
  // 4. Popping over an orbit in 1 degree steps. A pop is a pixel that jumps (> 16/255 in a channel) from one step to the
  // next where the reference stays put (<= 3/255): moving edges and shading changes are excluded because the reference
  // changes there too. Counted over the pixels the model covers (not background in the reference).
  if (want('popping')) {
    const steps = 360, size = {width: 640, height: 360}, reference = [], radius = 3.2, threshold = 16, still = 3;
    const rgb = png => {const out = new Uint8Array(png.width * png.height * 3); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {out[j] = png.data[i]; out[j + 1] = png.data[i + 1]; out[j + 2] = png.data[i + 2];} return out;};
    report.popping = {steps, degreesPerStep: 360 / steps, orbitRadius: radius, resolution: [size.width, size.height], samples: 4, popThreshold: threshold, referenceStillThreshold: still};
    let background;
    for (const mode of ['reference', 'sorted', 'oit']) {
      await build({scene: 'cad', mode, samples: 4, ...size}); let previous; const errors = [], p95 = [], pops = [];
      for (let k = 0; k <= steps; k++) {
        const r = await page.evaluate(([a, d]) => window.check.orbit(a, d), [k * 360 / steps, radius]); assert.deepEqual(r.errors, []);
        const frame = rgb(await shot());
        if (mode === 'reference') {background ??= frame.slice(0, 3); reference.push(frame);}
        else {
          const ref = reference[k], prev = reference[k - 1], diffs = []; let popped = 0, covered = 0;
          for (let i = 0; i < frame.length; i += 3) {
            if (ref[i] === background[0] && ref[i + 1] === background[1] && ref[i + 2] === background[2]) continue;
            covered++; let e = 0, d = 0, r = 0;
            for (let c = 0; c < 3; c++) {e = Math.max(e, Math.abs(frame[i + c] - ref[i + c])); if (previous) {d = Math.max(d, Math.abs(frame[i + c] - previous[i + c])); r = Math.max(r, Math.abs(ref[i + c] - prev[i + c]));}}
            diffs.push(e); if (previous && r <= still && d > threshold) popped++;
          }
          diffs.sort((a, b) => a - b); errors.push(diffs.reduce((a, b) => a + b, 0) / diffs.length); p95.push(diffs[Math.floor(diffs.length * 0.95)]);
          if (previous) pops.push({step: k, fraction: popped / covered});
        }
        previous = frame;
      }
      if (mode !== 'reference') {
        const worst = pops.reduce((a, b) => b.fraction > a.fraction ? b : a), mean = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
        const row = {meanErrorVsReference: mean(errors), maxMeanErrorVsReference: +Math.max(...errors).toFixed(2), meanP95ErrorVsReference: mean(p95), maxPoppedPixels: +(worst.fraction * 100).toFixed(2) + '%', worstStep: worst.step,
          stepsWithOver1PercentPopped: pops.filter(p => p.fraction > 0.01).length, stepsWithOver0_1PercentPopped: pops.filter(p => p.fraction > 0.001).length};
        report.popping[mode] = row; console.log('popping', mode, JSON.stringify(row));
        for (const k of [worst.step - 1, worst.step]) {await page.evaluate(([a, d]) => window.check.orbit(a, d), [k * 360 / steps, radius]); await shot(`test-results/oit-orbit-${mode}-${k}.png`);}
      } else for (const k of [0, 90]) {await page.evaluate(([a, d]) => window.check.orbit(a, d), [k * 360 / steps, radius]); await shot(`test-results/oit-orbit-reference-${k}.png`);}
      await clear();
    }
    assert.equal(report.popping.oit.stepsWithOver1PercentPopped, 0, 'OIT must not pop');
  }
  // 5. GPU time.
  if (want('timing')) {
    let quiet; try {quiet = await waitForQuiet({timeout: 900});} catch (error) {quiet = {diagnostic: true, reason: error.message};}
    report.timing = {machine: quiet, label: quiet.diagnostic ? 'DIAGNOSTIC (machine not quiet)' : 'quiet-gate passed', samples: 4, angleDegrees: 30, rows: []};
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      const runs = {};
      for (const mode of ['opaque', 'sorted', 'oit', 'oit', 'sorted', 'opaque']) {
        await build({scene: 'cad', mode: mode === 'opaque' ? 'sorted' : mode, samples: 4, width, height, profile: true});
        if (mode === 'opaque') await page.evaluate(() => window.check.setTransparentVisible(false));
        await page.evaluate(() => window.check.orbit(30, 3.2));
        const r = await page.evaluate(() => window.check.bench(300)); assert.deepEqual(r.errors, []); (runs[mode] ??= []).push(r); await clear();
      }
      const avg = (list, f) => +(list.map(f).reduce((a, b) => a + b, 0) / list.length).toFixed(3);
      const row = {resolution: [width, height], opaqueMs: avg(runs.opaque, r => r.gpuMs), sortedMs: avg(runs.sorted, r => r.gpuMs), oitMs: avg(runs.oit, r => r.gpuMs),
        oitAccumulateMs: avg(runs.oit, r => r.passes['oit:accumulate'] ?? 0), oitCompositeMs: avg(runs.oit, r => r.passes['oit:composite'] ?? 0), runs};
      row.sortedTransparencyMs = +(row.sortedMs - row.opaqueMs).toFixed(3); row.oitTransparencyMs = +(row.oitMs - row.opaqueMs).toFixed(3);
      report.timing.rows.push(row); console.log('timing', JSON.stringify({...row, runs: undefined}));
    }
  }
  assert.deepEqual(pageErrors, []);
} finally {await context.close();}
report.powerOnline.after = ac(); assert.equal(report.powerOnline.after, 'True', 'still on AC power');
await writeFile(resolve(import.meta.dirname, 'results/oit-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('OIT GPU check passed');
