// The attach rules of `/pick`. Real picks need a real GL context: test/browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webglPicking } from '../dist/pick.js';

test('webglPicking does nothing where core already picks', () => {
  const engine = { backend: 'webgpu' },
    plugin = webglPicking();
  plugin.setup(engine);
  assert.deepEqual(Object.keys(engine), ['backend'], 'no method is covered');
  plugin.dispose();
});

test('webglPicking refuses an engine whose fallback is not the preview renderer', () => {
  assert.throws(
    () => webglPicking().setup({ backend: 'webgl2', canvas: {} }),
    (error) => error.code === 'unsupported' && /webglRenderer/.test(error.message),
  );
});
