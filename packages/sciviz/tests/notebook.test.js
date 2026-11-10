import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookBuffers, render } from '@margoengine/sciviz/notebook';
import { decodeFigureValue, specHash } from '@margoengine/sciviz/spec';

test('binary comm preserves storage, offsets, numeric precision and hashes without base64', async () => {
  const source = new Float64Array([99, Math.PI, -1e200, 44]);
  const received = new DataView(source.buffer, 8, 16);
  const buffers = notebookBuffers({ data: received });
  assert.equal(buffers.get('data'), received);
  const spec = {
    $array: 'Float64Array',
    $buffer: 'data',
    sha256: await specHash(new Uint8Array(source.buffer, 8, 16)),
  };
  const result = await decodeFigureValue(spec, { buffers });
  assert.equal(result.buffer, source.buffer);
  assert.equal(result.byteOffset, 8);
  assert.deepEqual(Array.from(result), [Math.PI, -1e200]);
  await assert.rejects(decodeFigureValue(spec), /attachment/);
  await assert.rejects(decodeFigureValue({ ...spec, sha256: '0'.repeat(64) }, { buffers }), /hash mismatch/);
  await assert.rejects(decodeFigureValue(spec, { buffers, maxBytes: 15 }), /maxBytes/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(decodeFigureValue(spec, { buffers, signal: abort.signal }), { name: 'AbortError' });
});

test('unaligned comm slices copy once into aligned storage and exclude neighbouring bytes', async () => {
  const bytes = new Uint8Array(13).fill(255);
  bytes.set(new Uint8Array(new Float32Array([1.25, -7.5]).buffer), 3);
  const view = bytes.subarray(3, 11);
  const value = { $array: 'Float32Array', $buffer: 'x', sha256: await specHash(view) };
  const output = await decodeFigureValue(value, { buffers: notebookBuffers({ x: view }) });
  assert.notEqual(output.buffer, bytes.buffer);
  assert.deepEqual(Array.from(output), [1.25, -7.5]);
  assert.deepEqual([...bytes.slice(0, 3)], [255, 255, 255]);
  assert.throws(() => notebookBuffers({ x: [1, 2] }), /binary comm/);
  assert.throws(() => notebookBuffers([]), /dictionary/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(render({ signal: abort.signal }), { name: 'AbortError' });
});
