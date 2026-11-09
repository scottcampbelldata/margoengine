import test from 'node:test';
import assert from 'node:assert/strict';
import { glbChunks, GLB_MAGIC, GLB_JSON, GLB_BIN } from '../packages/shared/glb.js';

function file(types = [GLB_JSON, GLB_BIN]) {
  const bytes = new Uint8Array(12 + types.length * 12),
    view = new DataView(bytes.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  types.forEach((type, i) => {
    view.setUint32(12 + i * 12, 4, true);
    view.setUint32(16 + i * 12, type, true);
  });
  return bytes;
}
const check = (bytes, pattern) =>
  assert.throws(
    () => glbChunks(bytes),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, pattern);
      assert.match(error.message, /pass a whole glTF 2.0 GLB file/);
      assert.match(error.message, /https:\/\/margoengine.com\/errors#/);
      return true;
    },
  );
test('short GLB explains both required headers', () => check(new Uint8Array(19), /20 bytes.*12-byte.*8-byte/));
for (const [name, offset, value, pattern] of [
  ['magic', 0, 0, /magic/],
  ['version', 4, 1, /version 1.*version 2/],
  ['total length', 8, 999, /total length 999.*36/],
  ['chunk length', 12, 5, /chunk length 5.*4-byte/],
  ['chunk bounds', 12, 40, /chunk.*40.*36/],
])
  test(`GLB identifies ${name}`, () => {
    const bytes = file();
    new DataView(bytes.buffer).setUint32(offset, value, true);
    check(bytes, pattern);
  });
for (const types of [[GLB_BIN], [GLB_JSON, GLB_JSON], [GLB_JSON, GLB_BIN, GLB_BIN], [GLB_JSON, 123, GLB_BIN]])
  test(`GLB chunk order ${types}`, () => check(file(types), /JSON first.*at most one BIN second/));
test('partial chunk header names the missing eight-byte header', () => {
  const whole = file(),
    bytes = new Uint8Array(whole.length + 4);
  bytes.set(whole);
  new DataView(bytes.buffer).setUint32(8, bytes.length, true);
  check(bytes, /8-byte chunk header/);
});
test('unknown chunks remain permitted after JSON and BIN', () => {
  const bytes = file([GLB_JSON, GLB_BIN, 123]),
    chunks = glbChunks(bytes);
  assert.deepEqual(
    chunks.map((c) => c.type),
    [GLB_JSON, GLB_BIN, 123],
  );
  for (const c of chunks) assert.equal(c.data.buffer, bytes.buffer);
});
