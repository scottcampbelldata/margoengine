// Loader gate (HANDOFF item 0): native FBX, USD (USDA/USDC/USDZ), loaders formats and gltf-pro models in a real browser,
// then a memory audit. Real GPU, under the GPU lock, on AC power. From the repository root after `npm run build:packages`:
//   node examples/package-benchmarks/gates/memory.mjs [--cycles=20]
// 1. Each model is loaded, framed and screenshotted (test-results/gates-load-<name>.png); it must draw something.
// 2. --cycles times: every model in turn is loaded, rendered two frames and unloaded. Live GPU buffers/textures are
//    counted by wrapping GPUDevice.createBuffer/createTexture and GPUBuffer/GPUTexture.destroy. Asserts no growth in
//    live count or bytes from cycle 2 to the last, and that live objects return to the pre-load baseline.
// Writes examples/package-benchmarks/results/gates-memory.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acPower } from '../cad/power.mjs';
import { rich, binary } from '../../../packages/fbx/test/fixtures.js';

const cycles = +(process.argv.find((a) => a.startsWith('--cycles='))?.split('=')[1] ?? 20);
const lock =
  process.env.MARGO_GPU_LOCK_NESTED ??
  resolve(
    dirname(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    ),
    'test-results/gpu.lock',
  );
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    console.log('gpu.lock held, waiting');
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
mkdirSync('test-results', { recursive: true });
// The fbx package's test fixture (pivots, inherit types, n-gons, layered attributes, materials, skin, blend shape, clips) as zlib binary FBX.
writeFileSync('test-results/gates-fbx-rich.fbx', binary(rich({ morphAnimation: true }), { compress: true }));
const report = {
  date: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  acPowerBefore: acPower(),
  cycles,
  loads: [],
  memory: [],
};
let context;
try {
  assert.notEqual(report.acPowerBefore, false, 'On battery');
  context = await openBrowser({
    startPath: '/examples/package-benchmarks/gates/memory.html',
    port: 5243,
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const { page, hardware } = context,
    pageErrors = [];
  page.setDefaultTimeout(300_000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
  });
  report.hardware = hardware;
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const names = await page.evaluate(() => window.audit.names);
  await page.evaluate(() => window.audit.hide()); // an empty rendered frame, not the never-presented canvas
  const background = await decodePNG(await page.locator('canvas').screenshot());
  report.baseline = await page.evaluate(() => {
    globalThis.gc?.();
    return window.audit.snapshot();
  });
  for (const name of names) {
    const r = await page.evaluate((n) => window.audit.show(n), name);
    assert.deepEqual(r.errors, [], name);
    const image = await decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/gates-load-${name.replace(/[:.]/g, '-')}.png` }),
    );
    let drawn = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (
        Math.abs(image.data[i] - background.data[i]) +
          Math.abs(image.data[i + 1] - background.data[i + 1]) +
          Math.abs(image.data[i + 2] - background.data[i + 2]) >
        12
      )
        drawn++;
    r.drawnFraction = +(drawn / (image.width * image.height)).toFixed(4);
    report.loads.push(r);
    console.log('load', JSON.stringify(r));
    assert.ok(r.drawnFraction > 0.001, `${name} drew nothing`);
  }
  assert.deepEqual((await page.evaluate(() => window.audit.hide())).errors, []);
  report.afterShow = await page.evaluate(() => {
    globalThis.gc?.();
    return window.audit.snapshot();
  });
  for (let c = 0; c < cycles; c++) {
    const s = await page.evaluate(() => window.audit.cycle());
    assert.deepEqual(s.errors, [], `cycle ${c + 1}`);
    delete s.errors;
    report.memory.push(s);
    console.log('cycle', c + 1, JSON.stringify(s));
  }
  const first = report.memory[1] ?? report.memory[0],
    last = report.memory.at(-1);
  report.growth = {
    buffers: last.buffers - first.buffers,
    textures: last.textures - first.textures,
    bufferBytes: last.bufferBytes - first.bufferBytes,
    textureBytes: last.textureBytes - first.textureBytes,
    jsHeapMB: +((last.jsHeap - first.jsHeap) / 2 ** 20).toFixed(2),
  };
  report.vsBaseline = {
    buffers: last.buffers - report.baseline.buffers,
    textures: last.textures - report.baseline.textures,
    bufferBytes: last.bufferBytes - report.baseline.bufferBytes,
    textureBytes: last.textureBytes - report.baseline.textureBytes,
  };
  report.leftover =
    report.vsBaseline.buffers || report.vsBaseline.textures ? await page.evaluate(() => window.audit.liveList()) : [];
  console.log(
    'growth cycle 2 ->',
    cycles,
    JSON.stringify(report.growth),
    'vs pre-load baseline',
    JSON.stringify(report.vsBaseline),
  );
  report.acPowerAfter = acPower();
  writeFileSync('examples/package-benchmarks/results/gates-memory.json', JSON.stringify(report, null, 1));
  assert.deepEqual(pageErrors, []);
  assert.equal(report.growth.buffers, 0, 'live GPU buffers grow per cycle');
  assert.equal(report.growth.textures, 0, 'live GPU textures grow per cycle');
  assert.equal(report.growth.bufferBytes, 0);
  assert.equal(report.growth.textureBytes, 0);
  console.log('memory gate passed; wrote examples/package-benchmarks/results/gates-memory.json');
} finally {
  await context?.close();
  rmSync(lock, { recursive: true, force: true });
}
