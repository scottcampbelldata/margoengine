// The pure parts of the frame recorder and replay behind the voxel `--replay` repro (scripts/support/webgpu-trace.js,
// webgpu-replay.js; docs/known-bugs.md "4x MSAA blending is not repeatable"): a replay that copied the wrong bytes of a
// writeBuffer call, or lost an object reference, would draw something else and hide or invent a GPU fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromBase64,
  reachable,
  revive,
  serialize,
  textureSize,
  toBase64,
  writeRange,
} from '../scripts/support/webgpu-trace.js';
import { sampleSet } from '../scripts/support/webgpu-replay.js';

test('writeRange takes the bytes queue.writeBuffer writes: element offsets for typed arrays, byte offsets for buffers', () => {
  const floats = new Float32Array([1, 2, 3, 4]);
  assert.deepEqual([...writeRange(floats)], [...new Uint8Array(floats.buffer)]);
  // dataOffset 1 and size 2 count floats: bytes 4 to 12.
  assert.deepEqual([...writeRange(floats, 1, 2)], [...new Uint8Array(floats.buffer, 4, 8)]);
  // A view into a larger buffer starts at its own byteOffset.
  const words = new Uint32Array([10, 20, 30, 40]).subarray(2);
  assert.deepEqual([...writeRange(words)], [...new Uint8Array(words.buffer, 8, 8)]);
  assert.deepEqual([...writeRange(words, 1)], [...new Uint8Array(words.buffer, 12, 4)]);
  // An ArrayBuffer counts bytes.
  const raw = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  assert.deepEqual([...writeRange(raw, 2, 2)], [3, 4]);
  assert.deepEqual([...writeRange(raw, 3)], [4, 5]);
  assert.throws(() => writeRange(floats, 3, 2), RangeError);
});

test('serialize and revive keep object references and bytes, and drop functions', () => {
  const buffer = { kind: 'buffer' },
    view = { kind: 'view' },
    ids = new Map([
      [buffer, 0],
      [view, 1],
    ]);
  const descriptor = {
    entries: [
      { binding: 0, resource: { buffer, offset: 256, size: 64 } },
      { binding: 1, resource: view },
    ],
    data: new Uint16Array([1, 65535]),
    label: 'group',
    method() {},
  };
  const json = JSON.parse(JSON.stringify(serialize(descriptor, (o) => ids.get(o))));
  assert.deepEqual(json.entries[0].resource, { buffer: { $id: 0 }, offset: 256, size: 64 });
  assert.equal(json.method, undefined);
  const back = revive(json, (id) => [buffer, view][id]);
  assert.equal(back.entries[0].resource.buffer, buffer);
  assert.equal(back.entries[1].resource, view);
  assert.deepEqual([...back.data], [1, 0, 255, 255]);
  assert.equal(back.label, 'group');
});

test('base64 round-trips every byte value, past one 32 KiB chunk', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 255);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test('reachable follows calls into descriptors, views, auto layouts and bundles, and nothing else', () => {
  const objects = [
    { t: 'texture', desc: {} },
    { t: 'view', texture: 0, desc: {} },
    { t: 'createRenderPipeline', desc: { layout: 'auto' } },
    { t: 'autoLayout', pipeline: 2, index: 0 },
    { t: 'createBindGroup', desc: { layout: { $id: 3 }, entries: [{ binding: 0, resource: { $id: 1 } }] } },
    { t: 'bundle', desc: {}, calls: [['setBindGroup', [0, { $id: 4 }]]] },
    { t: 'buffer', desc: {} },
  ];
  const calls = [['executeBundles', 9, [[{ $id: 5 }]], null]];
  assert.deepEqual([...reachable(objects, calls)].sort(), [0, 1, 2, 3, 4, 5]);
});

test('textureSize and sampleSet read descriptors and probe words as the replay prints them', () => {
  assert.deepEqual(textureSize({ size: [16, 16, 13] }), [16, 16, 13]);
  assert.deepEqual(textureSize({ size: { width: 320, height: 240 } }), [320, 240, 1]);
  assert.equal(sampleSet(new Uint32Array([0xff3e3f41, 0xff6b6f70, 0, 0x01020304])), '65.63.62|112.111.107|0.0.0|4.3.2');
});
