import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('offline GPU assets retain recorded CC0 provenance and exact standard-file bytes', {
  timeout: 10000,
}, async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/index.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    assert.equal(fixture.asset.license, 'CC0-1.0');
    assert.ok(fixture.asset.source.startsWith('https://'));
    assert.ok(fixture.download.url.startsWith('https://'));
    for (const file of fixture.files) {
      const bytes = await readFile(new URL(`./fixtures/${fixture.directory}/${file.path}`, import.meta.url));
      assert.equal(bytes.length, file.bytes, file.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    }
    if (fixture.entry.endsWith('.gltf')) {
      const data = JSON.parse(
        await readFile(new URL(`./fixtures/${fixture.directory}/${fixture.entry}`, import.meta.url), 'utf8'),
      );
      for (const resource of [...(data.buffers ?? []), ...(data.images ?? [])])
        if (resource.uri && !resource.uri.startsWith('data:'))
          assert.ok(
            fixture.files.some((f) => f.path === resource.uri),
            resource.uri,
          );
    }
  }
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [name, file] of [
    ['test:browser:live', 'live-browser.mjs'],
    ['test:browser:live:compat', 'live-browser.mjs --compat'],
    ['test:browser:assets', 'assets-browser.mjs'],
  ])
    assert.ok(manifest.scripts[name].includes(file), 'CI discovers the GPU regression leaf');
});
