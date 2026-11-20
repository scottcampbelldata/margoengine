// Regression tests of the batch 132 second audit pass of @margoengine/points: each fails without its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { ASPRS_CLASSES, classificationColors, PointCloud, PointsPlugin } from '../dist/index.js';
import { CopcSource } from '../dist/copc.js';
import { parseE57, parseXML, writeE57 } from '../dist/e57.js';
import { readLASHeader, writeLAS } from '../dist/las.js';
import { decodeLazChunk } from '../dist/laz.js';
import { buildOctree } from '../dist/octree.js';
import { PotreeSource } from '../dist/potree.js';
import { encodeLAZ } from './laz-encoder.js';
import { serve, writePotree2 } from './potree-writer.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
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
/** The COPC file of copc.test.js: a root voxel and one child voxel on a page of its own. */
function copcFile({ childRgb = [0, 0, 512, 0, 0, 512, 0, 0, 512], loop = false } = {}) {
  const c = [100, 200, 300],
    at = (x, y, z) => [c[0] + x, c[1] + y, c[2] + z],
    root = encodeNode([...at(-5, -5, -5), ...at(5, 5, 5)], [65535, 0, 0, 0, 65535, 0]),
    child = encodeNode([...at(-2, 3, -4), ...at(2, -3, 4), ...at(0, 0, 0)], childRgb),
    head = root.file.subarray(0, u32(root.file, 96)),
    records = head.byteLength + 54 + 160,
    rootChunk = records,
    childChunk = rootChunk + root.chunk.byteLength,
    page2 = childChunk + child.chunk.byteLength,
    page1 = page2 + 32,
    size = page1 + 32 * 2,
    out = new Uint8Array(size),
    view = new DataView(out.buffer);
  out.set(head);
  view.setUint32(96, records, true);
  view.setUint32(100, u32(head, 100) + 1, true);
  const o = head.byteLength;
  new TextEncoder().encodeInto('copc', out.subarray(o + 2, o + 18));
  view.setUint16(o + 18, 1, true);
  view.setUint16(o + 20, 160, true);
  const i = o + 54;
  for (const [k, v] of [...c, 10, 2].entries()) view.setFloat64(i + k * 8, v, true);
  view.setBigUint64(i + 40, BigInt(page1), true);
  view.setBigUint64(i + 48, BigInt(64), true);
  out.set(root.chunk, rootChunk);
  out.set(child.chunk, childChunk);
  entry(view, page2, 1, 0, 1, 0, childChunk, child.chunk.byteLength, 3);
  entry(view, page1, 0, 0, 0, 0, rootChunk, root.chunk.byteLength, 2);
  // The link to the child's page; `loop` points it back at this page instead.
  entry(view, page1 + 32, 1, 0, 1, 0, loop ? page1 : page2, loop ? 64 : 32, -1);
  return { out, child };
}
function rangeServer(file) {
  let asked = 0;
  return async (_url, { headers, signal }) => {
    signal?.throwIfAborted();
    if (++asked > 50) throw new Error('more than 50 range requests');
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    return new Response(file.subarray(+from, +to + 1), { status: 206 });
  };
}
const signal = new AbortController().signal;

test('COPC: a hierarchy page that links back to itself is refused, not read for ever', async () => {
  const { out } = copcFile({ loop: true });
  await assert.rejects(CopcSource.open('x.copc.laz', { fetch: rangeServer(out) }), /listed twice/);
});

test('COPC: the 16-bit or 8-bit colour reading is decided once, so a dark child of a 16-bit file stays dark', async () => {
  const { out } = copcFile({ childRgb: [200, 200, 200, 100, 100, 100, 0, 0, 0] }),
    source = await CopcSource.open('x.copc.laz', { fetch: rangeServer(out) }),
    root = await source.load(source.root, signal),
    child = await source.load(source.root.children.find(Boolean), signal);
  assert.deepEqual([...root.colors.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...child.colors], [0, 0, 0, 0, 0, 0, 0, 0, 0], 'values below 256 of a 16-bit file are near black');
});

test('LAZ: decodeLazChunk compares a layered chunk count before allocating that many records', () => {
  const { file, chunk } = encodeNode([0, 0, 0, 1, 1, 1, 2, 2, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0]),
    { header, records } = readLASHeader(file);
  assert.equal(decodeLazChunk(chunk, 3, header, records).byteLength, 3 * header.pointRecordLength);
  assert.throws(() => decodeLazChunk(chunk, 2 ** 50, header, records), /holds 3 points but its table says/);
  assert.throws(() => decodeLazChunk(chunk, -1, header, records), RangeError);
});

