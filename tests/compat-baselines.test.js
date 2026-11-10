// Execute the canonical drivers through their real setup call. A forced outer run must never turn both sides of a
// native/layer or native-feature-level comparison into the layer. The existing GPU leaves retain every pixel check.
import assert from 'node:assert/strict';
import test from 'node:test';

for (const driver of [
  '../packages/terrain/test/compat.browser.mjs',
  '../packages/webgl2-compat/test/adapter-browser.mjs',
  '../packages/webgl2-compat/test/compat-browser-check.mjs',
  '../packages/webgl2-compat/test/features-browser.mjs',
  '../packages/webgl2-compat/test/compute-browser.mjs',
  '../packages/webgl2-compat/test/routes-browser.mjs',
  '../packages/webgl2-compat/test/xr-browser.mjs',
]) {
  test(`${driver}: keeps its native baseline in a forced compatibility run`, async (t) => {
    const previous = process.env.MARGO_COMPAT;
    process.env.MARGO_COMPAT = '1';
    const stopped = new Error('setup inspected');
    let opened = 0;
    t.mock.module('../scripts/browser.js', {
      namedExports: {
        openBrowser: async (options) => {
          opened++;
          assert.equal(options.compat, false, 'the native baseline explicitly opts out of the outer shim');
          throw stopped;
        },
      },
    });
    try {
      await assert.rejects(import(new URL(driver, import.meta.url)), (error) => error === stopped);
      assert.equal(opened, 1);
    } finally {
      if (previous === undefined) delete process.env.MARGO_COMPAT;
      else process.env.MARGO_COMPAT = previous;
    }
  });
}
