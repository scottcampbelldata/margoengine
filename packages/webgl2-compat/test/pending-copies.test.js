// A copyTextureToBuffer lands in the buffer a task later (the layer reads the texels back into a pixel pack buffer and
// applies them when the fence passes). Before 2026-11-12 only the CPU readers (mapping, bytes(), copies out of the
// buffer) applied a waiting copy first: a draw after one read the buffer's old contents as vertices, indices or
// uniforms, and a bind group that had already copied the buffer's storage rows kept them, since the version moves
// only when the copy lands. Now every reader of the GPU copies applies the waiting writes first (CompatBuffer.drain),
// without reading the whole buffer back into its CPU copy. GPU regression: features-browser.mjs texelCopyReaders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loggingDevice } from './support/logging-gl.js';

const B = { INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, COPY_DST: 0x8 },
  U = { COPY_SRC: 0x1, COPY_DST: 0x2 };

/** Copies a 4 x 1 rgba8unorm texture into each buffer in one submit: each then holds a waiting write. */
async function copied(device, buffers) {
  const texture = device.createTexture({ size: [4, 1], format: 'rgba8unorm', usage: U.COPY_SRC | U.COPY_DST });
  const e = device.createCommandEncoder();
  for (const buffer of buffers) e.copyTextureToBuffer({ texture }, { buffer }, [4, 1]);
  device.queue.submit([e.finish()]);
  // The first submit with a copy out of a texture waits for the readback code to load, then replays.
  await device.queue.waiting;
}

test('vertex, uniform and index readers apply a copy from a texture that still waits, once and in order', async () => {
  const { gl, device } = await loggingDevice(),
    vertex = device.createBuffer({ size: 16, usage: B.VERTEX | B.COPY_DST }),
    uniform = device.createBuffer({ size: 16, usage: B.UNIFORM | B.COPY_DST }),
    index = device.createBuffer({ size: 16, usage: B.INDEX | B.COPY_DST });
  await copied(device, [vertex, uniform, index]);
  for (const b of [vertex, uniform, index]) assert.equal(b.readbacks.length, 1, 'the copy waits for its fence');
  const versions = [vertex, uniform, index].map((b) => b.version);
  for (const [name, read] of [
    ['vertex', () => vertex.gl],
    ['uniform', () => uniform.gl],
    ['index', () => (index.drain(), index.element)],
  ]) {
    const from = gl.calls.length;
    assert.ok(read(), `${name}: a GL buffer`);
    const writes = gl.calls.slice(from).filter((c) => c[0] === 'bufferSubData');
    assert.ok(writes.length >= 1, `${name}: the waiting copy went into the GL buffer when it was read`);
  }
  for (const [i, b] of [vertex, uniform, index].entries()) {
    assert.equal(b.readbacks.length, 0);
    assert.equal(b.version, versions[i] + 1, 'one write landed');
  }
  // Applied once: reading again writes nothing.
  const from = gl.calls.length;
  vertex.gl;
  index.drain();
  assert.equal(gl.calls.slice(from).filter((c) => c[0] === 'bufferSubData').length, 0);
  device.destroy();
});

test('a bind group that copied a storage buffer copies it again after a waiting copy into it, without a CPU readback', async () => {
  const { gl, device } = await loggingDevice(),
    storage = device.createBuffer({ size: 16, usage: B.STORAGE | B.COPY_DST }),
    layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } }] }),
    group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: storage } }] });
  group.storageTexture();
  await copied(device, [storage]);
  assert.equal(storage.readbacks.length, 1);
  const from = gl.calls.length;
  group.storageTexture();
  const names = gl.calls.slice(from).map((c) => c[0]);
  assert.equal(storage.readbacks.length, 0, 'the waiting copy landed');
  assert.ok(names.includes('copyTexSubImage2D') || names.includes('texSubImage2D'), 'the group copied the new rows');
  // drain applies the writes only: the whole buffer is not read back into its CPU copy on the way.
  assert.equal(names.filter((n) => n === 'getBufferSubData').length, 1, 'one read: the copy itself, from its pack buffer');
  device.destroy();
});

test('a buffer destroyed while a copy from a texture waits frees the copy\'s pixel pack buffer and fence', async () => {
  const { gl, device } = await loggingDevice(),
    buffer = device.createBuffer({ size: 16, usage: B.VERTEX | B.COPY_DST });
  const from = gl.calls.length;
  await copied(device, [buffer]);
  assert.equal(buffer.readbacks.length, 1);
  const made = gl.calls.slice(from),
    sync = gl.calls.slice(from).find((c) => c[0] === 'fenceSync'),
    pack = made.find((c) => c[0] === 'bindBuffer' && c[1] === gl.PIXEL_PACK_BUFFER && c[2])?.[2];
  assert.ok(pack, 'the copy read into a pixel pack buffer');
  assert.ok(sync, 'behind a fence');
  const before = gl.calls.length;
  buffer.destroy();
  const freed = gl.calls.slice(before);
  assert.equal(buffer.readbacks.length, 0);
  assert.ok(freed.some((c) => c[0] === 'deleteBuffer' && c[1] === pack), 'the pixel pack buffer is deleted');
  assert.ok(freed.some((c) => c[0] === 'deleteSync'), 'the fence is deleted');
  assert.equal(freed.filter((c) => c[0] === 'bufferSubData').length, 0, 'the copy is not applied');
  device.destroy();
});

test('a waiting copy landing in a vertex and index buffer while a draw is set up leaves the draw\'s vertex array bound', async () => {
  const { gl, device } = await loggingDevice(),
    buffer = device.createBuffer({ size: 16, usage: B.VERTEX | B.INDEX | B.COPY_DST });
  await copied(device, [buffer]);
  const vao = gl.createVertexArray();
  device.state.bindVertexArray(vao);
  const from = gl.calls.length;
  assert.ok(buffer.gl, 'the vertex binding reads the GL buffer');
  const binds = gl.calls.slice(from).filter((c) => c[0] === 'bindVertexArray');
  assert.ok(gl.calls.slice(from).some((c) => c[0] === 'bufferSubData' && c[1] === gl.ELEMENT_ARRAY_BUFFER), 'the copy reached the element buffer');
  assert.equal(device.state.vertexArray, vao);
  assert.equal(binds.at(-1)?.[1], vao, 'the draw\'s vertex array is bound again');
  device.destroy();
});
