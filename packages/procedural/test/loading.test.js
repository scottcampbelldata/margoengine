import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadKernel } from '../src/wasm.ts';
import { fault } from '../../shared/errors.js';

const url = () => new URL('https://assets.example.test/trees.wasm');
const minimal = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const response = () => ({ ok: true, arrayBuffer: async () => minimal.buffer.slice(0) });
function coded(error, cause) {
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'failed');
  assert.match(error.message, /https:\/\/margoengine.com\/errors#procedural/);
  if (cause !== undefined) assert.equal(error.cause, cause);
  return true;
}

test('missing file has a procedural code/help and preserves the original filesystem error', async () => {
  const missing = pathToFileURL(join(tmpdir(), `margo-missing-kernel-${randomUUID()}.wasm`));
  await assert.rejects(loadKernel(missing, 'Trees'), (error) => {
    coded(error);
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});
test('fetch rejection and response body failure have code/help and preserve their cause', async (t) => {
  const network = new TypeError('Failed to fetch');
  t.mock.method(globalThis, 'fetch', async () => {
    throw network;
  });
  await assert.rejects(loadKernel(url(), 'Trees'), (error) => coded(error, network));
  const body = new Error('response body stream failed');
  globalThis.fetch.mock.mockImplementation(async () => ({
    ok: true,
    arrayBuffer: async () => {
      throw body;
    },
  }));
  await assert.rejects(loadKernel(url(), 'Trees'), (error) => coded(error, body));
});
test('HTTP and already linked failures retain their useful messages and identity', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));
  await assert.rejects(loadKernel(url(), 'Trees'), (error) => {
    coded(error);
    assert.match(error.message, /Trees Wasm fetch returned HTTP 404/);
    assert.equal(error.cause, undefined, 'do not wrap an existing coded HTTP fault');
    return true;
  });
  const linked = fault('failed', 'fixture linked failure', 'procedural');
  globalThis.fetch.mock.mockImplementation(async () => {
    throw linked;
  });
  await assert.rejects(loadKernel(url(), 'Trees'), (error) => error === linked);
});
test('malformed bytes preserve the ordinary CompileError as a coded procedural failure cause', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  }));
  await assert.rejects(loadKernel(url(), 'Trees'), (error) => {
    coded(error);
    assert.ok(error.cause instanceof WebAssembly.CompileError);
    return true;
  });
});
test('policy-blocked initialization retains the shared CSP help and original cause', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response());
  const cause = new WebAssembly.CompileError('WebAssembly compilation blocked by Content Security Policy');
  t.mock.method(WebAssembly, 'instantiate', async () => {
    throw cause;
  });
  await assert.rejects(loadKernel(url(), 'Trees'), (error) => {
    assert.equal(error.name, 'MargoError');
    assert.equal(error.code, 'failed');
    assert.equal(error.cause, cause);
    assert.match(error.message, /'wasm-unsafe-eval'.*script-src/);
    assert.match(error.message, /https:\/\/margoengine.com\/llms\/docs\/csp.md/);
    return true;
  });
});
test('pre-abort and abort during fetch, body read and instantiate preserve exact reasons', async (t) => {
  const pre = new AbortController(),
    preReason = { cancelled: 'before load' };
  pre.abort(preReason);
  const fetching = t.mock.method(globalThis, 'fetch', async () => response());
  await assert.rejects(loadKernel(url(), 'Trees', pre.signal), (error) => error === preReason);
  assert.equal(fetching.mock.callCount(), 0);
  for (const phase of ['fetch', 'body', 'instantiate']) {
    const controller = new AbortController(),
      reason = { cancelled: phase };
    const underlying = new DOMException('platform abort wrapper', 'AbortError');
    fetching.mock.mockImplementation(async () => {
      if (phase === 'fetch') {
        controller.abort(reason);
        throw underlying;
      }
      return {
        ok: true,
        arrayBuffer: async () => {
          if (phase === 'body') {
            controller.abort(reason);
            throw underlying;
          }
          return minimal.buffer.slice(0);
        },
      };
    });
    const instantiate = t.mock.method(WebAssembly, 'instantiate', async () => {
      controller.abort(reason);
      return { instance: { exports: {} } };
    });
    await assert.rejects(loadKernel(url(), 'Trees', controller.signal), (error) => error === reason);
    instantiate.mock.restore();
  }
});
test('a minimal valid Wasm module loads and uses the caller signal', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (requested, options) => {
    assert.equal(requested.href, url().href);
    assert.equal(options.signal, controller.signal);
    return response();
  });
  const loaded = await loadKernel(url(), 'Trees', controller.signal);
  assert.deepEqual(Object.keys(loaded), []);
});
