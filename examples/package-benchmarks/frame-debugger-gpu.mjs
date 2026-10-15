// Real-GPU check of the frame debugger (HANDOFF 5h.d; run on AC power under the GPU lock, after npm run build:packages):
//   node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/frame-debugger-gpu.mjs
// Captures one frame of DamagedHelmet + shadows + GPU-culled indirect boxes + PostStack(SSAO, Bloom, FXAA) with
// timestamp queries, checks the report, and writes test-results/frame-debugger-report.json and
// test-results/frame-debugger-panel.png (the DOM panel over the scene).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../scripts/browser.js';

const ac = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim();
assert.equal(ac(), 'True', 'run on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/frame-debugger.html', port: 5231}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => {if (message.type() === 'error') pageErrors.push(message.text());});
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 120000});
  const {report, restored, errors} = await page.evaluate(() => window.check.capture());
  assert.equal(restored, true, 'frame path restored after capture');
  await page.evaluate(() => window.check.expand());
  await page.screenshot({path: 'test-results/frame-debugger-panel.png'});
  await writeFile('test-results/frame-debugger-report.json', JSON.stringify({gpu: hardware.webgpu, browser: `${hardware.browserName} ${hardware.browserVersion}`, report}, null, 1));
  const owners = [...new Set(report.graph.map(entry => entry.owner))], t = report.totals;
  console.log(JSON.stringify({gpu: hardware.webgpu?.description, browser: hardware.browserVersion, timing: report.timing, cpuMs: report.cpuMilliseconds, gpuMs: report.gpuMilliseconds,
    passes: report.graph.map(entry => `${entry.name}[${entry.owner}] ${entry.passes.length} gpu passes ${entry.gpuMilliseconds?.toFixed(3) ?? '-'} ms`), totals: t,
    memoryMB: +(report.memory.bytes / 1048576).toFixed(1), pipelines: report.pipelines.length, warnings: report.warnings}, null, 1));
  assert.deepEqual([...errors, ...pageErrors], []);
  assert.equal(report.timing, 'gpu', report.note);
  for (const owner of ['core', 'shadows', 'gltf-pro:', 'culling:', 'post:stack']) assert.ok(owners.some(name => name.startsWith(owner)), `a pass owned by ${owner}: ${owners}`);
  assert.ok(t.indirectDraws >= 1 && t.dispatches >= 1, 'culling dispatches and indirect draws');
  const indirect = report.graph.flatMap(entry => entry.passes.flatMap(pass => pass.commands)).filter(command => command.indirect && command.kind.startsWith('draw'));
  assert.ok(indirect.some(command => command.instanceCount > 0), 'culled instance counts read back');
  assert.ok(t.triangles > 46000, 'helmet triangles counted');
  assert.ok(report.pipelines.every(pipeline => pipeline.textures <= 16 && pipeline.samplers <= 16));
  assert.ok(report.memory.textures.bytes > 0 && report.memory.buffers.bytes > 0);
  assert.ok(report.graph.some(entry => entry.passes.some(pass => pass.gpuMilliseconds > 0)));
} finally {await context.close();}
assert.equal(ac(), 'True', 'still on AC power');
console.log('frame debugger GPU check passed');
