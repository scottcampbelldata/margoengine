import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargo } from '../dist/index.js';

const source = await readFile(new URL('./fixtures/triangle.margo', import.meta.url));
const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
const count = sourceView.getUint32(12, true),
  tableEnd = 64 + count * 16;
const sections = Array.from({ length: count }, (_, i) => {
  const at = 64 + i * 16,
    offset = sourceView.getUint32(at + 4, true),
    length = sourceView.getUint32(at + 8, true);
  return source.subarray(offset, offset + length);
});
const original = JSON.parse(new TextDecoder().decode(sections[0]));

// Rebuild the container so manifest mutations still have valid section bounds.
function manifest(document) {
  const payloads = [new TextEncoder().encode(JSON.stringify(document)), ...sections.slice(1)];
  const bytes = new Uint8Array(tableEnd + payloads.reduce((size, payload) => size + ((payload.length + 3) & ~3), 0));
  bytes.set(source.subarray(0, tableEnd));
  const view = new DataView(bytes.buffer);
  view.setUint32(8, bytes.length, true);
  let offset = tableEnd;
  for (const [i, payload] of payloads.entries()) {
    view.setUint32(64 + i * 16 + 4, offset, true);
    view.setUint32(64 + i * 16 + 8, payload.length, true);
    bytes.set(payload, offset);
    offset = (offset + payload.length + 3) & ~3;
  }
  return bytes;
}
function rejects(document, message) {
  assert.throws(() => decodeMargo(manifest(document)), { name: 'TypeError', message });
}

test('manifest subset retains scene and optional-array validation', () => {
  for (const value of [
    null,
    [],
    false,
    1,
    'scene',
    {},
    { ...original, asset: { version: '1.0' } },
    { ...original, meshes: [] },
    { ...original, meshes: {} },
    { ...original, nodes: [] },
    { ...original, nodes: {} },
  ])
    rejects(value, 'Invalid .margo scene');
  for (const key of ['buffers', 'bufferViews', 'accessors', 'skins', 'animations', 'extensionsRequired'])
    for (const value of [null, [], {}]) rejects({ ...original, [key]: value }, 'Unsupported .margo ' + key);
  for (const key of ['materials', 'images', 'textures', 'samplers', 'scenes'])
    for (const value of [null, {}, false, 1, 'array']) rejects({ ...original, [key]: value }, 'Invalid .margo ' + key);
});

test('manifest node count uses the configurable resource limit', () => {
  const bytes = manifest({ ...original, nodes: Array(100_001).fill({}) });
  assert.throws(() => decodeMargo(bytes), { name: 'RangeError', message: /Too many \.margo nodes.*maxNodes/ });
  assert.equal(decodeMargo(bytes, { maxNodes: 100_001 }).document.nodes.length, 100_001);
});

test('manifest subset retains primitive shape and section-reference validation', () => {
  for (const mesh of [
    null,
    false,
    1,
    'mesh',
    {},
    { primitives: [] },
    { primitives: null },
    { primitives: {} },
    { primitives: 'primitives' },
  ])
    rejects({ ...original, meshes: [mesh] }, 'Invalid .margo primitives');
  for (const primitive of [
    null,
    false,
    0,
    '',
    { ...original.meshes[0].primitives[0], attributes: {} },
    { ...original.meshes[0].primitives[0], targets: [] },
    { ...original.meshes[0].primitives[0], extensions: {} },
  ])
    rejects({ ...original, meshes: [{ primitives: [primitive] }] }, 'Unsupported .margo primitive');
  for (const key of ['vertices', 'indices'])
    for (const value of [undefined, null, false, '1', -1, 0, 1.5, 4096]) {
      const primitive = { ...original.meshes[0].primitives[0], [key]: value };
      rejects({ ...original, meshes: [{ primitives: [primitive] }] }, 'Invalid .margo section reference');
    }
  for (const primitive of [{}, [], true, 1, 'primitive'])
    rejects({ ...original, meshes: [{ primitives: [primitive] }] }, 'Invalid .margo section reference');
});

test('manifest subset retains embedded-image and image-section validation', () => {
  for (const image of [
    null,
    false,
    1,
    'image',
    {},
    { ...original.images[0], mimeType: 'image/jpeg' },
    { ...original.images[0], uri: null },
    { ...original.images[0], uri: 'texture.png' },
  ])
    rejects({ ...original, images: [image] }, '.margo images must be embedded PNG');
  for (const section of [undefined, null, false, '3', -1, 0, 1.5, 4096, original.meshes[0].primitives[0].vertices])
    rejects({ ...original, images: [{ ...original.images[0], section }] }, 'Invalid .margo section reference');
});

test('unchecked scene fields remain available to the prepared glTF validator', () => {
  const document = structuredClone(original);
  document.materials[0].extras = { application: { flag: true } };
  document.nodes[0].extras = { application: 'node' };
  document.meshes[0].primitives[0].attributes = null;
  document.meshes[0].primitives[0].targets = false;
  document.meshes[0].primitives[0].extensions = 0;
  const decoded = decodeMargo(manifest(document));
  assert.deepEqual(decoded.document, document);
  assert.deepEqual([...decoded.geometry[0][0].indices], [0, 1, 2]);
});
