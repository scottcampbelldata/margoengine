// remoteStorage against remoteHandler on a real node:http server, and against a scripted fetch for what a real network
// does: lost answers, 429 and 503, servers with odd ETags. The real browser run is tests/browser/remote-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { memoryStorage } from '../dist/index.js';
import { remoteHandler, remoteStorage } from '../dist/remote.js';
import { safeStorage } from '../dist/safe.js';
import { SaveSlots } from '../dist/slots.js';

const text = (bytes) => new TextDecoder().decode(bytes);
const bytes = (value) => new TextEncoder().encode(value);

/** A real HTTP server around a handler. */
async function serve(handle, t) {
  const server = createServer(async (request, response) => {
    const url = `http://${request.headers.host}${request.url}`,
      hasBody = request.method !== 'GET' && request.method !== 'HEAD',
      answer = await handle(
        new Request(url, {
          method: request.method,
          headers: request.headers,
          ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
        }),
      );
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/saves`;
}

/** Two devices on one real server. */
async function devices(t, options = {}) {
  const held = memoryStorage(),
    url = await serve(remoteHandler(held, { base: '/saves' }), t);
  return { held, url, one: remoteStorage({ url, ...options }), two: remoteStorage({ url, ...options }) };
}

/** A fetch that answers from a list of scripted Responses, or runs a function; records what it was sent. */
function scripted(...steps) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, method: init.method, headers: Object.fromEntries(new Headers(init.headers)) });
    const step = steps.shift();
    if (!step) throw new Error('no more steps');
    return typeof step === 'function' ? step(url, init) : step;
  };
  return { fetch, sent };
}
const reply = (status, body = null, headers = {}) => new Response(body, { status, headers });

test('read, write, delete and keys over real HTTP', async (t) => {
  const { one, held } = await devices(t);
  assert.equal(await one.read('slot 1/é'), null);
  await one.write('slot 1/é', bytes('first'));
  await one.write('slot 1/é', bytes('second'));
  await one.write('b', new Uint8Array([0, 255, 128]));
  assert.equal(text(await one.read('slot 1/é')), 'second');
  assert.deepEqual(await one.read('b'), new Uint8Array([0, 255, 128]));
  assert.deepEqual(await one.keys(), ['b', 'slot 1/é']);
  assert.deepEqual(await held.keys(), ['b', 'slot 1/é']);
  assert.equal(await one.delete('b'), true);
  assert.equal(await one.delete('b'), false);
  assert.equal(await one.read('b'), null);
});

test('a save from another device is a conflict, and the default changes nothing', async (t) => {
  const { one, two } = await devices(t);
  await one.write('k', bytes('base'));
  await two.read('k');
  await one.write('k', bytes('from one'));
  await assert.rejects(two.write('k', bytes('from two')), (error) => error.code === 'state' && /read it again/.test(error.message));
  assert.equal(text(await one.read('k')), 'from one');
  await two.read('k');
  await two.write('k', bytes('from two, after reading'));
  assert.equal(text(await one.read('k')), 'from two, after reading');
});

test('a device that never read a key cannot overwrite it by chance', async (t) => {
  const { one, two } = await devices(t);
  await one.write('k', bytes('there'));
  await assert.rejects(two.write('k', bytes('blind')), (error) => error.code === 'state');
  assert.equal(text(await one.read('k')), 'there');
});

test("conflict 'local' writes over, and 'remote' keeps the server's", async (t) => {
  const { url, one } = await devices(t),
    local = remoteStorage({ url, conflict: 'local' }),
    remote = remoteStorage({ url, conflict: 'remote' });
  await one.write('k', bytes('base'));
  await local.write('k', bytes('mine'));
  assert.equal(text(await one.read('k')), 'mine');
  await remote.write('k', bytes('dropped'));
  assert.equal(text(await one.read('k')), 'mine');
  assert.equal(text(await remote.read('k')), 'mine');
});

test('a function merges, and is given both sides', async (t) => {
  const { url, one } = await devices(t),
    seen = [],
    merging = remoteStorage({
      url,
      conflict: ({ key, local, remote }) => {
        seen.push([key, text(local), text(remote)]);
        return bytes(`${text(remote)}+${text(local)}`);
      },
    });
  await one.write('k', bytes('a'));
  await merging.write('k', bytes('b'));
  assert.deepEqual(seen, [['k', 'b', 'a']]);
  assert.equal(text(await one.read('k')), 'a+b');
  const keeping = remoteStorage({ url, conflict: ({ remote }) => remote });
  await keeping.write('k', bytes('c'));
  assert.equal(text(await one.read('k')), 'a+b');
  const removing = remoteStorage({ url, conflict: () => null });
  await removing.write('k', bytes('d'));
  assert.equal(await one.read('k'), null);
});

test('a save deleted on another device is a conflict too', async (t) => {
  const { url, one, two } = await devices(t);
  await one.write('k', bytes('base'));
  await two.read('k');
  await one.delete('k');
  await assert.rejects(two.write('k', bytes('x')), (error) => error.code === 'state');
  const local = remoteStorage({ url, conflict: 'local' });
  await local.write('n', bytes('1'));
  await one.read('n');
  await one.delete('n');
  await local.write('n', bytes('2'));
  assert.equal(text(await one.read('n')), '2');
});

test('a delete of a save that changed is a conflict', async (t) => {
  const { one, two } = await devices(t);
  await one.write('k', bytes('base'));
  await two.read('k');
  await one.write('k', bytes('newer'));
  await assert.rejects(two.delete('k'), (error) => error.code === 'state');
  assert.equal(text(await one.read('k')), 'newer');
});

test('a write whose answer was lost and came back 412 counts as done', async (t) => {
  const held = memoryStorage(),
    handle = remoteHandler(held, { base: '/saves' }),
    url = await serve(handle, t);
  let lose = true;
  const losing = async (target, init) => {
    const response = await fetch(target, init);
    if (init.method === 'PUT' && lose) {
      lose = false;
      throw new TypeError('connection reset');
    }
    return response;
  };
  const storage = remoteStorage({ url, fetch: losing, conflict: 'error' });
  await storage.write('k', bytes('once'));
  assert.equal(text(await held.read('k')), 'once');
  await storage.write('k', bytes('twice'));
  assert.equal(text(await held.read('k')), 'twice', 'and the tag it learned is good');
});

test('429 and 5xx are tried again as Retry-After says, then fail with the way out', async () => {
  const { fetch, sent } = scripted(
    reply(429, null, { 'retry-after': '0' }),
    reply(503, null, { 'retry-after': new Date(Date.now() - 1000).toUTCString() }),
    reply(200, 'body', { etag: '"a"' }),
  );
  assert.equal(text(await remoteStorage({ url: 'http://x/saves/', fetch }).read('k')), 'body');
  assert.equal(sent.length, 3);
  assert.equal(sent[0].url, 'http://x/saves/k');
  const failing = scripted(reply(500), reply(500));
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: failing.fetch, retries: 1 }).read('k'), (error) => error.code === 'failed' && /try again later/.test(error.message));
  assert.equal(failing.sent.length, 2);
  const none = scripted(reply(503));
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: none.fetch, retries: 0 }).read('k'), /503/);
  const long = scripted(reply(429, null, { 'retry-after': '3600' }));
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: long.fetch }).read('k'), /429/);
  assert.equal(long.sent.length, 1, 'an hour is not waited out');
});

test('a timeout counts as a failed attempt and names itself', async () => {
  const hanging = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: hanging, timeout: 5, retries: 1 }).read('k'), (error) => error.code === 'timeout' && /raise timeout/.test(error.message));
});

test('the signal stops a call at once, in a request and in a wait', async () => {
  const stop = new AbortController(),
    { fetch, sent } = scripted(reply(429, null, { 'retry-after': '30' }));
  const reading = remoteStorage({ url: 'http://x', fetch }).read('k', { signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort(new Error('stop'));
  await assert.rejects(reading, /stop/);
  assert.equal(sent.length, 1);
  const hanging = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: hanging }).read('k', { signal: AbortSignal.abort(new Error('before')) }), /before/);
  const late = new AbortController(),
    pending = remoteStorage({ url: 'http://x', fetch: hanging }).read('k', { signal: late.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  late.abort(new Error('during'));
  await assert.rejects(pending, /during/);
});

test('a weak ETag is refused with the reason, since If-Match could never match it', async () => {
  const { fetch } = scripted(reply(200, 'x', { etag: 'W/"1"' }), reply(200, 'x', { etag: 'W/"1"' })),
    storage = remoteStorage({ url: 'http://x', fetch });
  assert.equal(text(await storage.read('k')), 'x', 'reading is fine');
  await assert.rejects(storage.write('k', bytes('y')), (error) => error.code === 'unsupported' && /strong ETags/.test(error.message));
});

test('a weak ETag that has gone strong is used, as Apache gives one for a file just changed', async () => {
  const { fetch, sent } = scripted(reply(200, 'x', { etag: 'W/"1"' }), reply(200, 'x', { etag: '"1"' }), reply(204, null, { etag: '"2"' })),
    storage = remoteStorage({ url: 'http://x', fetch });
  await storage.read('k');
  await storage.write('k', bytes('y'));
  assert.equal(sent[2].headers['if-match'], '"1"');
});

test('a weak ETag over bytes that have since changed is a conflict, not a base', async () => {
  const { fetch, sent } = scripted(reply(200, 'x', { etag: 'W/"1"' }), reply(200, 'other', { etag: '"2"' }), reply(200, 'other', { etag: '"2"' })),
    storage = remoteStorage({ url: 'http://x', fetch });
  await storage.read('k');
  await assert.rejects(storage.write('k', bytes('y')), (error) => error.code === 'state');
  assert.ok(sent.every((s) => s.method === 'GET'), 'nothing was written');
});

test('a 2xx with no ETag is followed by a GET, and a server with none says so', async () => {
  const { fetch, sent } = scripted(reply(201), reply(200, 'mine', { etag: '"1"' }), reply(204, null, { etag: '"2"' })),
    storage = remoteStorage({ url: 'http://x', fetch });
  await storage.write('k', bytes('mine'));
  await storage.write('k', bytes('next'));
  assert.deepEqual(sent.map((s) => [s.method, s.headers['if-match'], s.headers['if-none-match']]), [
    ['PUT', undefined, '*'],
    ['GET', undefined, undefined],
    ['PUT', '"1"', undefined],
  ]);
  const moved = scripted(reply(201), reply(200, 'someone else', { etag: '"9"' }), reply(412), reply(200, 'someone else', { etag: '"9"' })),
    second = remoteStorage({ url: 'http://x', fetch: moved.fetch });
  await second.write('k', bytes('mine'));
  await assert.rejects(second.write('k', bytes('next')), (error) => error.code === 'state');
  assert.equal(moved.sent[2].headers['if-none-match'], '*', 'a tag of what is not ours is not a base');
  const bare = scripted(reply(200, 'x')),
    third = remoteStorage({ url: 'http://x', fetch: bare.fetch });
  await third.read('k');
  await assert.rejects(third.write('k', bytes('y')), (error) => error.code === 'unsupported' && /turn on ETags/.test(error.message));
});

test('headers are sent, a function runs for each attempt, and 401 names the option', async () => {
  let token = 0;
  const { fetch, sent } = scripted(reply(503, null, { 'retry-after': '0' }), reply(401));
  await assert.rejects(
    remoteStorage({ url: 'http://x', fetch, headers: () => ({ authorization: `Bearer ${++token}` }) }).read('k'),
    /check the headers/,
  );
  assert.deepEqual(sent.map((s) => s.headers.authorization), ['Bearer 1', 'Bearer 2']);
  const plain = scripted(reply(404));
  await remoteStorage({ url: 'http://x', fetch: plain.fetch, headers: { 'x-game': 'a' } }).read('k');
  assert.equal(plain.sent[0].headers['x-game'], 'a');
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: scripted(reply(418)).fetch }).read('k'), /418/);
});

test('a bad list says what to serve', async () => {
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: scripted(reply(200, '<html>')).fetch }).keys(), /not JSON/);
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: scripted(reply(200, '[1]')).fetch }).keys(), /array of strings/);
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: scripted(reply(403)).fetch }).keys(), /check the headers/);
});

test('a write that keeps meeting newer saves gives up', async () => {
  let n = 0;
  const moving = (url, init) => (init.method === 'PUT' ? reply(412) : reply(200, `v${++n}`, { etag: `"${n}"` }));
  await assert.rejects(remoteStorage({ url: 'http://x', fetch: moving, conflict: 'local' }).write('k', bytes('x')), /kept changing/);
});

test('arguments are checked', async () => {
  assert.throws(() => remoteStorage({}), /needs a url/);
  assert.throws(() => remoteStorage({ url: 'http://x', conflict: 'merge' }), /conflict must/);
  assert.throws(() => remoteStorage({ url: 'http://x', timeout: 0 }), RangeError);
  assert.throws(() => remoteStorage({ url: 'http://x', retries: -1 }), RangeError);
  await assert.rejects(remoteStorage({ url: 'http://x' }).read(''), /non-empty/);
  await assert.rejects(remoteStorage({ url: 'http://x' }).write('k', 'text'), /Uint8Array/);
  assert.throws(() => remoteHandler(null), /needs a storage/);
});

test('the handler speaks plain HTTP: preconditions, status codes, tags, limits', async () => {
  const handle = remoteHandler(memoryStorage(), { base: '/saves', maxBytes: 8 }),
    call = (path, init) => handle(new Request(`http://x${path}`, init));
  assert.equal((await call('/other/k')).status, 404);
  assert.equal((await call('/saves/k')).status, 404);
  const created = await call('/saves/k', { method: 'PUT', body: 'abc' }),
    tag = created.headers.get('etag');
  assert.equal(created.status, 201);
  assert.match(tag, /^"[0-9a-f]{32}"$/);
  const got = await call('/saves/k');
  assert.equal(got.headers.get('etag'), tag);
  assert.equal(got.headers.get('cache-control'), 'no-store');
  assert.equal(await got.text(), 'abc');
  assert.equal((await call('/saves/k', { method: 'PUT', body: 'x', headers: { 'if-none-match': '*' } })).status, 412);
  assert.equal((await call('/saves/k', { method: 'PUT', body: 'x', headers: { 'if-match': '"no"' } })).status, 412);
  assert.equal((await call('/saves/k', { method: 'PUT', body: 'x', headers: { 'if-match': `W/${tag}` } })).status, 412, 'If-Match compares strongly');
  assert.equal((await call('/saves/k', { method: 'PUT', body: 'x', headers: { 'if-none-match': `W/${tag}` } })).status, 412, 'If-None-Match compares weakly');
  assert.equal((await call('/saves/none', { method: 'PUT', body: 'x', headers: { 'if-match': '*' } })).status, 412);
  assert.equal((await call('/saves/k', { method: 'PUT', body: 'abd', headers: { 'if-match': `"a", ${tag}` } })).status, 204);
  assert.equal((await call('/saves/k', { method: 'PUT', body: 'way too long' })).status, 413);
  assert.equal((await call('/saves/k', { method: 'POST', body: 'x' })).status, 405);
  assert.equal((await call('/saves', { method: 'PUT', body: 'x' })).status, 405);
  assert.equal((await call('/saves/%zz')).status, 400);
  assert.deepEqual(await (await call('/saves/')).json(), ['k']);
  assert.equal((await call('/saves/k', { method: 'DELETE' })).status, 204);
  assert.equal((await call('/saves/k', { method: 'DELETE' })).status, 404);
});

test('CORS: only when asked, with ETag exposed and the conditional headers allowed', async () => {
  const open = remoteHandler(memoryStorage(), { origin: 'https://game.example' }),
    closed = remoteHandler(memoryStorage());
  const preflight = await open(new Request('http://x/k', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://game.example');
  assert.match(preflight.headers.get('access-control-allow-methods'), /PUT.*DELETE/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /if-match, if-none-match, authorization/);
  const put = await open(new Request('http://x/k', { method: 'PUT', body: 'a' }));
  assert.match(put.headers.get('access-control-expose-headers'), /ETag/);
  assert.equal((await closed(new Request('http://x/k', { method: 'OPTIONS' }))).headers.get('access-control-allow-origin'), null);
});

test('authorize runs first, and a preflight needs none', async () => {
  const handle = remoteHandler(memoryStorage(), { authorize: (request) => request.headers.get('authorization') === 'yes' });
  assert.equal((await handle(new Request('http://x/k'))).status, 403);
  assert.equal((await handle(new Request('http://x/k', { headers: { authorization: 'yes' } }))).status, 404);
  assert.equal((await handle(new Request('http://x/k', { method: 'OPTIONS' }))).status, 204);
});

test('two writers racing on one tag: exactly one wins', async (t) => {
  const { url, one } = await devices(t);
  await one.write('k', bytes('base'));
  const racers = [remoteStorage({ url }), remoteStorage({ url }), remoteStorage({ url })];
  await Promise.all(racers.map((racer) => racer.read('k')));
  const results = await Promise.allSettled(racers.map((racer, i) => racer.write('k', bytes(`racer ${i}`))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.equal(text(await one.read('k')), `racer ${winner}`);
});

test('it composes: slots over checked copies over HTTP', async (t) => {
  const { url } = await devices(t),
    slots = new SaveSlots(safeStorage(remoteStorage({ url })));
  await slots.save('slot-1', { format: 'margo-save', version: 1, meta: { title: 'cloud' }, entities: [] });
  await slots.save('slot-1', { format: 'margo-save', version: 1, meta: { title: 'cloud 2' }, entities: [] });
  const elsewhere = new SaveSlots(safeStorage(remoteStorage({ url })));
  assert.equal((await elsewhere.list())[0].title, 'cloud 2');
  assert.equal((await elsewhere.load('slot-1')).meta.title, 'cloud 2');
});
