import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileWasmAsset } from '../packages/shared/wasm-asset.js';

const EMPTY_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const failure = (message, cause) => Object.assign(new Error(message), { cause });
const http = (status) => `HTTP ${status}`;

test('compileWasmAsset reads a file: URL, dropping its ?no-inline query', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wasm-asset-'));
  try {
    await writeFile(join(dir, 'k.wasm'), EMPTY_MODULE);
    const url = new URL('?no-inline', pathToFileURL(join(dir, 'k.wasm')));
    const module = await compileWasmAsset(url, undefined, failure, http, 'unsupported');
    assert.ok(module instanceof WebAssembly.Module);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compileWasmAsset wraps unreadable bytes with the caller message and cause', async () => {
  const url = pathToFileURL(join(tmpdir(), 'wasm-asset-missing', 'none.wasm'));
  await assert.rejects(compileWasmAsset(url, undefined, failure, http, 'unsupported'), (e) => {
    assert.equal(e.message, 'unsupported');
    assert.ok(e.cause);
    return true;
  });
});

test('compileWasmAsset reports a non-OK HTTP status once, without wrapping it', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    await assert.rejects(
      compileWasmAsset(new URL('https://example.test/k.wasm'), undefined, failure, http, 'unsupported'),
      (e) => e.message === 'HTTP 404' && e.cause === undefined,
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('compileWasmAsset rethrows the abort reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const url = pathToFileURL(join(tmpdir(), 'none.wasm'));
  await assert.rejects(compileWasmAsset(url, controller.signal, failure, http, 'unsupported'), /stop/);
});
