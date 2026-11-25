// KB-LOADERS-FETCHGUARD1: fetchBytes capped the size but had no scheme or host guard, no per-redirect check, no media
// type accept list, did not report the final URL or type, and rewrapped a custom fetch's own refusal without it.
// fetchResource and the guard options close each; hosts follow RFC 1918, 3927, 4193, 4291, 6598 and 6761.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LoaderError, fetchBytes, fetchResource, isPrivateHost } from '../dist/index.js';

const rejects = (promise, code, message) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof LoaderError, String(error));
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
// A stand-in fetch over a table of URL -> [status, headers, body]; it records the RequestInit it got.
function table(routes) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push([String(url), init?.redirect]);
    const [status, headers, body] = routes[String(url)] ?? [404, {}, ''];
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  };
  return { fetch, seen };
}

test('isPrivateHost: loopback, private, shared, link-local and their IPv6 and mapped forms', () => {
  const host = (link) => new URL(link).hostname;
  for (const link of [
    'https://localhost/',
    'https://a.localhost/',
    'https://127.0.0.1/',
    'https://127.1/',
    'https://0x7f000001/',
    'https://10.2.3.4/',
    'https://172.31.0.1/',
    'https://192.168.1.1/',
    'https://100.64.0.1/',
    'https://169.254.169.254/',
    'https://0.0.0.0/',
    'https://[::1]/',
    'https://[::]/',
    'https://[fd00::1]/',
    'https://[fe80::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:10.0.0.1]/',
  ])
    assert.equal(isPrivateHost(host(link)), true, link);
  for (const link of [
    'https://example.com/',
    'https://8.8.8.8/',
    'https://172.32.0.1/',
    'https://100.128.0.1/',
    'https://[2001:db8::1]/',
    'https://[::ffff:8.8.8.8]/',
  ])
    assert.equal(isPrivateHost(host(link)), false, link);
});

test('protocols and publicOnly refuse the link and every redirect, followed by hand', async () => {
  const { fetch, seen } = table({
    'https://a.test/start': [302, { location: 'https://b.test/next' }],
    'https://b.test/next': [301, { location: 'http://c.test/plain' }],
    'https://a.test/inside': [302, { location: 'https://127.0.0.1/admin' }],
    'https://a.test/ok': [307, { location: '/page' }],
    'https://a.test/page': [200, { 'content-type': 'text/html; charset=utf-8' }, '<p>hi</p>'],
  });
  const guard = { fetch, protocols: ['https:'], publicOnly: true };
  await rejects(fetchBytes('http://a.test/', guard), 'url', /uses http:; allowed: https:/);
  await rejects(fetchBytes('https://a.test/start', guard), 'url', /a redirect to http:\/\/c\.test\/plain uses http:/);
  await rejects(
    fetchBytes('https://a.test/inside', guard),
    'url',
    /redirect to https:\/\/127\.0\.0\.1\/admin is this computer/,
  );
  await rejects(fetchBytes('https://user:pw@a.test/ok', guard), 'url', /user name or password/);
  assert.ok(
    seen.every(([, redirect]) => redirect === 'manual'),
    'guarded fetches follow redirects by hand',
  );
  const got = await fetchResource('https://a.test/ok', guard);
  assert.deepEqual(
    { ...got, bytes: new TextDecoder().decode(got.bytes) },
    { bytes: '<p>hi</p>', url: 'https://a.test/page', type: 'text/html; charset=utf-8', status: 200, redirects: 1 },
  );
});

test('maxRedirects, allowHost and accept', async () => {
  const { fetch } = table({
    'https://a.test/1': [302, { location: 'https://a.test/2' }],
    'https://a.test/2': [302, { location: 'https://a.test/3' }],
    'https://a.test/3': [200, { 'content-type': 'application/pdf' }, '%PDF'],
    'https://a.test/none': [302, {}],
  });
  await rejects(fetchBytes('https://a.test/1', { fetch, maxRedirects: 1 }), 'limit', /more than 1 redirects/);
  await rejects(fetchBytes('https://a.test/none', { fetch, maxRedirects: 3 }), 'fetch', /302 with no Location/);
  await rejects(
    fetchBytes('https://a.test/1', { fetch, allowHost: (h) => h !== 'a.test' }),
    'url',
    /host a\.test refused by allowHost/,
  );
  await rejects(
    fetchBytes('https://a.test/1', { fetch, maxRedirects: 5, accept: ['text/html', 'text/*'] }),
    'unsupported',
    /is application\/pdf; accepted: text\/html, text\/\*/,
  );
  const pdf = await fetchResource('https://a.test/1', { fetch, maxRedirects: 5, accept: ['application/*'] });
  assert.equal(pdf.redirects, 2);
});

test("a custom fetch's own refusal is kept as the cause", async () => {
  const mine = Object.assign(new Error('blocked by policy'), { status: 451 });
  await assert.rejects(
    fetchBytes('https://a.test/', {
      fetch: async () => {
        throw mine;
      },
    }),
    (error) => error instanceof LoaderError && error.code === 'fetch' && error.cause === mine,
  );
});

test('a real server: manual redirects in Node, the final URL and type, accept refuses before the body', async () => {
  let bodies = 0;
  const server = createServer((request, response) => {
    if (request.url === '/go') response.writeHead(303, { location: '/doc' }).end();
    else if (request.url === '/doc') {
      bodies++;
      response.writeHead(200, { 'content-type': 'text/plain' }).end('plain words');
    } else response.writeHead(404).end();
  });
  server.keepAliveTimeout = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const got = await fetchResource(`${base}/go`, { protocols: ['http:'], accept: ['text/plain'] });
    assert.equal(new TextDecoder().decode(got.bytes), 'plain words');
    assert.equal(got.url, `${base}/doc`);
    assert.equal(got.type, 'text/plain');
    assert.equal(got.redirects, 1);
    await rejects(fetchBytes(`${base}/go`, { publicOnly: true }), 'url', /this computer or a private network/);
    const plain = await fetchResource(`${base}/go`);
    assert.equal(plain.url, `${base}/doc`, 'unguarded: the fetch follows and the final URL is still reported');
    assert.equal(bodies, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
