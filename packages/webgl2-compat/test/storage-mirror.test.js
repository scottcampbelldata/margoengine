// AMD GPU hunt row 34 (Radeon 680M, biomes flythrough on the WebGL2 layer): every bind group copied each changed
// storage buffer whole out of its GL buffer into the group's own texture, so a buffer read by six bind groups went up
// six times a frame (about 1,140 texSubImage2D a frame, 860 MB). A buffer now goes up once per version, into its own
// data texture, and each group copies its rows from there on the GPU (copyTexSubImage2D); an unchanged buffer costs
// nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loggingDevice } from './support/logging-gl.js';

const STORAGE = 0x80,
  COPY_DST = 0x8;

/** Bind groups of two read-only storage bindings each: the shared buffer first, then one of their own. */
function groups(device, shared, count) {
  const layout = device.createBindGroupLayout({
    entries: [0, 1].map((binding) => ({ binding, visibility: 1, buffer: { type: 'read-only-storage' } })),
  });
  return Array.from({ length: count }, () =>
    device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: shared } },
        { binding: 1, resource: { buffer: device.createBuffer({ size: 256, usage: STORAGE | COPY_DST }) } },
      ],
    }),
  );
}

const counted = (gl, run) => {
  const from = gl.calls.length;
  run();
  const names = gl.calls.slice(from).map((c) => c[0]);
  return {
    uploads: names.filter((n) => n === 'texSubImage2D').length,
    copies: names.filter((n) => n === 'copyTexSubImage2D').length,
  };
};

test('two bind groups reading one changed storage buffer upload it once; an unchanged buffer costs nothing', async () => {
  const { gl, device } = await loggingDevice(),
    shared = device.createBuffer({ size: 4096, usage: STORAGE | COPY_DST }),
    [a, b] = groups(device, shared, 2);
  // First use: each buffer goes up once (the shared one and each group's own), and each group copies both bindings.
  assert.deepEqual(
    counted(gl, () => (a.storageTexture(), b.storageTexture())),
    { uploads: 3, copies: 4 },
  );
  device.queue.writeBuffer(shared, 0, new Uint8Array(64).fill(7));
  // The shared buffer changed: one upload (it went up once per group before), one copy per group, the rest untouched.
  assert.deepEqual(
    counted(gl, () => (a.storageTexture(), b.storageTexture())),
    { uploads: 1, copies: 2 },
  );
  // Nothing changed: no upload and no copy.
  assert.deepEqual(
    counted(gl, () => (a.storageTexture(), b.storageTexture())),
    { uploads: 0, copies: 0 },
  );
  device.destroy();
});

test('a group copies a binding at an offset into its buffer in whole rows when the widths match', async () => {
  const { gl, device } = await loggingDevice(),
    // 4,096 rows: a data texture 2,048 wide, two rows high; the binding is its last 2,560 rows from row 1,536.
    shared = device.createBuffer({ size: 65536, usage: STORAGE | COPY_DST }),
    layout = device.createBindGroupLayout({
      entries: [0, 1].map((binding) => ({ binding, visibility: 1, buffer: { type: 'read-only-storage' } })),
    }),
    group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: device.createBuffer({ size: 48, usage: STORAGE }) } },
        { binding: 1, resource: { buffer: shared, offset: 24576, size: 40960 } },
      ],
    });
  const from = gl.calls.length,
    data = group.storageTexture(),
    copies = gl.calls.slice(from).filter((c) => c[0] === 'copyTexSubImage2D');
  // The binding starts at the same column as in its data texture (1,536), so it copies in two rectangles, not one a row.
  assert.equal(data.shift, 11);
  assert.equal(data.rows.get(1) % 2048, 1536);
  assert.deepEqual(
    copies.map((c) => c.slice(3)),
    [
      [0, 0, 0, 0, 3, 1],
      [1536, 0, 1536, 0, 512, 1],
      [0, 1, 0, 1, 2048, 1],
    ],
  );
  device.destroy();
});
