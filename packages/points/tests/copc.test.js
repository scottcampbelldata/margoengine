// COPC reading against a file this test writes from the public specification: its chunks come from tests/laz-encoder.js,
// a separate encoder, so a pass proves the reader follows that reading of the format, not byte compatibility with PDAL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopcSource, copcInfo } from '@margoengine/points/copc';
import { writeLAS } from '../dist/las.js';
import { encodeLAZ } from './laz-encoder.js';

const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
/** One node's LAZ: the chunk, and the file it came from, whose header and records the whole file reuses. */
function encodeNode(positions, rgb) {
  const file = encodeLAZ(writeLAS({ positions, rgb, pointFormat: 7 }), { chunks: [positions.length / 3] }),
    start = u32(file, 96),
    table = Number(new DataView(file.buffer, file.byteOffset).getBigUint64(start, true));
  return { file, chunk: file.subarray(start + 8, table) };
}
const entry = (view, o, d, x, y, z, offset, bytes, count) => {
  for (const [k, v] of [d, x, y, z].entries()) view.setInt32(o + k * 4, v, true);
  view.setBigUint64(o + 16, BigInt(offset), true);
  view.setInt32(o + 24, bytes, true);
  view.setInt32(o + 28, count, true);
};
/** A COPC file: the cube is centred on [100, 200, 300] with half size 10; two voxels, one on a page of its own. */
function fixture() {
  const c = [100, 200, 300],
    at = (x, y, z) => [c[0] + x, c[1] + y, c[2] + z],
    root = encodeNode([...at(-5, -5, -5), ...at(5, 5, 5)], [65535, 0, 0, 0, 65535, 0]),
    // The same box centre as the root's, so both chunks fit the one header's offsets.
    child = encodeNode([...at(-2, 3, -4), ...at(2, -3, 4), ...at(0, 0, 0)], [0, 0, 512, 0, 0, 512, 0, 0, 512]),
    head = root.file.subarray(0, u32(root.file, 96)),
    records = head.byteLength + 54 + 160,
    rootChunk = records,
    childChunk = rootChunk + root.chunk.byteLength,
    page2 = childChunk + child.chunk.byteLength,
    page1 = page2 + 32,
    empty = 3,
    size = page1 + 32 * (2 + empty - 1),
    out = new Uint8Array(size),
    view = new DataView(out.buffer);
  out.set(head);
  view.setUint32(96, records, true);
  view.setUint32(100, u32(head, 100) + 1, true);
  // The record: user id, record id, length, then the info.
  const o = head.byteLength;
  new TextEncoder().encodeInto('copc', out.subarray(o + 2, o + 18));
  view.setUint16(o + 18, 1, true);
  view.setUint16(o + 20, 160, true);
  const i = o + 54;
  for (const [k, v] of [...c, 10, 2].entries()) view.setFloat64(i + k * 8, v, true);
  view.setBigUint64(i + 40, BigInt(page1), true);
  view.setBigUint64(i + 48, BigInt(32 * 4), true);
  out.set(root.chunk, rootChunk);
  out.set(child.chunk, childChunk);
  // Page 2: voxel 1-0-1-0, octant 2 (y bit), under the root.
  entry(view, page2, 1, 0, 1, 0, childChunk, child.chunk.byteLength, 3);
  // Page 1: the root, a link to page 2, two empty voxels with nothing under them.
  entry(view, page1, 0, 0, 0, 0, rootChunk, root.chunk.byteLength, 2);
  entry(view, page1 + 32, 1, 0, 1, 0, page2, 32, -1);
  entry(view, page1 + 64, 1, 1, 0, 0, 0, 0, 0);
  entry(view, page1 + 96, 1, 1, 1, 1, 0, 0, 0);
  return out;
}
/** A fetch over `file` that answers ranges and counts them. */
function server(file, { ranges = true, status } = {}) {
  const asked = [];
  return {
    asked,
    fetch: async (_url, { headers, signal }) => {
      signal?.throwIfAborted();
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
      asked.push([+from, +to]);
      if (status) return new Response(null, { status });
      if (!ranges) return new Response(file);
      return new Response(file.subarray(+from, +to + 1), { status: 206 });
    },
  };
}

test('open walks every hierarchy page and builds the tree by octant', async () => {
  const s = server(fixture()),
    source = await CopcSource.open('https://x/a.copc.laz', { fetch: s.fetch });
  assert.deepEqual(source.origin, [100, 200, 300]);
  assert.equal(source.info.halfSize, 10);
  assert.equal(source.root.id, 'r');
  assert.equal(source.root.count, 2);
  assert.equal(source.root.spacing, 2);
  assert.deepEqual([...source.root.bounds], [-10, -10, -10, 10, 10, 10]);
  const child = source.root.children[2];
  assert.equal(child.id, 'r2');
  assert.equal(child.level, 1);
  assert.equal(child.count, 3);
  assert.equal(child.spacing, 1);
  assert.ok(child.parent === source.root);
  assert.deepEqual([...child.bounds], [-10, 0, -10, 0, 10, 0]);
  assert.equal(source.root.children[1], null, 'an empty leaf voxel is dropped');
});

test('load reads one range and decodes its points around the origin, with 16-bit colour narrowed', async () => {
  const file = fixture(),
    s = server(file),
    source = await CopcSource.open('https://x/a.copc.laz', { fetch: s.fetch }),
    before = s.asked.length,
    signal = new AbortController().signal,
    rootData = await source.load(source.root, signal);
  assert.equal(s.asked.length, before + 1, 'one range request');
  assert.deepEqual([...rootData.positions], [-5, -5, -5, 5, 5, 5]);
  assert.deepEqual([...rootData.colors], [255, 0, 0, 0, 255, 0]);
  assert.equal(rootData.colorComponents, 3);
  const child = await source.load(source.root.children[2], signal);
  assert.deepEqual([...child.positions], [-2, 3, -4, 2, -3, 4, 0, 0, 0]);
  assert.deepEqual([...child.colors.subarray(0, 3)], [0, 0, 2]);
});

test('a server that ignores Range still works', async () => {
  const s = server(fixture(), { ranges: false }),
    source = await CopcSource.open('https://x/a.copc.laz', { fetch: s.fetch }),
    data = await source.load(source.root, new AbortController().signal);
  assert.equal(data.positions.length, 6);
});

test('errors: an HTTP error, a plain LAS file, an aborted signal, a corrupt page', async () => {
  await assert.rejects(CopcSource.open('https://x/a', { fetch: server(fixture(), { status: 404 }).fetch }), /404/);
  const plain = encodeNode([0, 0, 0, 1, 1, 1], [0, 0, 0, 0, 0, 0]).file;
  await assert.rejects(CopcSource.open('https://x/a', { fetch: server(plain).fetch }), /Not a COPC file/);
  assert.throws(() => copcInfo([]), /Not a COPC file/);
  await assert.rejects(
    CopcSource.open('https://x/a', { fetch: server(fixture()).fetch, signal: AbortSignal.abort(new Error('stop')) }),
    /stop/,
  );
  const cut = fixture(),
    view = new DataView(cut.buffer),
    infoAt = u32(cut, 96) - 160;
  view.setBigUint64(infoAt + 48, 33n, true);
  await assert.rejects(CopcSource.open('https://x/a', { fetch: server(cut).fetch }), /whole entries/);
});
