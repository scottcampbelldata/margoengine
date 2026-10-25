// The browser checks' WGSL guard (scripts/support/wgsl-guard.js): any shader that fails to compile is reported as an
// error; a shader a check labels `expect-error:<name>` is excused only when it does fail, and reported as an
// unexpected success when it compiles cleanly. Runs the guard against a stand-in GPUDevice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchWgsl, wgslGuard } from '../scripts/support/wgsl-guard.js';

async function compile(modules) {
  const lines = [],
    original = { debug: console.debug, error: console.error };
  console.debug = (text) => lines.push(text);
  console.error = (text) => lines.push(text);
  globalThis.GPUDevice = class {
    createShaderModule({ code }) {
      return {
        getCompilationInfo: async () => ({
          messages: code.includes('broken')
            ? [{ type: 'error', lineNum: 1, linePos: 1, message: 'unresolved value' }]
            : [],
        }),
      };
    }
  };
  try {
    wgslGuard();
    const device = new GPUDevice();
    for (const m of modules) device.createShaderModule(m);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    Object.assign(console, original);
    delete globalThis.GPUDevice;
  }
  const listeners = [];
  const watched = watchWgsl({ on: (_event, listener) => listeners.push(listener) });
  for (const text of lines) for (const listener of listeners) listener({ text: () => text });
  return watched;
}

test('a shader that fails to compile is an error', async () => {
  const watched = await compile([
    { code: 'broken a', label: 'normal' },
    { code: 'fine', label: 'ok' },
  ]);
  assert.equal(watched.errors.length, 1);
  assert.match(watched.errors[0], /^normal 1:1 unresolved value/);
  assert.equal(watched.modules.size, 2);
});

test('expect-error excuses only the labelled shader, and only when it fails', async () => {
  const watched = await compile([
    { code: 'broken b', label: 'expect-error:bad kernel' },
    { code: 'compiles', label: 'expect-error:should fail' },
    { code: 'broken c', label: 'other' },
  ]);
  assert.deepEqual(watched.expected, ['expect-error:bad kernel']);
  assert.deepEqual(watched.unexpected, ['expect-error:should fail'], 'a declared failure that compiles is reported');
  assert.equal(watched.errors.length, 1, 'other shaders still fail');
  assert.match(watched.errors[0], /^other /);
});
