import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { blockedLoad, stubCompile } from '../../../tests/support/wasm-csp.js';
import { startBasis } from '../dist/codec.js';
import { WorkerPool } from '../dist/pool.js';

for (const kind of ['WebAssembly.CompileError', 'EvalError']) {
  test('meshopt SIMD reports blocked compilation: ' + kind, () => {
    blockedLoad(new URL('../dist/meshopt-simd.js', import.meta.url), 'await api.MeshoptSIMDDecoder.ready;', kind);
  });
  for (const type of ['draco', 'draco-points', 'ktx2', 'ktx2-layers', 'ktx2-hdr'])
    test(type + ' worker preserves CSP code and help: ' + kind, async () => {
      const blocked =
        kind === 'EvalError'
          ? new EvalError('Wasm blocked by CSP')
          : new WebAssembly.CompileError('Wasm blocked by CSP');
      let reply;
      const context = {
        Error,
        WebAssembly: {
          instantiate: async () => {
            throw blocked;
          },
          RuntimeError: WebAssembly.RuntimeError,
        },
        fetch: async () => new Response(new Uint8Array(8)),
        self: {
          importScripts() {
            context.DracoDecoderModule = context.BASIS = () => context.WebAssembly.instantiate();
          },
          postMessage(message) {
            reply = message;
          },
        },
      };
      runInNewContext(readFileSync(new URL('../dist/decoder.worker.js', import.meta.url), 'utf8'), context);
      await context.self.onmessage({
        data: { id: 1, type, wrapperURL: '/wrapper.js', transcoderURL: '/basis.js', wasmURL: '/module.wasm' },
      });
      assert.equal(reply.code, 'failed');
      assert.match(reply.error, /'wasm-unsafe-eval'.*script-src/);
      assert.match(reply.error, /https:\/\/margoengine.com\/llms\/docs\/csp\.md/);
      const worker = {
        postMessage() {
          this.onmessage({ data: reply });
        },
        terminate() {},
      };
      const pool = new WorkerPool(1, () => worker);
      await assert.rejects(pool.run({}, []), { name: 'MargoError', code: 'failed', message: reply.error });
      pool.dispose();
    });
}

// KB-CSP-STUB1, forced here on every Node: a module somebody else is already loading when the block is stubbed in.
test('a blocked-compilation stub leaves a module already loading in the process alone', async (t) => {
  const empty = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
    loading = WebAssembly.compile(empty).then((module) => WebAssembly.instantiate(module));
  stubCompile(t, 'instantiate', async () => {
    throw new EvalError('Wasm blocked by Content Security Policy');
  });
  assert.ok((await loading) instanceof WebAssembly.Instance);
  await assert.rejects(WebAssembly.instantiate(empty), EvalError);
});

test('JPEG XL worker reports blocked compilation', async (t) => {
  const messages = [];
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { 'Content-Type': 'application/wasm' } }),
  );
  for (const method of ['instantiate', 'instantiateStreaming'])
    stubCompile(t, method, async () => {
      throw new EvalError('Wasm blocked by Content Security Policy');
    });
  globalThis.self = { postMessage: (message) => messages.push(message) };
  try {
    await import('../dist/jxl.worker.js');
    await self.onmessage({ data: { id: 1, wasmURL: '/jxl.wasm', buffer: new ArrayBuffer(0) } });
    assert.equal(messages[0].code, 'failed');
    assert.match(messages[0].error, /'wasm-unsafe-eval'.*script-src/);
    assert.match(messages[0].error, /docs\/csp\.md/);
  } finally {
    delete globalThis.self;
  }
});

for (const ErrorType of [WebAssembly.CompileError, EvalError])
  test('in-process Basis loader reports blocked compilation: ' + ErrorType.name, async () => {
    const cause = new ErrorType('WebAssembly blocked by Content Security Policy');
    await assert.rejects(
      startBasis(() => Promise.reject(cause), new ArrayBuffer(0)),
      (error) => {
        assert.equal(error.name, 'MargoError');
        assert.equal(error.code, 'failed');
        assert.equal(error.cause, cause);
        assert.match(error.message, /'wasm-unsafe-eval'.*script-src/);
        assert.match(error.message, /docs\/csp\.md/);
        return true;
      },
    );
  });
