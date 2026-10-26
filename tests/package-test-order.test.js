import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// `npm run modern:test:packages` started the packed browser together with up to eight type-check shards; its first page
// load (a cold dev server transforming every package) then missed the 30 s navigation limit on a busy machine, twice in
// a row, and failed a full check:merge. The browser now goes first and the shards start once its page has loaded.
test('the packed browser starts first and the type-check shards wait for its first page load', async () => {
  const source = (await readFile(new URL('../scripts/modern-package-tests.js', import.meta.url), 'utf8')).replaceAll(
    '\r\n',
    '\n',
  );
  const start = source.indexOf('const browserRun = reactScope ? packedBrowser() : undefined;'),
    wait = source.indexOf('if (reactScope) await loaded;'),
    shards = source.indexOf('const pipelines = ['),
    opened = source.indexOf("browser = await openBrowser({ startPath: '/tests/modern.html', aliases });");
  assert.ok(
    start > 0 && wait > start && shards > wait,
    'packedBrowser() starts, then the rest waits, then the shards are built',
  );
  assert.ok(
    opened > 0 && source.indexOf('pageLoaded();', opened) > opened,
    'the page-loaded signal fires after the page opens, even on failure',
  );
  assert.ok(source.includes('browserRun?.then(pageLoaded, pageLoaded)'), 'an early failure releases the wait');
  assert.equal(source.split('packedBrowser()').length - 1, 1, 'it is started in one place only');
});
