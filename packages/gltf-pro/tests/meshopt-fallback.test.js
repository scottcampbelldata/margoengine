import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GLTFAsset, loadGLTF } from '../dist/index.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

const original = await readFile(new URL('fixtures/Triangle.meshopt.gltf', import.meta.url), 'utf8');
const packed = new Uint8Array(await readFile(new URL('fixtures/Triangle.meshopt.bin', import.meta.url)));
const names = ['EXT_meshopt_compression', 'KHR_meshopt_compression'];
const document = (name) => JSON.parse(original.replaceAll(names[0], name));

for (const name of names) {
  test(`${name} explicit and implicit placeholders decode identical bytes and cache each view`, () => {
    const expected = new GLTFAsset(document(names[0]), [packed]);
    for (const explicit of [true, false]) {
      const doc = document(name);
      if (!explicit) delete doc.buffers[1].extensions;
      const asset = new GLTFAsset(doc, [packed]);
      for (let i = 0; i < doc.bufferViews.length; i++) {
        assert.deepEqual(asset.view(i), expected.view(i));
        assert.equal(asset.view(i), asset.view(i));
      }
      for (let i = 0; i < doc.accessors.length; i++) assert.deepEqual(asset.accessor(i), expected.accessor(i));
    }
  });

  test(`${name} skips a marked external fallback rather than fetching discarded bytes`, () =>
    headlessModels(async () => {
      const doc = document(name), requests = [];
      doc.buffers[1].uri = 'fallback.bin';
      const engine = await headless();
      try {
        const model = await loadGLTF(engine, 'https://example.test/triangle.gltf', {
          fetch: async (url) => {
            requests.push(String(url));
            if (String(url).endsWith('triangle.gltf')) return new Response(JSON.stringify(doc));
            assert.ok(String(url).endsWith('Triangle.meshopt.bin'), 'only compressed storage is fetched');
            return new Response(packed);
          },
        });
        assert.equal(requests.length, 2);
        assert.deepEqual(model.primitives[0].indices, new Uint32Array([0, 1, 2]));
        model.dispose();
      } finally {
        engine.dispose();
      }
    }));

  test(`${name} rejects hostile fallback markers, references and decoded bounds`, () => {
    const rejects = (mutate, pattern) => {
      const doc = document(name);
      mutate(doc);
      assert.throws(() => new GLTFAsset(doc, [packed]).view(0), pattern);
    };
    rejects((doc) => { doc.buffers[1].extensions[name].fallback = 'true'; }, /Invalid glTF meshopt fallback/);
    rejects((doc) => { delete doc.bufferViews[0].extensions; }, /fallback references/);
    rejects((doc) => { doc.bufferViews[0].extensions[name].buffer = 1; }, /fallback references/);
    rejects((doc) => { doc.buffers[1].byteLength = 35; }, /bufferView bounds/);
    rejects((doc) => { doc.bufferViews[0].extensions[name].byteLength = packed.length + 1; }, /source bounds/);
    rejects((doc) => { delete doc.buffers[1].extensions; delete doc.extensionsRequired; }, /Truncated glTF buffer/);
    rejects((doc) => { doc.buffers[1].extensions[names.find((n) => n !== name)] = { fallback: true }; }, /meshopt extensions/);
    rejects((doc) => { doc.bufferViews[0].extensions[names.find((n) => n !== name)] = { ...doc.bufferViews[0].extensions[name] }; }, /meshopt extensions/);
    rejects((doc) => {
      const other = names.find((n) => n !== name);
      doc.bufferViews[0].extensions[other] = doc.bufferViews[0].extensions[name];
      delete doc.bufferViews[0].extensions[name];
    }, /fallback references/);
  });
}
