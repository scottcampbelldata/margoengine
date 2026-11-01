// Demo bugs that landed without a test, Scott 2026-11-01: fixes in apps/showcase-night-citadel and examples/extension-demo.ts,
// which have no test folder of their own. Their browser checks are scripts/modern-night-citadel-tests.js and
// scripts/modern-extension-tests.js; these catch the same mistakes without a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const citadel = () => read('apps/showcase-night-citadel/src/main.ts');

// 80f422c51: warmUp can reboot the device; the citadel kept the one it was built with, so its readiness check watched the
// old queue and the loop stopped after one frame.
test('the citadel reads the engine current device', () => {
  assert.match(citadel(), /get device\(\): GPUDevice \{\s*return [^;]*engine[^;]*\.gpu/);
});

// 8b680a65d: with no reflection the water fell back to a daytime gradient, lighter than the night above it.
test('the citadel water is given the night sky reflection', () => {
  assert.match(citadel(), /\{ night, fog, reflection \}/);
});

// 147dfb39f: shadows redrew 4 cascades every frame; a first frame compiled about ten shaders in one blocking call; a GPU that
// never answered hung on "Preparing the citadel".
test('the citadel has one static shadow map, warms up asynchronously and does not hang on a silent GPU', () => {
  const main = citadel();
  assert.match(main, /this\.shadows\.add\(this\.instances, \{ static: true \}\)/);
  assert.match(main, /citadel\.warm = await warmUp\(engine\)/);
  assert.match(main, /\}, 20_000\)/);
});

// a36e2151d: changing clips snapped to the rest pose and one-shot clips looped forever.
test('the character study cross-fades through the animator and only named clips loop', () => {
  const demo = read('examples/extension-demo.ts');
  assert.match(demo, /looping = \/\^\(idle\|walking\|running\|dance\)\$\/i/);
  assert.match(demo, /holding = \/\^\(death\|sitting\)\$\/i/);
  assert.match(demo, /Animator\.attach\(animation,/);
});
