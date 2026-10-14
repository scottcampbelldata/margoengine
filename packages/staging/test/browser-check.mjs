// Real-GPU check (repository root, after building packages, AC power; takes the GPU lock):
//   node packages/staging/test/browser-check.mjs
// Renders a floor, a core cube touching it, a materials (gltf-pro) sphere touching it and a cube floating above the
// shadow height, with contact shadows off (opacity 0) and on, and asserts pixels; then times the contact-shadow
// passes with timestamp queries. Writes examples/package-benchmarks/results/staging-contact.json and
// test-results/staging-contact.png.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';

const root = resolve(import.meta.dirname, '../../..');
const power = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim() === 'True';
const lock = resolve(dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {encoding: 'utf8'}).trim()), 'test-results/gpu.lock');
assert.ok(power(), 'On battery: run real-GPU checks on AC power');
for (;;) {try {mkdirSync(lock); break;} catch (e) {if (e.code !== 'EEXIST') throw e; console.log('GPU lock held, waiting'); await new Promise(r => setTimeout(r, 15000));}}
const report = {recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim(), acPowerBefore: true, pixels: null, timing: []};
try {
  for (const [low, res] of [[0, 512], [0, 256], [0, 1024], [1, 512]]) {
    const context = await openBrowser({startPath: `/packages/staging/test/browser-check.html?low=${low}&res=${res}`, port: 5211, args: ['--enable-webgpu-developer-features']}), {page, hardware} = context, pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());});
    try {
      report.hardware ??= hardware;
      await page.waitForFunction(() => window.ready, null, {timeout: 30000});
      if (!report.pixels) {
        const shot = async () => {const png = await page.locator('canvas').screenshot(), image = await decodePNG(png); return {png, at: ([x, y]) => {const o = (y * image.width + x) * 4; return [...image.data.slice(o, o + 3)];}};};
        let result = await page.evaluate(() => window.check.render(0)); assert.equal(result.error, null); assert.deepEqual(result.errors, []);
        const off = await shot(); result = await page.evaluate(() => window.check.render(0.8)); assert.equal(result.error, null); assert.deepEqual(result.errors, []);
        const on = await shot(); writeFileSync(resolve(root, 'test-results/staging-contact.png'), on.png);
        const points = await page.evaluate(() => window.check.points()), luma = rgb => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        const pixels = Object.fromEntries(Object.entries(points).map(([name, p]) => [name, {at: p, off: off.at(p), on: on.at(p), ratio: +(luma(on.at(p)) / luma(off.at(p))).toFixed(3)}]));
        report.pixels = pixels; console.log(JSON.stringify(pixels));
        const same = name => pixels[name].off.every((v, i) => Math.abs(v - pixels[name].on[i]) <= 1);
        assert.ok(Math.abs(luma(pixels.sphereContact.off) / luma(pixels.floorReference.off) - 1) < 0.1, 'sphere test point shows the floor');
        assert.ok(pixels.cubeContact.ratio < 0.9, 'dark contact in front of the core cube');
        assert.ok(pixels.sphereContact.ratio < 0.9, 'contact shadow beside the gltf-pro sphere');
        assert.ok(same('underFloating'), 'a mesh above `height` casts nothing');
        assert.ok(same('outside'), 'floor outside the plane unchanged');
        assert.ok(same('cubeTop'), 'the plane never paints over the mesh');
        console.log('ok pixels');
      }
      for (const isStatic of [false, true]) {const row = await page.evaluate(([f, s]) => window.check.timing(f, s), [65, isStatic]); assert.ok(row, 'timestamp-query unavailable'); report.timing.push(row); console.log(JSON.stringify(row));}
      assert.deepEqual(pageErrors, []);
    } finally {await context.close();}
  }
  report.acPowerAfter = power(); assert.ok(report.acPowerAfter, 'Power dropped to battery during the run; discard it');
  writeFileSync(resolve(root, 'examples/package-benchmarks/results/staging-contact.json'), JSON.stringify(report, null, 1) + '\n');
  console.log('staging browser check passed');
} finally {rmdirSync(lock);}
