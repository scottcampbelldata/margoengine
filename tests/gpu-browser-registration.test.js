import test from 'node:test';
import assert from 'node:assert/strict';
import { drivesBrowser, plan } from '../scripts/gpu-package-tests.mjs';

test('browser transport declarations are helpers, while calls remain browser drivers', () => {
  assert.equal(drivesBrowser('export async function openBrowser(options) { return transport(options); }'), false);
  assert.equal(drivesBrowser('const browser = await openBrowser(options);'), true);
  assert.equal(drivesBrowser('export function launchBrowser() {}\nlaunchBrowser();'), true);
  assert.equal(drivesBrowser('const browser = await chromium.launch({});'), true);
});

test('existing image, worker and nested avatar browser suites have executable registrations', {
  timeout: 15000,
}, () => {
  const rows = plan();
  const commands = rows.map((row) => row.command).join('\n');
  for (const file of [
    'gif-gpu.mjs',
    'tiles-gpu.mjs',
    'browser-matrix.mjs',
    'mtoon-uv-animation.browser.mjs',
    'mtoon-avatar.browser.mjs --vrm1',
    'formats-check.mjs --compat',
  ])
    assert.ok(commands.includes(file), `${file} must execute in the GPU plan`);
});
