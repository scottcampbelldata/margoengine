import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGLTF, parseGLTF } from '../dist/index.js';
import { headlessEngine } from './helpers.js';

// glTF 2.0 section 4.4.3.3: the BIN chunk may be up to 3 bytes longer than buffer 0's byteLength, for 4-byte padding.
// The Khronos validator flags anything longer; before this check the loader read the declared bytes and ignored the rest.
const glb = (json, bin) => {
  const text = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = (text.length + 3) & ~3,
    total = 20 + jsonLength + 8 + bin.length,
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  view.setUint32(20 + jsonLength, bin.length, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
};
// One triangle (36 bytes of positions) in a 40-byte BIN chunk; buffer 0 declares `byteLength`.
const file = (byteLength) => {
  const bin = new Uint8Array(40);
  new Float32Array(bin.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return glb(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    },
    bin,
  );
};
const padding = (error) => {
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'failed');
  assert.match(error.message, /BIN chunk holds 40 bytes, more than buffer 0's byteLength 36 plus 3 padding bytes/);
  assert.ok(error.message.endsWith('; see https://margoengine.com/errors#failed'), error.message);
  return true;
};

test('GLB: a BIN chunk up to 3 bytes past buffer 0 loads (padding)', async () => {
  const { engine } = await headlessEngine();
  for (const byteLength of [37, 38, 39, 40]) assert.ok(parseGLTF(engine, file(byteLength)));
});

test('GLB: a BIN chunk 4 or more bytes past buffer 0 throws a coded error, from bytes and from a URL', async () => {
  const { engine } = await headlessEngine(),
    url = 'https://fixture.invalid/padding.glb',
    saved = globalThis.fetch;
  assert.throws(() => parseGLTF(engine, file(36)), padding);
  globalThis.fetch = async () => new Response(file(36), { status: 200 });
  try {
    await assert.rejects(loadGLTF(engine, url), padding);
  } finally {
    globalThis.fetch = saved;
  }
});
