import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGLTFAsync } from '../dist/pbr.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

// KB-GLTFA B7: a file in memory has no location, so its external URIs were fetched from the page's directory.
function external(uri) {
  const { doc, buffers } = materialQuad();
  const files = new Map();
  doc.buffers.forEach((def, index) => {
    def.uri = `${uri}${index}.bin`;
    const buffer = buffers[index];
    files.set(def.uri, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  });
  return { doc, files };
}
const withEngine = (run) =>
  headlessModels(async () => {
    const engine = await headless();
    try {
      return await run(engine);
    } finally {
      engine.dispose();
    }
  });

test('an external URI of a file in memory is refused with a coded error, never fetched from the page', () =>
  withEngine(async (engine) => {
    const requests = [];
    const saved = globalThis.location;
    globalThis.location = { href: 'https://app.test/editor/' };
    try {
      const { doc } = external('secret/tex');
      await assert.rejects(
        parseGLTFAsync(engine, doc, {
          fetch: async (url) => {
            requests.push(String(url));
            throw new Error('fetched');
          },
        }),
        (error) =>
          error.code === 'state' && /needs the file location/.test(error.message) && /baseURL/.test(error.message),
      );
      assert.deepEqual(requests, []);
    } finally {
      globalThis.location = saved;
    }
  }));

test('baseURL is what an external URI of a file in memory resolves against', () =>
  withEngine(async (engine) => {
    const { doc, files } = external('mesh');
    const requests = [];
    const model = await parseGLTFAsync(engine, doc, {
      baseURL: 'https://cdn.test/models/car.gltf',
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(files.get(String(url).split('/').pop()));
      },
    });
    assert.ok(requests.length > 0);
    assert.ok(
      requests.every((url) => url.startsWith('https://cdn.test/models/mesh')),
      requests.join(),
    );
    model.dispose();
  }));
