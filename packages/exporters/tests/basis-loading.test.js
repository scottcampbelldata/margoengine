import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { encodeNativeBasis, loadNativeBasis } from '../dist/basis-native.js';

const wasm = new URL('../dist/basis-encoder/margo_basis_encoder.wasm', import.meta.url);
const image = { width: 4, height: 4, data: new Uint8Array(64).fill(255) };
const job = {
  source: image,
  mode: 'uastc',
  srgb: false,
  normalMap: false,
  mipmaps: false,
  wholeBlocks: false,
  quality: 128,
  effort: 2,
  uastcLevel: 2,
  uastcRDO: 1,
};
const linked = (error, code = 'failed') => {
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, code);
  assert.match(error.message, /https:\/\/margoengine.com\//);
  return true;
};

for (const ErrorType of [WebAssembly.CompileError, EvalError, WebAssembly.RuntimeError])
  test(`native Basis wraps CSP ${ErrorType.name} with permission help and cause`, async (t) => {
    const cause = new ErrorType("WebAssembly blocked by CSP: 'wasm-unsafe-eval'");
    t.mock.method(WebAssembly, 'instantiate', async () => {
      throw cause;
    });
    await assert.rejects(loadNativeBasis(wasm), (error) => {
      linked(error);
      assert.equal(error.cause, cause);
      assert.match(error.message, /'wasm-unsafe-eval'.*script-src/);
      return true;
    });
  });

test('native Basis reports missing SIMD separately from invalid Wasm', async (t) => {
  const cause = new WebAssembly.CompileError('unsupported opcode');
  t.mock.method(WebAssembly, 'instantiate', async () => {
    throw cause;
  });
  const validate = WebAssembly.validate;
  const probe = t.mock.method(WebAssembly, 'validate', (bytes) => {
    // The diagnostic must itself be a valid module on a SIMD-capable runtime.
    assert.equal(validate(bytes), true);
    return false;
  });
  await assert.rejects(loadNativeBasis(wasm), (error) => {
    linked(error, 'unsupported');
    assert.match(error.message, /requires WebAssembly SIMD/);
    assert.equal(error.cause, cause);
    return true;
  });
  probe.mock.restore();
  await assert.rejects(loadNativeBasis(wasm), (error) => {
    linked(error);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('native Basis links HTTP and transport load failures', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  await assert.rejects(loadNativeBasis(new URL('https://example.invalid/encoder.wasm')), (error) => {
    linked(error);
    assert.match(error.message, /404.*Wasm URL/);
    return true;
  });
  request.mock.restore();
  const cause = new TypeError('network unavailable');
  t.mock.method(globalThis, 'fetch', async () => {
    throw cause;
  });
  await assert.rejects(loadNativeBasis(new URL('https://example.invalid/encoder.wasm')), (error) => {
    linked(error);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('Node retries a failed Basis load once per call, shares pending loads and retains success', async (t) => {
  const { encodeKTX2 } = await import('../dist/ktx2.js?load-recovery');
  const instantiate = WebAssembly.instantiate;
  let attempts = 0;
  t.mock.method(WebAssembly, 'instantiate', async (...args) => {
    if (++attempts <= 2) throw new WebAssembly.CompileError('blocked by CSP');
    return instantiate(...args);
  });
  const encode = () => encodeKTX2(image, { mode: 'uastc', mipmaps: false });
  const pending = await Promise.allSettled([encode(), encode()]);
  assert.equal(attempts, 1);
  for (const result of pending) {
    assert.equal(result.status, 'rejected');
    linked(result.reason);
  }
  await assert.rejects(encode(), linked);
  assert.equal(attempts, 2);
  const [first, second] = await Promise.all([encode(), encode()]);
  assert.equal(attempts, 3);
  assert.deepEqual(first, second);
  assert.equal(first[0], 0xab);
  assert.deepEqual(await encode(), first);
  assert.equal(attempts, 3);
});

test('worker retries a rejected native Basis load on the next message and caches success', async () => {
  let attempts = 0;
  const replies = [];
  const context = {
    URL,
    Uint8Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    Error,
    WebAssembly: {
      ...WebAssembly,
      instantiate: async () => {
        if (++attempts <= 2) throw new WebAssembly.CompileError('blocked by CSP');
        return WebAssembly.instantiate(readFileSync(wasm));
      },
    },
    fetch: async () => new Response(readFileSync(wasm)),
    self: { postMessage: (message) => replies.push(message) },
  };
  runInNewContext(readFileSync(new URL('../dist/encoder.worker.js', import.meta.url), 'utf8'), context);
  const encode = (id) =>
    context.self.onmessage({
      data: {
        id,
        kind: 'basis-native',
        wasmURL: 'https://example.invalid/encoder.wasm',
        job,
      },
    });
  await Promise.all([encode(0), encode(1)]);
  assert.equal(attempts, 1);
  replies.forEach((reply) => linked(reply.error));
  await encode(2);
  linked(replies[2].error);
  assert.equal(attempts, 2);
  await Promise.all([encode(3), encode(4)]);
  assert.equal(attempts, 3);
  assert.equal(replies[3].result.data[0], 0xab);
  assert.deepEqual(replies[3].result.data, replies[4].result.data);
  await encode(5);
  assert.equal(attempts, 3);
});

for (const failureAt of [1, 2, 3, 4])
  test(`Basis frees all owned buffers when allocation ${failureAt} traps, including RDO output`, () => {
    const live = new Map();
    let allocations = 0;
    const cause = new WebAssembly.RuntimeError('allocation failed');
    const api = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      allocate(length) {
        if (++allocations === failureAt) throw cause;
        const pointer = allocations * 128;
        live.set(pointer, length);
        return pointer;
      },
      release(pointer, length) {
        assert.equal(live.get(pointer), length);
        live.delete(pointer);
      },
      encode_uastc: () => 0,
    };
    assert.throws(
      () => encodeNativeBasis(api, job),
      (error) => error === cause,
    );
    assert.equal(live.size, 0);
  });

test('native Basis image rejection has a coded help link', () => {
  const api = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    allocate: () => 0,
    release() {},
    encode_uastc: () => 1,
  };
  assert.throws(() => encodeNativeBasis(api, job), linked);
});

test('encoder docs identify the owned encoder and external-only compatibility override', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /clean-room Rust\/Wasm encoder/);
  assert.doesNotMatch(readme, /encoder is Binomial's own/);
  assert.match(readme, /`encoderPath` \| Margo's lazy encoder \| Optional.*basis_encoder/);
  const limits = readFileSync(new URL('../../../docs/limits.md', import.meta.url), 'utf8');
  assert.match(limits, /requires WebAssembly SIMD/);
});
