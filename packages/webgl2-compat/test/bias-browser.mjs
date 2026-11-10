// Native WebGPU is unavailable beside ANGLE Vulkan in some Windows Chromium builds.
// Keep the native oracle on the same adapter in its own browser, then compare raw f32 bits on each of the platform's
// real ANGLE backends. Forcing a backend the platform does not have (d3d11 on macOS) makes Chromium fall back to
// SwiftShader, which openBrowser refuses, so each platform names its own (lane L, 2026-11-10).
// A backend whose raw WebGL2 mip blend is compressed (AMD under ANGLE D3D11) is compared as Scott ruled on 2026-11-10
// (test/blend-check.mjs): the same LOD as native by nearest-mip sweeps and the driver's own blend at it, bit for bit.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { classifyBlend, compressedFailures } from './blend-check.mjs';

const path = '/packages/webgl2-compat/test/features.html';
const report = { native: null, backends: [] };
const native = await openBrowser({ startPath: path, port: 'free', compat: false, args: [] });
let oracle, nativeProbe;
try {
  await native.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await native.page.evaluate(() => window.check.run('implicitFootprint'));
  assert.equal(result.native.thrown, null);
  assert.deepEqual(result.native.errors, []);
  oracle = result.native.result;
  nativeProbe = await native.page.evaluate(() => window.check.blendProbe([0, 255, 64, 0, 255], 'linear'));
  report.native = native.hardware;
} finally {
  await native.close();
}
export const ANGLE_BACKENDS = {
  win32: [
    ['d3d11', /Direct3D11/],
    ['vulkan', /Vulkan/],
  ],
  darwin: [['metal', /Metal/]],
  linux: [
    ['vulkan', /Vulkan/],
    ['gl', /OpenGL/],
  ],
};
const backends = ANGLE_BACKENDS[process.platform];
if (!backends)
  throw new Error(`No ANGLE backends listed for ${process.platform}; add its real backends to ANGLE_BACKENDS`);
for (const [backend, renderer] of backends) {
  const context = await openBrowser({ startPath: path, port: 'free', compat: false, args: [`--use-angle=${backend}`] });
  const errors = [];
  context.page.on('pageerror', (error) => errors.push(error.message));
  try {
    assert.match(context.hardware.webglRenderer, renderer);
    await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const result = await context.page.evaluate(() => window.check.runCompat('implicitFootprint'));
    assert.equal(result.thrown, null);
    assert.deepEqual(result.errors, []);
    assert.equal(result.gl, 0);
    const { blend } = classifyBlend((await context.page.evaluate(() => window.check.blendProbe([255, 0, 255, 0, 255], 'linear', false))).gl);
    const keys = Object.keys(oracle);
    if (blend === 'compressed') {
      const gl = (await context.page.evaluate(() => window.check.blendProbe([0, 255, 64, 0, 255], 'linear', false))).gl;
      const rows = Object.fromEntries(keys.filter((k) => k.startsWith('linear/')).map((k) => [k, 'footprint']));
      const sweeps = ['sweep/oblique', 'sweep/near'];
      for (const k of keys) if (!rows[k] && !sweeps.includes(k)) assert.deepEqual(result.result[k], oracle[k], `${backend}: ${k} matches native IEEE-754 bits`);
      assert.deepEqual(compressedFailures(oracle, result.result, { rows, sweeps, probes: { footprint: { native: nativeProbe.native, gl } } }), [], `${backend}: compressed mip blend: not native's LOD through the driver's blend`);
    } else assert.deepEqual(result.result, oracle, `${backend}: biased samples match native IEEE-754 bits`);
    assert.deepEqual(errors, []);
    report.backends.push({ backend, hardware: context.hardware, blend, bits: result.result });
    console.log(`${backend}: ${keys.length} footprint probes, mip blend ${blend}: ${blend === 'compressed' ? 'same LOD as native (sweeps), blend exactly the driver curve' : 'f32 words identical to native'}, no GPU errors`);
  } finally {
    await context.close();
  }
}
writeFileSync('test-results/review5-bias-bits.json', JSON.stringify(report, null, 2) + '\n');
