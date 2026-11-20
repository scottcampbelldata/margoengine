import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// The CGNS reader is tested over an in-memory SIDS tree: the HDF5 layer is mocked, so each coordinate set is exact.
const dist = new URL('../dist/', import.meta.url),
  chunk = /from "\.\/(hdf5-[^"]+\.js)"/.exec(readFileSync(new URL('cgns.js', dist), 'utf8'))[1];
const text = (s) => Float64Array.from(s, (c) => c.charCodeAt(0));
let tree;
function node(raw) {
  const path = raw.replace(/\/+/g, '/'),
    n = tree[path];
  if (!n) throw new Error(`no ${path}`);
  return {
    path,
    shape: n.shape ?? [n.data?.length ?? 0],
    keys: async () =>
      Object.keys(tree)
        .filter(
          (p) => p.startsWith(path === '/' ? '/' : path + '/') && p !== path && !p.slice(path.length + 1).includes('/'),
        )
        .map((p) => p.split('/').at(-1)),
    attributes: async () => (n.label ? { label: [n.label] } : {}),
    read: async () => n.data,
  };
}
mock.module(new URL(chunk, dist).href, {
  namedExports: {
    t: async () => ({ get: async (p) => node(p), [Symbol.dispose]() {}, dispose() {} }),
  },
});
const { readCGNS } = await import('../dist/cgns.js');
function zone(coords) {
  tree = {
    '/': {},
    '/B': { label: 'CGNSBase_t' },
    '/B/ data': { data: Float64Array.of(1, 3) },
    '/B/Z': { label: 'Zone_t' },
    '/B/Z/ data': { data: Float64Array.of(3, 2, 0), shape: [3, 1] },
    '/B/Z/ZoneType': { label: 'ZoneType_t' },
    '/B/Z/ZoneType/ data': { data: text('Structured') },
    '/B/Z/G': { label: 'GridCoordinates_t' },
  };
  for (const [name, values] of Object.entries(coords)) {
    tree[`/B/Z/G/${name}`] = { label: 'DataArray_t' };
    tree[`/B/Z/G/${name}/ data`] = { data: Float64Array.from(values) };
  }
}
test('CGNS coordinates name one complete system with one length; a partial or mixed set is refused', async () => {
  zone({ CoordinateR: [1, 2, 3], CoordinateTheta: [0, Math.PI / 2, Math.PI], CoordinateZ: [5, 6, 7] });
  const grid = await readCGNS(new Uint8Array(1));
  const p = grid.blocks?.[0]?.points ?? grid.points;
  assert.ok(p, 'points');
  const expected = [1, 0, 5, 0, 2, 6, -3, 0, 7];
  expected.forEach((v, i) => assert.ok(Math.abs(p[i] - v) < 1e-12, `${i}: ${p[i]} for ${v}`));
  for (const coords of [
    { CoordinateR: [1, 2, 3] },
    { CoordinateX: [1, 2, 3], CoordinateTheta: [0, 1, 2] },
    { CoordinateX: [1, 2, 3], CoordinateY: [1, 2] },
    { CoordinateR: [1, 2, 3], CoordinateTheta: [0, 1, 2], CoordinatePhi: [0, 1, 2] },
  ]) {
    zone(coords);
    await assert.rejects(readCGNS(new Uint8Array(1)), /CGNS coordinates/, JSON.stringify(coords));
  }
});
