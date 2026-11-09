import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parsePLY, parsePLYHeader } from '../dist/index.js';
import { referencePLYFacts } from '../scripts/ply-reference.mjs';
import { requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';

test('the complete outside big-endian horse matches every python-plyfile position, color and index', () => {
  const root = requireExternalAssets('ply-horse/');
  const bytes = readFileSync(resolve(root, 'horse.ply'));
  const oracle = JSON.parse(readFileSync(new URL('./fixtures/horse-oracle.json', import.meta.url)));
  const hash = (array) =>
    createHash('sha256')
      .update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
      .digest('hex');
  assert.equal(hash(bytes), oracle.sourceSha256);
  const header = parsePLYHeader(bytes);
  assert.equal(header.format, 'binary_big_endian');
  assert.deepEqual(
    header.elements.find((element) => element.name === 'vertex').properties.map((p) => p.name),
    oracle.vertexProperties,
  );
  assert.deepEqual(referencePLYFacts(new Uint8Array(bytes)), {
    vertices: oracle.vertices,
    triangles: oracle.triangles,
  });
  const model = parsePLY(bytes);
  assert.equal(model.kind, 'mesh');
  assert.equal(model.positions.length, oracle.positionComponents);
  assert.equal(model.indices.length, oracle.indexComponents);
  assert.equal(model.colors.length, oracle.colorComponents);
  assert.equal(hash(model.positions), oracle.positionsFloat32LESha256);
  assert.equal(hash(model.colors), oracle.colorsFloat32LESha256);
  assert.equal(hash(Uint32Array.from(model.indices)), oracle.indicesUint32LESha256);
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < model.positions.length; i++) {
    const a = i % 3;
    bounds[a] = Math.min(bounds[a], model.positions[i]);
    bounds[a + 3] = Math.max(bounds[a + 3], model.positions[i]);
  }
  assert.deepEqual(bounds, oracle.bounds);
  assert.equal(model.normals, undefined, 'this file has no authored normals');
});

for (const little of [false, true])
  test(`the PLY reference count walk respects mixed scalar widths, extra elements and list widths (${little ? 'LE' : 'BE'})`, () => {
    const header = Buffer.from(
      `ply\nformat binary_${little ? 'little' : 'big'}_endian 1.0\nelement custom 1\nproperty list ushort short values\nelement vertex 3\nproperty float32 x\nproperty float32 y\nproperty float32 z\nproperty float32 confidence\nproperty uint8 red\nproperty uint8 green\nproperty uint8 blue\nelement face 1\nproperty list ushort uint16 vertex_indices\nproperty double quality\nend_header\n`,
    );
    const body = new Uint8Array(6 + 3 * 19 + 8 + 8);
    const view = new DataView(body.buffer);
    view.setUint16(0, 2, little);
    view.setInt16(2, -5, little);
    view.setInt16(4, 7, little);
    for (let i = 0; i < 3; i++) {
      view.setFloat32(6 + i * 19, i, little);
      view.setFloat32(6 + i * 19 + 12, 1, little);
      body.set([255, 128, 0], 6 + i * 19 + 16);
    }
    const face = 6 + 3 * 19;
    view.setUint16(face, 3, little);
    for (let i = 0; i < 3; i++) view.setUint16(face + 2 + i * 2, i, little);
    view.setFloat64(face + 8, 0.25, little);
    const bytes = new Uint8Array(Buffer.concat([header, body]));
    assert.deepEqual(referencePLYFacts(bytes), { vertices: 3, triangles: 1 });
    assert.throws(() => referencePLYFacts(bytes.subarray(0, -1)), /complete binary scalar/);
    assert.throws(() => referencePLYFacts(Buffer.concat([bytes, Buffer.from([0])])), /walk ended/);
  });

test('the PLY reference count walk consumes declared ASCII extras and polygon lists', () => {
  const bytes = Buffer.from(
    'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nelement face 1\nproperty list uchar int vertex_indices\nproperty float quality\nend_header\n0 0 0 255\n1 0 0 128\n1 1 0 0\n0 1 0 64\n4 0 1 2 3 0.5\n',
  );
  assert.deepEqual(referencePLYFacts(bytes), { vertices: 4, triangles: 2 });
  for (const ending of ['\n', '\r\n', '\r']) {
    const headerComment = bytes
      .toString()
      .replace('element vertex', 'comment end_header is only a comment\nelement vertex');
    assert.deepEqual(referencePLYFacts(Buffer.from(headerComment.replaceAll('\n', ending))), {
      vertices: 4,
      triangles: 2,
    });
  }
});
