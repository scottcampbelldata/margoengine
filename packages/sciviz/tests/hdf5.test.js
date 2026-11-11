import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { openHDF5 } from '../dist/hdf5.js';
const bytes = (name) => readFileSync(new URL(`./fixtures/engineering/${name}`, import.meta.url));
for (const version of ['earliest', 'v108', 'v110', 'latest']) {
  test(`HDF5 owner writer ${version}: metadata, strings, contiguous, chunked and strided reads`, {
    timeout: 10000,
  }, async () => {
    using file = await openHDF5(bytes(`hdf-${version}.h5`));
    assert.equal((await (await file.get('/')).attributes()).name[0], 'engineering');
    assert.equal((await (await file.get('/')).attributes()).utf8[0], 'mesh α');
    for (const path of ['/contiguous', '/chunked', '/alias']) {
      const node = await file.get(path);
      assert.deepEqual(node.shape, [4, 5, 6]);
      assert.deepEqual(
        [...(await node.read())],
        Array.from({ length: 120 }, (_, i) => i),
      );
      assert.deepEqual(
        [...(await node.read({ start: [1, 1, 1], count: [2, 2, 3], stride: [2, 2, 2] }))],
        [37, 39, 41, 49, 51, 53, 97, 99, 101, 109, 111, 113],
      );
    }
    const sparse = await (await file.get('/sparse')).read();
    assert.equal(sparse[0], -7);
    assert.equal(sparse[2 * 9 + 3], 11);
    assert.equal(sparse[71], -7);
    assert.deepEqual(await (await file.get('/strings')).read(), ['α', 'beta']);
    assert.equal((await (await file.get('/dense')).keys()).length, 50);
    assert.deepEqual([...(await (await file.get('/dense/member49')).read())], [49]);
    assert.deepEqual([...(await (await file.get('/single')).read())], [1, 2, 3]);
    assert.deepEqual(
      [...(await (await file.get('/btree2')).read())],
      Array.from({ length: 60 }, (_, i) => i),
    );
    assert.deepEqual(
      [...(await (await file.get('/unlimited')).read())],
      Array.from({ length: 60 }, (_, i) => i),
    );
    assert.deepEqual(
      [...(await (await file.get('/unlimited-last')).read())],
      Array.from({ length: 60 }, (_, i) => i),
    );
    for (const name of ['paged-fixed', 'large-unlimited']) {
      assert.deepEqual(
        [...(await (await file.get('/' + name)).read({ start: [1020], count: [30] }))],
        Array.from({ length: 30 }, (_, i) => i + 1020),
      );
    }
  });
}
test('HDF5 only reads selected contiguous ranges and honors lifetime cancellation', { timeout: 10000 }, async () => {
  const data = bytes('hdf-earliest.h5'),
    ranges = [];
  const file = await openHDF5({
    async read(at, n) {
      ranges.push([at, n]);
      return data.slice(at, at + n);
    },
  });
  const node = await file.get('/contiguous');
  ranges.length = 0;
  assert.deepEqual([...(await node.read({ start: [1, 1, 1], count: [1, 1, 2] }))], [37, 38]);
  assert.equal(
    ranges.reduce((sum, [, n]) => sum + n, 0),
    16,
  );
  await assert.rejects(node.read({ count: [400, 1, 1] }), /hyperslab/);
  file.dispose();
  await assert.rejects(node.read(), /abort/i);
  await assert.rejects(file.get('/'), /abort/i);
});
test('HDF5 NASA CGNS metadata and coordinates remain lazy', { timeout: 10000 }, async () => {
  using file = await openHDF5(bytes('nasa-struct-hdf.cgns'));
  const root = await file.get('/');
  assert.ok((await root.keys()).length > 1);
});

// A minimal HDF5 file (superblock 2, version 2 object headers) holding one uint8 dataset with an implicit chunk index
// (layout 4, index type 2): chunks stored back to back in row-major chunk order from one address.
function implicitFile(shape, chunk, chunks) {
  const parts = [],
    u = (n, w) => {
      const b = new Uint8Array(w);
      let v = BigInt(n);
      for (let i = 0; i < w; i++, v >>= 8n) b[i] = Number(v & 255n);
      return b;
    },
    cat = (...a) => {
      const out = new Uint8Array(a.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of a) out.set(b, (at += b.length) - b.length);
      return out;
    },
    header = (messages) => {
      const body = cat(...messages.map(([type, data]) => cat(u(type, 1), u(data.length, 2), u(0, 1), data)));
      return cat(new TextEncoder().encode('OHDR'), u(2, 1), u(2, 1), u(body.length, 4), body, u(0, 4));
    };
  const space = cat(u(2, 1), u(shape.length, 1), u(0, 1), u(1, 1), ...shape.map((n) => u(n, 8))),
    type = cat(u(0x10, 1), u(0, 3), u(1, 4), u(0, 2), u(8, 2));
  const dataAt = 48 + 200,
    layout = cat(u(4, 1), u(2, 1), u(0, 1), u(chunk.length + 1, 1), u(8, 1), ...chunk.map((n) => u(n, 8)), u(1, 8), u(2, 1), u(dataAt, 8));
  const dataset = header([[1, space], [3, type], [8, layout]]),
    datasetAt = dataAt + chunks.length;
  const name = new TextEncoder().encode('implicit'),
    root = header([[6, cat(u(1, 1), u(0, 1), u(name.length, 1), name, u(datasetAt, 8))]]);
  const end = datasetAt + dataset.length;
  parts.push(
    cat(Uint8Array.of(137, 72, 68, 70, 13, 10, 26, 10), u(2, 1), u(8, 1), u(8, 1), u(0, 1), u(0, 8), u(2n ** 64n - 1n, 8), u(end, 8), u(48, 8), u(0, 4)),
  );
  parts.push(root, new Uint8Array(dataAt - 48 - root.length), chunks, dataset);
  return cat(...parts);
}
test('HDF5 implicit chunk index visits only the chunks a selection touches (KB0535b)', { timeout: 10000 }, async () => {
  // 6 x 6 values 0..35 in 2 x 2 chunks, stored chunk by chunk.
  const chunks = new Uint8Array(36);
  for (let k = 0, i = 0; k < 9; k++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) chunks[i++] = (Math.floor(k / 3) * 2 + y) * 6 + (k % 3) * 2 + x;
  const data = implicitFile([6, 6], [2, 2], chunks),
    reads = [];
  using file = await openHDF5({
    async read(at, n) {
      reads.push([at, n]);
      return data.slice(at, at + n);
    },
  });
  const node = await file.get('/implicit');
  assert.deepEqual([...(await node.read())], Array.from({ length: 36 }, (_, i) => i));
  reads.length = 0;
  // Rows 0 and 3, columns 1 and 4: chunk rows 0 and 1, chunk columns 0 and 2. Four chunks hold a selected value.
  assert.deepEqual([...(await node.read({ start: [0, 1], count: [2, 2], stride: [3, 3] }))], [1, 4, 19, 22]);
  assert.equal(reads.length, 4);
  // 2^40 x 4 values in 1 x 4 chunks: the old index loop walked 2^40 chunk numbers for any read and never finished.
  const huge = implicitFile([2 ** 40, 4], [1, 4], Uint8Array.from({ length: 20 }, (_, i) => i));
  using big = await openHDF5(huge);
  const tall = await big.get('/implicit');
  assert.deepEqual([...(await tall.read({ start: [3, 1], count: [2, 3] }))], [13, 14, 15, 17, 18, 19]);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(tall.read({ start: [0, 0], count: [1, 4], signal: stop.signal }), /abort/i);
});
