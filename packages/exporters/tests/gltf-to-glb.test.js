// GAP-FILM-GLTFPACK: no public entry packed a .gltf and the files beside it into one GLB; apps wrote their own packer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gltfToGLB, imageMimeType } from '../dist/gltf-to-glb.js';
import { splitGLB } from '../dist/glb.js';
import { validate } from './helpers.js';

const fixtures = new URL('../../decoders/tests/fixtures/', import.meta.url);
const read = (uri) => readFileSync(new URL(uri, fixtures));
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('gltfToGLB packs the Khronos Box and its .bin into one GLB with the same bytes at every view', async () => {
  const text = readFileSync(new URL('Box.gltf', fixtures), 'utf8'),
    doc = JSON.parse(text),
    bin = read(doc.buffers[0].uri),
    glb = await gltfToGLB(text, { read }),
    { json, bin: chunk } = splitGLB(glb);
  assert.equal(json.buffers.length, 1);
  assert.equal(json.buffers[0].uri, undefined);
  assert.deepEqual(json.meshes, doc.meshes);
  assert.deepEqual(json.accessors, doc.accessors);
  for (const [i, view] of doc.bufferViews.entries()) {
    const at = view.byteOffset ?? 0,
      moved = json.bufferViews[i];
    assert.equal(moved.buffer, 0);
    assert.deepEqual(
      Buffer.from(chunk.subarray(moved.byteOffset, moved.byteOffset + view.byteLength)),
      bin.subarray(at, at + view.byteLength),
    );
  }
  assert.equal(JSON.parse(text).buffers[0].uri, doc.buffers[0].uri, 'the input is not changed');
  const report = await validate(glb);
  assert.deepEqual([report.errors, report.warnings], [0, 0], JSON.stringify(report.messages));
});

test('gltfToGLB joins several buffers 4-byte aligned, embeds images and data URIs, and rewrites meshopt views', async () => {
  const files = { 'a b.bin': new Uint8Array([1, 2, 3]), 'tex/c.png': png, 'b.bin': new Uint8Array([9, 9, 9, 9, 9]) };
  const gltf = {
    asset: { version: '2.0' },
    buffers: [
      { byteLength: 3, uri: 'a%20b.bin' },
      { byteLength: 4, uri: 'data:application/octet-stream;base64,BQYHCA==' },
      { byteLength: 64, extensions: { EXT_meshopt_compression: { fallback: true } } },
      { byteLength: 5, uri: 'b.bin' },
    ],
    bufferViews: [
      { buffer: 0, byteLength: 3 },
      { buffer: 1, byteOffset: 1, byteLength: 3 },
      {
        buffer: 2,
        byteLength: 64,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 3,
            byteOffset: 1,
            byteLength: 4,
            count: 1,
            byteStride: 4,
            mode: 'ATTRIBUTES',
          },
        },
      },
    ],
    images: [{ uri: 'tex/c.png' }, { uri: 'data:image/png;base64,' + Buffer.from(png).toString('base64') }],
    extensionsUsed: ['EXT_meshopt_compression'],
  };
  const asked = [],
    glb = await gltfToGLB(gltf, {
      read: (uri) => {
        asked.push(uri);
        return files[decodeURIComponent(uri)];
      },
    }),
    { json, bin } = splitGLB(glb);
  assert.deepEqual(
    asked,
    ['a%20b.bin', 'b.bin', 'tex/c.png'],
    'read gets each uri as written; data URIs are decoded here',
  );
  assert.deepEqual(json.buffers.slice(1), [gltf.buffers[2]], 'the meshopt fallback buffer is kept');
  const views = json.bufferViews;
  assert.deepEqual([...bin.subarray(views[0].byteOffset, views[0].byteOffset + 3)], [1, 2, 3]);
  assert.deepEqual([...bin.subarray(views[1].byteOffset, views[1].byteOffset + 3)], [6, 7, 8]);
  assert.equal(views[1].byteOffset % 4, 1, 'a buffer starts 4-byte aligned and the view keeps its offset in it');
  assert.equal(views[2].buffer, 1);
  const meshopt = views[2].extensions.EXT_meshopt_compression;
  assert.equal(meshopt.buffer, 0);
  assert.deepEqual([...bin.subarray(meshopt.byteOffset, meshopt.byteOffset + 4)], [9, 9, 9, 9]);
  for (const image of json.images) {
    assert.equal(image.uri, undefined);
    assert.equal(image.mimeType, 'image/png');
    const view = views[image.bufferView];
    assert.deepEqual([...bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)], [...png]);
  }
});

