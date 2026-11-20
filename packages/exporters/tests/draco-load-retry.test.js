// compressDraco in Node: one failed load of the encoder Wasm must not fail every later call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compressDraco } from '@margoengine/exporters/draco';

test('a failed Draco encoder load is retried by the next call instead of cached', async () => {
  const source = new Uint8Array(readFileSync(new URL('./fixtures/Box.glb', import.meta.url))),
    instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = () => Promise.reject(new Error('simulated encoder load failure'));
  try {
    await assert.rejects(compressDraco(source));
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  const { compressed } = await compressDraco(source);
  assert.equal(compressed, 1);
});
