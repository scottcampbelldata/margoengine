import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { launchArgs, resolveBrowser, softwareAdapterReason } from '../scripts/lib/browser.mjs';

const pick = (env = {}, platform = 'win32') => resolveBrowser({ env, platform, argv: [] });
const swift = { vendor: 'google', architecture: 'swiftshader', fallback: true };

test('the swiftshader adapter named in the launch arguments counts as asked for; any other software adapter is refused', () => {
  const asked = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'];
  assert.equal(softwareAdapterReason(pick(), swift, { args: asked }), null);
  assert.match(softwareAdapterReason(pick(), swift, { args: ['--enable-unsafe-webgpu'] }), /software/);
  assert.match(softwareAdapterReason(pick({}, 'darwin'), swift), /software/);
});

test('setting MARGO_BROWSER changes the browser, never the arguments of a Linux launch', () => {
  assert.deepEqual(launchArgs(pick({ MARGO_BROWSER: 'chrome' }, 'linux')), [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
  ]);
});

// Every CI step that drives a GPU check on a runner without a GPU asks for the software adapter on purpose, so the refusal
// (softwareAdapterReason in scripts/browser.js) fires only where a real GPU was expected:
//   browser.yml (windows-latest): all 14 steps with BROWSER_ARGS name --use-webgpu-adapter=swiftshader
//   ci.yml node-compat: "Pack, install in a clean project ... packed browser" sets MARGO_SOFTWARE_GPU=1
//   tests/page-ready.test.js serves plain HTML and passes softwareAdapterOk to openBrowser
// No other workflow step reaches openBrowser (the rest are Node-only, build, lint or bundler checks).
test('every workflow step that sets BROWSER_ARGS asks for SwiftShader, and the ci.yml packed-browser step sets MARGO_SOFTWARE_GPU', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  let steps = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml')))
    for (const step of readFileSync(new URL(file, dir), 'utf8').split(/\n(?=\s*- (?:name|run|uses|if):)/))
      if (/BROWSER_ARGS:/.test(step)) {
        steps++;
        assert.match(step, /--use-webgpu-adapter=swiftshader/, `${file}: ${step.trim().split('\n')[0]}`);
      }
  assert.equal(steps, 14, 'the browser.yml steps that pass BROWSER_ARGS');
  assert.match(
    readFileSync(new URL('ci.yml', dir), 'utf8'),
    /modern:test:packages -- --consumer\r?\n\s+env:\r?\n\s+MARGO_SOFTWARE_GPU: '1'/,
  );
});
