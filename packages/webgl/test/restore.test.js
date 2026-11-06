// The attach rules of `/restore`. Real context loss needs a real GL context: test/browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webglRestore } from '../dist/restore.js';

test('webglRestore does nothing where core already restores', () => {
  const engine = { backend: 'webgpu' },
    plugin = webglRestore();
  plugin.setup(engine);
  assert.deepEqual(Object.keys(engine), ['backend'], 'no method is covered');
  plugin.dispose();
});

test('webglRestore refuses an engine whose fallback is not the preview renderer', () => {
  assert.throws(
    () => webglRestore().setup({ backend: 'webgl2', canvas: {} }),
    (error) => error.code === 'unsupported' && /webglRenderer/.test(error.message),
  );
});
