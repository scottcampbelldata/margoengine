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
