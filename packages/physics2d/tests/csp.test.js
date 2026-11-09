import test from 'node:test';
import { blockedLoad } from '../../../tests/support/wasm-csp.js';

for (const kind of ['WebAssembly.CompileError', 'EvalError'])
  test('physics2d/index reports blocked Wasm compilation: ' + kind, () => {
    blockedLoad(new URL('../dist/index.js', import.meta.url), 'await api.Physics2D.load();', kind);
  });
