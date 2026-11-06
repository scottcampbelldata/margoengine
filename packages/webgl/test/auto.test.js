// The paths of `/auto` that need no GL. The preview, the layer and WebGPU themselves: test/browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoEngine } from '../dist/auto.js';

test('a browser with neither WebGPU nor WebGL2 gets the refusal and no layer, and setup never runs', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'test' } });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  });
  let runs = 0;
  const canvas = {
    width: 4,
    height: 4,
    getContext: () => null,
    replaceWith: () => assert.fail('the canvas stays'),
  };
  await assert.rejects(
    autoEngine(canvas, () => runs++, { loadCompat: () => assert.fail('no layer below WebGL2') }),
    (error) => error.code === 'unsupported' && /No WebGL2/.test(error.message),
  );
  assert.equal(runs, 0);
});