test('Potree 2.0: a hierarchy chunk that starts with a proxy record is corrupt (an eager open would loop on it)', async () => {
  const files = writePotree2({ positions: [0, 0, 0, 1, 1, 1, 2, 2, 2], colors: [0, 0, 0, 0, 0, 0, 0, 0, 0] }),
    hierarchy = files.get('hierarchy.bin').slice(),
    view = new DataView(hierarchy.buffer),
    first = JSON.parse(new TextDecoder().decode(files.get('metadata.json'))).hierarchy.firstChunkSize;
  hierarchy[0] = 2;
  view.setBigUint64(6, 0n, true);
  view.setBigUint64(14, BigInt(first), true);
  files.set('hierarchy.bin', hierarchy);
  await assert.rejects(PotreeSource.open('/scan/', { fetch: serve(files, '/scan/') }), /starts with a proxy/);
});

test('buildOctree: float colours in a plain array stay floats; maxDepth must be a whole number', () => {
  const tree = buildOctree({ positions: [0, 0, 0, 1, 1, 1], colors: [0.5, 0.25, 1, 1, 0, 0.5] }),
    data = tree.load(tree.root);
  assert.ok(data.colors instanceof Float32Array);
  assert.deepEqual([...data.colors].sort(), [0, 0.25, 0.5, 0.5, 1, 1]);
  const byteTree = buildOctree({ positions: [0, 0, 0], colors: new Uint8Array([10, 20, 30]) }),
    bytes = byteTree.load(byteTree.root);
  assert.ok(bytes.colors instanceof Uint8Array);
  for (const maxDepth of [Number.NaN, -1, 1.5, 65])
    assert.throws(() => buildOctree({ positions: [0, 0, 0] }, { maxDepth }), /maxDepth/);
});

test('PointCloud: normals of the wrong length are refused', () => {
  assert.throws(
    () => new PointCloud({ positions: [0, 0, 0, 1, 1, 1], normals: new Float32Array(3) }),
    (e) => e instanceof RangeError && /normals/.test(e.message),
  );
  assert.equal(new PointCloud({ positions: [0, 0, 0], normals: new Float32Array(3) }).normals.length, 3);
});

test('ASPRS classes 19 to 22 of LAS 1.4 R15 have names and colours of their own', () => {
  assert.equal(ASPRS_CLASSES[19], 'Overhead structure');
  assert.equal(ASPRS_CLASSES[22], 'Temporal exclusion');
  assert.notDeepEqual([...classificationColors([21]).subarray(0, 3)], [128, 128, 128]);
});

test('E57: colour limits are per channel, and values past them clamp instead of wrapping', () => {
  const file = writeE57([{ positions: [0, 0, 0, 1, 0, 0], rgb: [100, 100, 100, 255, 255, 255] }]),
    text = new TextDecoder('latin1').decode(file),
    from = '<colorGreenMaximum type="Integer">255</colorGreenMaximum>',
    at = text.indexOf(from);
  assert.ok(at > 0);
  file.set(new TextEncoder().encode(from.replace('255', '127')), at);
  const scan = parseE57(file, { verifyChecksums: false }).scans[0];
  assert.deepEqual([...scan.colors.subarray(0, 4)], [100, 201, 100, 255]);
  assert.deepEqual([...scan.colors.subarray(4, 8)], [255, 255, 255, 255], 'green 255 over a limit of 127 clamps');
});

test('E57: a ScaledInteger field without limits takes the 64-bit default range, not a constant', () => {
  const file = writeE57([{ positions: [0, 0, 0, 3, 0, 0], resolution: 1 }]),
    text = new TextDecoder('latin1').decode(file),
    from = ' minimum="0" maximum="3"',
    at = text.indexOf(`<cartesianX type="ScaledInteger"${from}`);
  assert.ok(at > 0);
  file.set(new TextEncoder().encode(' '.repeat(from.length)), at + '<cartesianX type="ScaledInteger"'.length);
  assert.throws(() => parseE57(file, { verifyChecksums: false }), /64 bits/);
});

test('E57: a scan name holding ]]> round-trips; an unclosed comment is named as one', () => {
  assert.equal(parseE57(writeE57([{ name: 'a]]>b', positions: [1, 2, 3] }])).scans[0].name, 'a]]>b');
  assert.throws(() => parseXML('<?xml version="1.0"?><!-- open'), /unclosed comment/);
  assert.throws(() => parseXML('<?xml version="1.0"'), /unclosed declaration/);
  assert.equal(parseXML('<?xml version="1.0"?><!-- c --><a>1</a>').text, '1');
});

test('PointsPlugin.pick skips the points a filter mask hides', () => {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    canvas = { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device, canvas }));
  const cloud = plugin.add(new PointCloud({ positions: [0, 0, 0, 0.05, 0, 0], material: { size: 4 } })),
    run = passes(plugin),
    frame = () =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      );
  plugin.onPreUpdate(1 / 60);
  frame();
  assert.equal(plugin.pick(32, 32)?.index, 0);
  cloud.setMask([false, true], { mode: 'filter' });
  assert.equal(plugin.pick(32, 32)?.index, 1, 'the hidden nearest point is skipped');
  cloud.setMaskStyle({ mode: 'fade' });
  assert.equal(plugin.pick(32, 32)?.index, 0, 'a faded point still picks');
});
