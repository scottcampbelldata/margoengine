import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('XR GPU runners select independent ports instead of holding a slot behind another lane', () => {
  for (const name of ['pointer', 'locomotion', 'hands', 'ar-extra', 'performance']) {
    const source = readFileSync(new URL(`./${name}.browser.mjs`, import.meta.url), 'utf8');
    assert.match(source, /port\s*:\s*['"]free['"]/, name);
  }
});
