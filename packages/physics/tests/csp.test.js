import test from 'node:test';
import { blockedLoad } from '../../../tests/support/wasm-csp.js';

for (const kind of ['WebAssembly.CompileError', 'EvalError'])
  test('physics/index reports blocked Wasm compilation: ' + kind, () => {
    blockedLoad(new URL('../dist/index.js', import.meta.url), 'await api.Physics.load();', kind);
  });
for (const kind of ['WebAssembly.CompileError', 'EvalError'])
  test('physics/next reports blocked Wasm compilation: ' + kind, () => {
    blockedLoad(new URL('../dist/next.js', import.meta.url), 'await api.loadKernel();', kind);
  });
