import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { boxed, inWorker } from '../dist/encoder-host.js';

for (const kind of ['draco', 'basis'])
  for (const ErrorType of [WebAssembly.CompileError, EvalError])
    test(kind + ' encoder worker reports blocked compilation: ' + ErrorType.name, async () => {
      const blocked = new ErrorType('WebAssembly blocked by Content Security Policy');
      let reply;
      const context = {
        Error,
        WebAssembly: {
          instantiate: async () => {
            throw blocked;
          },
        },
        fetch: async () => new Response(new Uint8Array(8)),
        self: {
          importScripts() {
            this.DracoEncoderModule = this.BASIS = () => context.WebAssembly.instantiate();
          },
          postMessage(message) {
            reply = message;
          },
        },
      };
      runInNewContext(readFileSync(new URL('../dist/encoder.worker.js', import.meta.url), 'utf8'), context);
      await context.self.onmessage({ data: { id: 1, kind, wrapperURL: '/wrapper.js', wasmURL: '/module.wasm' } });
      assert.equal(reply.error.name, 'MargoError');
      assert.equal(reply.error.code, 'failed');
      assert.match(reply.error.message, /'wasm-unsafe-eval'.*script-src/);
      assert.match(reply.error.message, /https:\/\/margoengine.com\/llms\/docs\/csp\.md/);
    });

for (const ErrorType of [WebAssembly.CompileError, EvalError])
  test('encoder initialization and worker reconstruction retain CSP help: ' + ErrorType.name, async (t) => {
    const cause = new ErrorType('WebAssembly blocked by Content Security Policy');
    let failure;
    await assert.rejects(
      boxed(() => Promise.reject(cause), new ArrayBuffer(0)),
      (error) => {
        failure = error;
        assert.equal(error.name, 'MargoError');
        assert.equal(error.code, 'failed');
        assert.equal(error.cause, cause);
        return true;
      },
    );
    let terminated = false;
    const previous = globalThis.Worker;
    globalThis.Worker = class {
      postMessage() {
        this.onmessage({ data: { error: { name: failure.name, message: failure.message, code: failure.code } } });
      }
      terminate() {
        terminated = true;
      }
    };
    t.after(() => {
      if (previous === undefined) delete globalThis.Worker;
      else globalThis.Worker = previous;
    });
    await assert.rejects(
      inWorker([{}], () => []),
      { name: 'MargoError', code: 'failed', message: failure.message },
    );
    assert.equal(terminated, true);
  });
