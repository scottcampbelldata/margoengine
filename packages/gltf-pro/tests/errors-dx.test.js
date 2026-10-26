import test from 'node:test';
import assert from 'node:assert/strict';
import { instancedShader } from '../dist/instancing.js';

// DX pass: shader patch faults are coded errors that name their fix.
test('instancedShader reports a shader without the patch target as a coded error', () => {
  assert.throws(
    () => instancedShader('fn main() {}'),
    (error) =>
      error.name === 'MargoError' &&
      error.code === 'failed' &&
      /; the shader source changed, update the patch/.test(error.message),
  );
});
