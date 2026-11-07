import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Camera } from '@margoengine/core';

// A package that is not installed fails at its import, a step of its own. In a file of its own, because a module once
// imported stays imported: each test here is the first to ask for the package it takes away.
let missing = '';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === missing)
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    return next(specifier, context);
  },
});
const disposed = [],
  bounds = new Float32Array([-1, 0, -2, 1, 2, 2]);
mock.module('@margoengine/gltf-pro', {
  namedExports: { loadGLTF: async () => ({ bounds, dispose: () => disposed.push('model') }) },
});
const { addViewer } = await import('@margoengine/stage/viewer');

for (const [name, options] of [
  ['@margoengine/environment', { environment: false, shadows: false, tonemap: false }],
  ['@margoengine/staging', { environment: false, background: false, tonemap: false }],
  ['@margoengine/shadows', { environment: false, background: false, shadows: 'cascaded', tonemap: false }],
  ['@margoengine/tonemap', { environment: false, background: false, shadows: false }],
])
  test(`${name} not installed: Install ${name}, and the camera stays`, async () => {
    const camera = new Camera(),
      { position, target, near, far } = camera,
      disposal = new AbortController(),
      stage = {
        canvas: Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 400 }),
        signal: disposal.signal,
        engine: { camera },
        onTick: () => () => {},
      };
    disposed.length = 0;
    missing = name;
    await assert.rejects(addViewer(stage, '/shoe.glb', options), { message: new RegExp(`Install ${name}`) });
    for (const [key, value] of Object.entries({ position, target, near, far }))
      assert.equal(camera[key], value, `camera.${key} changed`);
    assert.deepEqual(disposed, ['model']);
  });
