import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GPU scripts serving repository-absolute decoder fixtures start Vite at the repository root', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['test:gpu:jpeg', 'test:browser:hdr6', 'test:browser:avif']) {
    assert.match(
      manifest.scripts[name],
      /^cd \.\.\/\.\. && node packages\/decoders\//,
      `${name}: repository-relative worker URLs need the repository server root`,
    );
    const script = manifest.scripts[name].split(' && node ')[1];
    await readFile(new URL(`../../../${script}`, import.meta.url));
  }
});
