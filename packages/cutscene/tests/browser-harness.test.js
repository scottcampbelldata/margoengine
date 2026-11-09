import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// The real-browser checks run on a browser connected over a socket (scripts/lib/browser.mjs launchServer +
// connect), where Playwright's download.path() throws "Path is not available when connecting remotely".
test('browser checks read downloads as streams, which work on a connected browser', async () => {
  const dir = new URL('./', import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.mjs'))) {
    const code = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(code, /download\.path\(\)/, name);
  }
});
