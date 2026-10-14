// Real-GPU check of textured instancing (run on AC power, holding the GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/textured-instancing-gpu.mjs
// 1. Frame equality: 144 textured boxes (rotated, scaled, two mirrored; per-box tint and atlas region) under shadows,
//    clustered lights, SSAO, IBL and fog, drawn as 144 materials meshes and as one createInstancedMesh; and a generated
//    glTF drawn as 144 nodes and as one EXT_mesh_gpu_instancing node; and a shader NodeMaterial (colour and vertex nodes) as 144
//    meshes and as one instanced mesh. The canvases must match within noise.
// 2. GPU picking reports the instance under the cursor.
// 3. Timings for 1,000-10,000 textured boxes: CPU ms of engine.render() and ms to onSubmittedWorkDone, N meshes vs instanced.
// Writes results/textured-instancing-gpu.json and the frames to test-results/textured-instancing-*.png.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openBrowser} from '../../scripts/browser.js';
import {decodePNG} from '../../tests/support/png.js';

const ac = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim();
const powerBefore = ac(); assert.equal(powerBefore, 'True', 'measure on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/textured-instancing.html', port: 5219}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
const report = {benchmark: 'textured-instancing-gpu', recordedAt: new Date().toISOString(), hardware: hardware.webgpu, browser: hardware.browserName + ' ' + hardware.browserVersion, powerOnline: {before: powerBefore}};
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60000});
  const frame = async name => {
    const result = await page.evaluate(n => window.check.run(n), name); assert.equal(result.error, null, name); assert.deepEqual(result.errors, [], name);
    const bytes = await page.locator('canvas').screenshot({path: `test-results/textured-instancing-${name}.png`}); return decodePNG(bytes);
  };
  const compare = (a, b) => {
    let sum = 0, max = 0, over = 0; const pixels = a.width * a.height;
    for (let i = 0; i < a.data.length; i += 4) {let d = 0; for (let c = 0; c < 3; c++) {const v = Math.abs(a.data[i + c] - b.data[i + c]); sum += v; d = Math.max(d, v);} max = Math.max(max, d); if (d > 8) over++;}
    return {meanAbsDiff: +(sum / pixels / 3).toFixed(4), maxDiff: max, pixelsOver8: over, fractionOver8: +(over / pixels).toFixed(5)};
  };
  report.frames = {};
  for (const [reference, instanced] of [['meshes', 'instanced'], ['gltfNodes', 'gltfInstanced'], ['nodeMeshes', 'nodeInstanced']]) {
    const a = await frame(reference); await page.evaluate(() => window.check.clear());
    const b = await frame(instanced);
    if (instanced === 'instanced') report.picks = await page.evaluate(async () => {const out = []; for (const k of [0, 5, 77, 143]) out.push([k, await window.check.pick(k)]); return out;});
    await page.evaluate(() => window.check.clear());
    const nonBlank = a.data.some((v, i) => i % 4 < 3 && Math.abs(v - a.data[i % 4]) > 30);
    report.frames[instanced] = {reference, ...compare(a, b), nonBlank}; console.log(instanced, JSON.stringify(report.frames[instanced]));
    assert.ok(nonBlank, reference + ' drew something'); assert.ok(report.frames[instanced].meanAbsDiff < 0.5 && report.frames[instanced].fractionOver8 < 0.002, instanced + ' matches ' + reference);
  }
  console.log('picks', JSON.stringify(report.picks));
  for (const [k, hit] of report.picks) assert.deepEqual(hit, {instanceId: k, instanced: true}, 'pick instance ' + k);
  report.timings = [];
  for (const n of [1000, 2500, 5000, 10000]) {
    const meshes = await page.evaluate(n => window.check.bench(n, false), n), instanced = await page.evaluate(n => window.check.bench(n, true), n);
    assert.deepEqual([...meshes.errors, ...instanced.errors], []);
    const row = {count: n, meshes, instanced, cpuSpeedup: +(meshes.cpuMs / instanced.cpuMs).toFixed(1), frameSpeedup: +(meshes.frameMs / instanced.frameMs).toFixed(1)};
    report.timings.push(row); console.log(JSON.stringify(row));
  }
  assert.deepEqual(pageErrors, []);
} finally {await context.close();}
report.powerOnline.after = ac(); assert.equal(report.powerOnline.after, 'True', 'still on AC power');
await writeFile(resolve(import.meta.dirname, 'results/textured-instancing-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('textured instancing GPU check passed');
