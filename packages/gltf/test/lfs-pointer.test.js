import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGLTF, parseGLTF } from '../dist/index.js';
import { loadAuto } from '../dist/auto.js';
import { headlessEngine } from './helpers.js';

// A repository cloned without Git LFS serves pointer files in place of its assets. Before this check a .gltf pointer
// failed as "Invalid glTF JSON: Unexpected token 'v'" and a .bin pointer as a buffer too short for its byteLength.
const text = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 12345\n';
const pointer = new TextEncoder().encode(text);
const lfsError = (name) => (error) => {
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'failed');
  assert.ok(error.message.startsWith(`${name} is a Git LFS pointer file`), error.message);
  assert.match(error.message, /git lfs pull/);
  assert.ok(error.message.endsWith('; see https://margoengine.com/errors#git-lfs'), error.message);
  return true;
};
// Only fetch is stubbed: each test serves its files from a map and restores the global afterwards.
async function served(files, run) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const body = files[String(input instanceof Request ? input.url : input)];
    return body ? new Response(body, { status: 200 }) : new Response('missing', { status: 404 });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = saved;
  }
}

test('a .gltf or .glb URL that returns a Git LFS pointer throws a coded error naming git lfs pull', async () => {
  for (const url of ['https://fixture.invalid/model.gltf', 'https://fixture.invalid/model.glb']) {
    await served({ [url]: pointer }, () => assert.rejects(loadGLTF(null, url), lfsError(url)));
    await served({ [url]: pointer }, () => assert.rejects(loadAuto(null, url), lfsError(url)));
  }
});

test('an external .bin buffer that is a Git LFS pointer throws the coded error, not a short buffer', async () => {
  const root = 'https://fixture.invalid/model.gltf',
    bin = 'https://fixture.invalid/model.bin';
  const doc = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'model.bin', byteLength: 36 }] });
  await served({ [root]: doc, [bin]: pointer }, () => assert.rejects(loadGLTF(null, root), lfsError(bin)));
});

test('pointer bytes or text passed to parseGLTF throw the coded error', () => {
  assert.throws(() => parseGLTF(null, pointer), lfsError('The glTF input'));
  assert.throws(() => parseGLTF(null, text), lfsError('The glTF input'));
});

test('a glTF whose text mentions git-lfs elsewhere is not mistaken for a pointer', async () => {
  const { engine } = await headlessEngine();
  const doc = JSON.stringify({ asset: { version: '2.0', generator: 'version https://git-lfs' } });
  // It parses and reaches the mesh check, which this mesh-less file fails for its own reason.
  assert.throws(() => parseGLTF(engine, doc), { code: 'failed', message: /^glTF contains no renderable meshes/ });
});
