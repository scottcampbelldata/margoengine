import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareGLTF } from '../dist/prepare.js';

// glTF 2.0 section 4.4.3.3: the BIN chunk may be up to 3 bytes longer than buffer 0's byteLength, for 4-byte padding.
// The Khronos validator flags anything longer; before this check the loader read the declared bytes and ignored the rest.
const glb = (json, bin) => {
  const text = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = (text.length + 3) & ~3,
    total = 20 + jsonLength + 8 + bin.length,
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  view.setUint32(20 + jsonLength, bin.length, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
};
const file = (byteLength, binLength) =>
  glb({ asset: { version: '2.0' }, buffers: [{ byteLength }] }, new Uint8Array(binLength).fill(7));
const padding = (error) =>
  error.name === 'MargoError' &&
  error.code === 'failed' &&
  /BIN chunk holds 12 bytes, more than buffer 0's byteLength 8 plus 3 padding bytes/.test(error.message) &&
  error.message.endsWith('; see https://margoengine.com/errors#failed');

test('a BIN chunk up to 3 bytes past buffer 0 loads (GLB padding)', async () => {
  for (const byteLength of [9, 10, 11, 12]) {
    const prepared = await prepareGLTF(undefined, file(byteLength, 12));
    assert.equal(prepared.doc.buffers[0].byteLength, byteLength);
  }
});

test('a BIN chunk 4 or more bytes past buffer 0 throws a coded error, as the glTF Validator rejects it', async () => {
  await assert.rejects(prepareGLTF(undefined, file(8, 12)), padding);
});
