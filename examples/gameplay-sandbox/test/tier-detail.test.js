// 3578319f3: the island chose shadow resolution and grass count by sceneSamples() === 1, which is also true on the desktop
// light tier where every desktop starts, so first-visit desktops got the phone's settings.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('island detail follows the quality tier by name, not the sample count', async () => {
  const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8'),
    main = await read('main.ts'),
    landscape = await read('landscape-details.ts');
  assert.match(main, /resolution: tier === 'phone' \? 512 : 1024/);
  assert.match(landscape, /count: tier === 'phone' \? 25_000 : tier === 'light' \? 60_000 : 110_000/);
  assert.doesNotMatch(main + landscape, /sceneSamples\(\)\s*===\s*1/);
});
