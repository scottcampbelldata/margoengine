// Real proof of @margoengine/save/remote: a real Chromium page on one origin calls a real node:http server on another,
// through real CORS, so the preflight of PUT with If-Match and the ETag the page must be able to read are the browser's
// own. Two clients in the page then meet a conflict.
// `npm run test:gpu --workspace @margoengine/save`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { openBrowser } from '../../../../scripts/browser.js';
import { memoryStorage } from '../../dist/index.js';
import { remoteHandler } from '../../dist/remote.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page } = browser,
  errors = [],
  seen = [],
  held = memoryStorage(),
  handle = remoteHandler(held, { base: '/saves', origin: new URL(page.url()).origin });
page.on('pageerror', (error) => errors.push(error.message));
const server = createServer(async (request, response) => {
  seen.push(request.method);
  const hasBody = request.method !== 'GET' && request.method !== 'OPTIONS',
    answer = await handle(
      new Request(`http://${request.headers.host}${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
      }),
    );
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/saves`;
  const result = await page.evaluate(async (url) => {
    const { saveGame, loadGame } = await import('/packages/save/dist/index.js'),
      { remoteStorage } = await import('/packages/save/dist/remote.js');
    const game = (title) => ({ format: 'margo-save', version: 1, meta: { title }, entities: [] }),
      one = remoteStorage({ url }),
      two = remoteStorage({ url }),
      merged = remoteStorage({ url, conflict: ({ remote }) => remote });
    await saveGame(one, 'slot 1', game('first'));
    await two.read('slot 1');
    await saveGame(one, 'slot 1', game('second'));
    const conflict = await saveGame(two, 'slot 1', game('third')).then(
      () => 'saved',
      (error) => error.code,
    );
    await merged.write('slot 1', new Uint8Array([1]));
    return { conflict, title: (await loadGame(two, 'slot 1')).meta.title, keys: await one.keys(), gone: await one.delete('slot 1') };
  }, url);
  console.log(JSON.stringify({ ...result, requests: seen.length, preflights: seen.filter((method) => method === 'OPTIONS').length }));
  assert.deepEqual(errors, []);
  assert.deepEqual(result, { conflict: 'state', title: 'second', keys: ['slot 1'], gone: true });
  assert.ok(seen.includes('OPTIONS'), 'the browser sent a real preflight');
  assert.deepEqual(await held.keys(), []);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await browser.close();
}
