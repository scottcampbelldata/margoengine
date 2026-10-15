// Real-GPU check of ColorOutput (Display P3 / HDR canvas) from @margoengine/environment, after npm run build:packages,
// on AC power, holding the GPU lock. Headed by default so matchMedia reports the real display (HEADLESS=1 to skip):
//   node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/color-output-gpu.mjs
// BROWSER_CHANNEL=chrome for Chrome (default Edge). Writes examples/package-benchmarks/results/color-output-gpu-<channel>.json.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {openBrowser} from '../../scripts/browser.js';

const ac = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim();
assert.equal(ac(), 'True', 'run on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/color-output.html', port: 5231, headless: !!process.env.HEADLESS}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
const report = {gpu: hardware.webgpu, browser: hardware.browserName + ' ' + hardware.browserVersion, headless: !!process.env.HEADLESS, recordedAt: new Date().toISOString(), scenarios: {}};
const scenarios = {
  off: {tonemap: 'alone'},
  p3: {tonemap: 'alone', output: {gamut: 'p3', hdr: false, force: true}},
  hdr: {tonemap: 'alone', output: {gamut: 'srgb', hdr: true, force: true, peak: 4}},
  'p3+hdr': {tonemap: 'alone', output: {force: true, peak: 4}},
  'p3+hdr restored': {tonemap: 'alone', output: {force: true, peak: 4}, restore: true},
  'p3+hdr transparent': {tonemap: 'alone', output: {force: true, peak: 4}, transparent: true},
  'p3+hdr stack': {tonemap: 'stack', output: {force: true, peak: 4}},
  'auto (media queries)': {tonemap: 'alone', output: {}},
  'core off': {tonemap: null},
  'core p3': {tonemap: null, output: {gamut: 'p3', hdr: false, force: true}},
};
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60000});
  report.display = await page.evaluate(() => window.display); console.log('display', JSON.stringify(report.display));
  for (const [name, scenario] of Object.entries(scenarios)) {
    const result = report.scenarios[name] = await page.evaluate(s => window.check.run(s), scenario);
    await page.evaluate(() => window.check.clear());
    console.log(name, JSON.stringify(result));
    assert.deepEqual(result.errors, [], name);
  }
  assert.deepEqual(pageErrors, []);
} finally {await context.close();}
assert.equal(ac(), 'True', 'still on AC power');

const s = report.scenarios, p3 = (name, patch) => s[name].p3.unorm8.values[patch], raw = (name, patch) => s[name].raw.values[patch];
// Canvas configuration as requested.
assert.deepEqual(s.off.config, {format: 'bgra8unorm', colorSpace: 'srgb', toneMapping: 'standard', alphaMode: 'opaque'});
assert.deepEqual(s.p3.config, {format: 'bgra8unorm', colorSpace: 'display-p3', toneMapping: 'standard', alphaMode: 'opaque'});
for (const name of ['hdr', 'p3+hdr', 'p3+hdr restored', 'p3+hdr transparent', 'p3+hdr stack']) {
  assert.equal(s[name].config.format, 'rgba16float', name); assert.equal(s[name].config.toneMapping, 'extended', name); assert.equal(s[name].output.hdr, true, name);
}
assert.equal(s['p3+hdr transparent'].config.alphaMode, 'premultiplied');
// P3 patch: clipped to sRGB green when off (the browser shows it as P3 ~(86,190,55)); P3 green when on.
const [r0, g0, b0] = p3('off', 'p3'), [r1, g1, b1] = p3('p3', 'p3');
assert.ok(r0 > 60 && b0 > 30 && r1 < 10 && b1 < 10 && Math.abs(g1 - g0) < 8, `P3 patch distinct: off ${p3('off', 'p3')} on ${p3('p3', 'p3')}`);
assert.ok(raw('p3+hdr', 'p3')[0] < 0.02 && raw('p3+hdr', 'p3')[2] < 0.02, 'P3 + HDR keeps the P3 patch saturated');
// HDR highlight: above SDR white on the canvas only when HDR is on.
assert.ok(raw('off', 'highlight')[0] <= 255 && raw('p3', 'highlight')[0] <= 255);
for (const name of ['hdr', 'p3+hdr', 'p3+hdr restored', 'p3+hdr transparent']) assert.ok(raw(name, 'highlight')[0] > 1.2, `${name}: highlight ${raw(name, 'highlight')} > 1`);
// In-gamut content looks the same with P3 on (browser's P3 reading, 8-bit rounding).
const diff = (a, b) => Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i])));
report.identical = {plainPatch: diff(p3('off', 'plain'), p3('p3', 'plain')), coreBox: Math.max(...Object.keys(s['core off'].p3.unorm8.values).map(k => diff(p3('core off', k), p3('core p3', k))))};
console.log('in-gamut difference P3 on vs off (8-bit P3 units)', JSON.stringify(report.identical));
assert.ok(report.identical.plainPatch <= 2 && report.identical.coreBox <= 2, 'sRGB content looks the same with P3 on');
mkdirSync(new URL('./results/', import.meta.url), {recursive: true});
writeFileSync(new URL(`./results/color-output-gpu-${hardware.requestedChannel ?? hardware.browserName}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('color output GPU check passed');
