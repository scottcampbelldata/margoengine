import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareGLTF } from '../dist/prepare.js';

// A repository cloned without Git LFS serves pointer files in place of its assets. Before this check a .gltf pointer
// failed as "Invalid glTF JSON: Unexpected token 'v'" and a .bin pointer as "Truncated glTF buffer".
const pointer = new TextEncoder().encode(
  'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n',
);
const lfsError = (url) => (error) =>
  error.name === 'MargoError' &&
  error.code === 'failed' &&
  error.message.startsWith(`${url} is a Git LFS pointer file`) &&
  /git lfs pull/.test(error.message) &&
  error.message.endsWith('; see https://margoengine.com/errors#git-lfs');
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

test('a .gltf URL that returns a Git LFS pointer throws a coded error naming git lfs pull', async () => {
  const url = 'https://fixture.invalid/model.gltf';
  await served({ [url]: pointer }, () => assert.rejects(prepareGLTF(url), lfsError(url)));
});

test('a .glb URL that returns a Git LFS pointer throws the same coded error', async () => {
  const url = 'https://fixture.invalid/model.glb';
  await served({ [url]: pointer }, () => assert.rejects(prepareGLTF(url), lfsError(url)));
});

test('an external .bin buffer that is a Git LFS pointer throws the coded error, not a truncation', async () => {
  const url = 'https://fixture.invalid/model.gltf',
    bin = 'https://fixture.invalid/model.bin',
    doc = { asset: { version: '2.0' }, buffers: [{ uri: 'model.bin', byteLength: 12345 }] };
  await served({ [url]: JSON.stringify(doc), [bin]: pointer }, () => assert.rejects(prepareGLTF(url), lfsError(bin)));
});

test('pointer bytes passed directly are refused the same way', async () => {
  await assert.rejects(prepareGLTF(undefined, pointer), lfsError('The glTF input'));
});

test('a real glTF whose text merely mentions git-lfs still loads', async () => {
  const url = 'https://fixture.invalid/ok.gltf',
    doc = { asset: { version: '2.0', generator: 'version https://git-lfs' } };
  const prepared = await served({ [url]: JSON.stringify(doc) }, () => prepareGLTF(url));
  assert.equal(prepared.doc.asset.generator, 'version https://git-lfs');
});
