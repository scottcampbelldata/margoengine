import test from 'node:test';
import assert from 'node:assert/strict';
import { wasmError } from '../packages/shared/errors.js';
import { LoadOnce } from '../packages/shared/load-once.js';

for (const ErrorType of [WebAssembly.CompileError, EvalError, WebAssembly.RuntimeError])
  test('shared loader codes policy failure: ' + ErrorType.name, async () => {
    const cause = new ErrorType('Aborted(WebAssembly: blocked by Content Security Policy)');
    const loader = new LoadOnce(async () => {
      throw cause;
    });
    await assert.rejects(loader.load(), (error) => {
      assert.equal(error.name, 'MargoError');
      assert.equal(error.code, 'failed');
      assert.equal(error.cause, cause);
      assert.match(error.message, /'wasm-unsafe-eval'.*script-src/);
      assert.match(error.message, /docs\/csp\.md/);
      return true;
    });
    assert.equal(loader.value, null);
  });

test('invalid binaries, missing SIMD, fetch errors and aborts retain their cause', () => {
  for (const error of [
    new WebAssembly.CompileError('expected magic word'),
    new WebAssembly.CompileError('SIMD unavailable'),
    new TypeError('Failed to fetch'),
    new TypeError('Fetch blocked by Content Security Policy'),
    new DOMException('Aborted', 'AbortError'),
  ])
    assert.equal(wasmError(error), error);
});
