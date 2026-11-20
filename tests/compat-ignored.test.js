// Regression (2026-11-11): biomes test:gpu:backend-placement opens its page with `compat: false`, so a
// `MARGO_COMPAT=1` run of it ran native WebGPU and passed with no word that the layer was never used; a lane counted it
// as the WebGL2-layer leg. openBrowser now prints a line whenever a forced-compatibility run opens a page natively.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compatIgnoredLine } from '../scripts/support/compat-shim.js';

test('a compatibility run that opens a page on native WebGPU says so', () => {
  const line = compatIgnoredLine('/tests/wgsl-check.html', false, true);
  assert.match(line, /^MARGO_COMPAT=1 not applied to \/tests\/wgsl-check\.html: .*native WebGPU/);
  assert.equal(compatIgnoredLine('/tests/wgsl-check.html', true, true), '', 'the page runs on the layer');
  assert.equal(compatIgnoredLine('/tests/wgsl-check.html', false, false), '', 'not a compatibility run');
});

test('openBrowser prints the line before it opens any page', () => {
  const source = readFileSync(new URL('../scripts/browser.js', import.meta.url), 'utf8');
  const open = source.indexOf('export async function openBrowser(');
  const print = source.indexOf('compatIgnoredLine(startPath, compat)', open);
  assert.ok(open > 0 && print > open, 'openBrowser computes the line from its own startPath and compat options');
  assert.ok(print < source.indexOf('startDevServer({ startPath', open), 'the line comes before the server starts');
});

// Regression (2026-11-15, KB-VPT-LOBES-COMPAT): voxel-pathtracer's own-leg scripts logged their first leg as
// `compat: false` under MARGO_COMPAT=1, where openBrowser had put that leg on the layer over ANGLE Direct3D 11, so a
// reader took a D3D11 layer result for native WebGPU. Each leg now names the device that drew it.
test('a leg names the device that drew it, the layer under a forced-compatibility run included', async () => {
  const { legDevice, legDevices } = await import('../scripts/support/compat-shim.js');
  const d3d11 = 'ANGLE (NVIDIA, NVIDIA RTX A6000 (0x00002230) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const vulkan = 'ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA RTX A6000 (0x00002230)), NVIDIA)';
  assert.equal(legDevice(false, { webglRenderer: d3d11 }), 'webgpu');
  assert.equal(legDevice(false, { compat: true, webglRenderer: d3d11 }), 'webgl2-layer on ANGLE D3D11');
  assert.equal(legDevice(true, { webglRenderer: vulkan }), 'webgl2-layer on ANGLE Vulkan');
  assert.equal(legDevice(true, { compat: true, webglRenderer: vulkan }), 'webgl2-layer on ANGLE Vulkan');
  assert.equal(
    legDevices([{ device: 'webgl2-layer on ANGLE D3D11' }, { device: 'webgl2-layer on ANGLE Vulkan' }, { lifecycle: {} }]),
    'webgl2-layer on ANGLE D3D11 and webgl2-layer on ANGLE Vulkan',
  );
});

test('every voxel-pathtracer script with its own layer leg labels its legs by device', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../packages/voxel-pathtracer/tests/', import.meta.url);
  const scripts = readdirSync(dir).filter((name) => name.endsWith('-browser.mjs'));
  let checked = 0;
  for (const name of scripts) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    if (!source.includes('--use-angle=vulkan')) continue;
    // A leg opened with openBrowser's `compat` option set from its flag runs natively in any run; only a call without
    // it is put on the layer by MARGO_COMPAT=1.
    const calls = source.split('openBrowser(').slice(1).map((call) => call.slice(0, call.indexOf(')')));
    if (calls.every((call) => /\bcompat\s*[,:]/.test(call))) continue;
    checked++;
    assert.match(source, /legDevice\(compat, ?context\.hardware\)/, `${name} names the device of each leg`);
    assert.doesNotMatch(source, /'[a-z]+: native(,| and) compatibility/, `${name}'s closing line names the devices`);
  }
  assert.ok(checked >= 13, `checked ${checked} scripts`);
});
