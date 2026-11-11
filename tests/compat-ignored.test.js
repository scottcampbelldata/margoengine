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
