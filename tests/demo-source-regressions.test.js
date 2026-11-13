// Demo bugs that landed without a test, Scott 2026-11-01: fixes in examples/extension-demo.ts, which has no test folder
// of its own. Its browser check is scripts/modern-extension-tests.js; these catch the same mistakes without a GPU. The
// Night Citadel tests that stood here went with that demo (Scott, 2026-11-13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// a36e2151d: changing clips snapped to the rest pose and one-shot clips looped forever.
test('the character study cross-fades through the animator and only named clips loop', () => {
  const demo = read('examples/extension-demo.ts');
  assert.match(demo, /looping = \/\^\(idle\|walking\|running\|dance\)\$\/i/);
  assert.match(demo, /holding = \/\^\(death\|sitting\)\$\/i/);
  assert.match(demo, /Animator\.attach\(animation,/);
});