test('gltfToGLB refuses files outside the folder, short buffers and unknown images, and names the fix', async () => {
  const doc = (uri) => ({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri }] });
  const four = () => new Uint8Array(4);
  for (const uri of ['../x.bin', '/etc/x.bin', 'https://example.com/x.bin', 'file:///x.bin', 'a/%2e%2e/../x.bin'])
    await assert.rejects(gltfToGLB(doc(uri), { read: four }), /outside the glTF's folder.*errors#gltf-to-glb/);
  assert.equal((await gltfToGLB(doc('../x.bin'), { read: four, outside: true })).length > 0, true);
  await assert.rejects(gltfToGLB(doc('x.bin')), /pass read/);
  await assert.rejects(gltfToGLB(doc('x.bin'), { read: () => new Uint8Array(3) }), RangeError);
  await assert.rejects(
    gltfToGLB({ asset: { version: '2.0' }, images: [{ uri: 'a.tga' }] }, { read: four }),
    /not a PNG, JPEG, WebP, KTX2 or AVIF/,
  );
  await assert.rejects(gltfToGLB({ asset: { version: '1.0' } }), /glTF 2.0/);
  await assert.rejects(gltfToGLB('{'), TypeError);
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(gltfToGLB(doc('x.bin'), { read: four, signal: stop.signal }), /stopped/);
});

test('imageMimeType reads the five glTF image signatures', () => {
  const bytes = (...parts) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
  assert.equal(imageMimeType(png), 'image/png');
  assert.equal(imageMimeType(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageMimeType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
  assert.equal(imageMimeType(bytes([0xab], 'KTX 20', [0xbb, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/ktx2');
  assert.equal(imageMimeType(bytes([0, 0, 0, 0x1c], 'ftypavif')), 'image/avif');
  assert.equal(imageMimeType(bytes('GIF89a')), undefined);
});

test('gltfToGLB rewrites KHR_meshopt_compression views like EXT_ ones and never puts a fallback buffer at index 0', async () => {
  const gltf = {
    asset: { version: '2.0' },
    buffers: [
      { byteLength: 16, extensions: { KHR_meshopt_compression: { fallback: true } } },
      { byteLength: 4, uri: 'data:application/octet-stream;base64,BwcHBw==' },
    ],
    bufferViews: [
      {
        buffer: 0,
        byteLength: 16,
        extensions: {
          KHR_meshopt_compression: { buffer: 1, byteLength: 4, count: 1, byteStride: 4, mode: 'ATTRIBUTES' },
        },
      },
    ],
  };
  const { json, bin } = splitGLB(await gltfToGLB(gltf));
  assert.equal(json.buffers[0].uri, undefined);
  assert.deepEqual(json.buffers[1], gltf.buffers[0], 'the fallback buffer moves to index 1');
  assert.equal(json.bufferViews[0].buffer, 1);
  const meshopt = json.bufferViews[0].extensions.KHR_meshopt_compression;
  assert.equal(meshopt.buffer, 0);
  assert.deepEqual([...bin.subarray(meshopt.byteOffset, meshopt.byteOffset + 4)], [7, 7, 7, 7]);
  const only = { asset: { version: '2.0' }, buffers: [gltf.buffers[0]], bufferViews: [{ buffer: 0, byteLength: 16 }] };
  const packed = splitGLB(await gltfToGLB(only));
  assert.equal(packed.json.buffers[0].uri, undefined);
  assert.ok(packed.bin && packed.json.buffers[0].byteLength === packed.bin.byteLength, 'buffer 0 is the BIN chunk');
  assert.equal(packed.json.bufferViews[0].buffer, 1);
});
