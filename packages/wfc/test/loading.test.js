import test from 'node:test';
import assert from 'node:assert/strict';
import { HeapWFC } from '../dist/chunks.js';
import { readFileSync } from 'node:fs';

const tiles = [{ neighbors: Array.from({ length: 6 }, () => [0]) }];
class RemoteHeap extends HeapWFC {
  static wasmURL() {
    return new URL('https://wfc.invalid/wfc.wasm');
  }
}
class MissingHeap extends HeapWFC {
  static wasmURL() {
    return new URL('./absent-wfc-artifact.wasm', import.meta.url);
  }
}
const failed = (e) =>
  e.name === 'MargoError' && e.code === 'failed' && /https:\/\/margoengine.com\/docs\/wfc/.test(e.message);

test('network, body and local artifact failures have coded errors with the original cause', async (t) => {
  t.after(() => {
    globalThis.fetch = original;
  });
  const original = globalThis.fetch;
  for (const backend of ['auto', 'wasm']) {
    for (const phase of ['fetch', 'body']) {
      const cause = new TypeError(`Failed ${phase}`);
      globalThis.fetch = async () => {
        if (phase === 'fetch') throw cause;
        return {
          ok: true,
          arrayBuffer: async () => {
            throw cause;
          },
        };
      };
      await assert.rejects(RemoteHeap.create([1, 1, 1], tiles, { backend }), (e) => failed(e) && e.cause === cause);
    }
    await assert.rejects(
      MissingHeap.create([1, 1, 1], tiles, { backend }),
      (e) => failed(e) && e.cause?.code === 'ENOENT',
    );
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(RemoteHeap.create([1, 1, 1], tiles, { backend }), (e) => failed(e) && /503/.test(e.message));
  }
});

test('loading preserves exact abort reasons before fetch and during failed reads', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const phase of ['fetch', 'body']) {
    const controller = new AbortController(),
      reason = { cancel: phase };
    globalThis.fetch = async () => {
      const abort = () => {
        controller.abort(reason);
        throw new TypeError('read aborted');
      };
      if (phase === 'fetch') return abort();
      return { ok: true, arrayBuffer: async () => abort() };
    };
    await assert.rejects(RemoteHeap.create([1, 1, 1], tiles, { signal: controller.signal }), (e) => e === reason);
  }
  const reason = new Error('cancel local read');
  await assert.rejects(
    MissingHeap.create([1, 1, 1], tiles, { signal: AbortSignal.abort(reason) }),
    (e) => e === reason,
  );
});

test('Wasm instantiation failures keep their cause while unsupported SIMD keeps its code', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const bytes = readFileSync(new URL('../dist/wfc.wasm', import.meta.url));
  const cause = new WebAssembly.LinkError('unavailable imports');
  t.mock.method(WebAssembly, 'instantiate', async () => {
    throw cause;
  });
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => bytes });
  await assert.rejects(RemoteHeap.create([1, 1, 1], tiles, { backend: 'wasm' }), (e) => failed(e) && e.cause === cause);
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(0) });
  assert.equal((await RemoteHeap.create([1, 1, 1], tiles)).backend, 'typescript');
  await assert.rejects(
    RemoteHeap.create([1, 1, 1], tiles, { backend: 'wasm' }),
    (e) => e.code === 'unsupported' && /https:/.test(e.message),
  );
});
