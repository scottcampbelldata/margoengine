import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createHttpTransport, serveHttp } from '../dist/http.js';
import { createMcpServer, createTools } from '../dist/index.js';
import { createDocResources, createStarterPrompts } from '../dist/resources.js';
import { corpus } from './support.js';

const ACCEPT = 'application/json, text/event-stream';
const signal = () => AbortSignal.timeout(5000);
const factory = () =>
  createMcpServer({
    tools: createTools({ corpus }),
    resources: createDocResources(corpus),
    prompts: createStarterPrompts(),
  });

test('HTTP disconnection does not cancel tools; explicit notification cancels the detached request', {
  timeout: 15000,
}, async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const listener = await serveHttp({
    createServer: () =>
      createMcpServer({
        tools: [
          {
            name: 'wait',
            title: 'Wait',
            description: 'fixture',
            inputSchema: { type: 'object', properties: {} },
            run: (_, { signal }) =>
              new Promise((resolve) => {
                started();
                signal.addEventListener(
                  'abort',
                  () => {
                    cancelled = true;
                    resolve({ content: [] });
                  },
                  { once: true },
                );
              }),
          },
        ],
      }),
  });
  try {
    const session = await initialize(listener),
      controller = new AbortController();
    const first = fetch(listener.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${listener.token}`,
        Accept: ACCEPT,
        'Content-Type': 'application/json',
        'Mcp-Session-Id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'wait' } }),
    });
    const rejected = assert.rejects(first);
    await ready;
    controller.abort();
    await rejected;
    assert.equal(cancelled, false);
    assert.equal(
      (await post(listener, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 } }, session))
        .status,
      202,
    );
    assert.equal(cancelled, true);
  } finally {
    await listener.close();
  }
});

test('late factories are disposed after shutdown and response limits preserve protocol errors', {
  timeout: 15000,
}, async () => {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let disposed = false;
  const server = factory(),
    original = server.dispose;
  server.dispose = () => {
    disposed = true;
    original();
  };
  const listener = await serveHttp({
    createServer: () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  });
  const request = post(listener, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  const rejected = assert.rejects(request);
  await ready;
  await listener.close();
  await rejected;
  release(server);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, true);
  const bounded = await serveHttp({
    maxResponseBytes: 1024,
    createServer: () =>
      createMcpServer({
        tools: [
          {
            name: 'large',
            title: 'Large',
            description: 'fixture',
            inputSchema: { type: 'object', properties: {} },
            run: () => ({ content: [{ type: 'text', text: 'x'.repeat(2048) }] }),
          },
        ],
      }),
  });
  try {
    const session = await initialize(bounded);
    const response = await post(
      bounded,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'large' } },
      session,
    );
    assert.equal(response.status, 500);
    assert.match((await response.json()).error.message, /maxResponseBytes/);
  } finally {
    await bounded.close();
  }
});
async function post(listener, message, session, headers = {}) {
  return fetch(listener.url, {
    method: 'POST',
    signal: signal(),
    headers: {
      Authorization: `Bearer ${listener.token}`,
      Accept: ACCEPT,
      'Content-Type': 'application/json',
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...headers,
    },
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
}
async function initialize(listener, headers) {
  const response = await post(
    listener,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    },
    undefined,
    headers,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const id = response.headers.get('mcp-session-id');
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(
    (await post(listener, { jsonrpc: '2.0', method: 'notifications/initialized' }, id, headers)).status,
    202,
  );
  return id;
}

test('Streamable HTTP serves the same docs tools, resources, prompts and native image content', {
  timeout: 15000,
}, async () => {
  const listener = await serveHttp({
    createServer: () =>
      createMcpServer({
        tools: [
          ...createTools({ corpus }),
          {
            name: 'image',
            title: 'Image',
            description: 'fixture',
            inputSchema: { type: 'object', properties: {} },
            run: () => ({ content: [{ type: 'image', data: 'AAECAw==', mimeType: 'image/png' }] }),
          },
        ],
        resources: createDocResources(corpus),
        prompts: createStarterPrompts(),
      }),
  });
  try {
    const session = await initialize(listener);
    for (const [method, params] of [
      ['tools/list', {}],
      ['tools/call', { name: 'search_docs', arguments: { query: 'gizmo' } }],
      ['resources/list', {}],
      ['resources/read', { uri: 'margo://packages/alpha/readme' }],
      ['prompts/list', {}],
      ['prompts/get', { name: 'start_scene', arguments: { idea: 'a box' } }],
    ]) {
      const response = await post(listener, { jsonrpc: '2.0', id: 2, method, params }, session);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.error, undefined, JSON.stringify(body));
      assert.ok(body.result);
    }
    const response = await post(
      listener,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'image' } },
      session,
    );
    assert.deepEqual((await response.json()).result.content[0], {
      type: 'image',
      data: 'AAECAw==',
      mimeType: 'image/png',
    });
    assert.equal(
      (
        await fetch(listener.url, {
          method: 'GET',
          signal: signal(),
          headers: { Authorization: `Bearer ${listener.token}`, Accept: 'text/event-stream' },
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await fetch(listener.url, {
          method: 'DELETE',
          signal: signal(),
          headers: { Authorization: `Bearer ${listener.token}`, 'Mcp-Session-Id': session },
        })
      ).status,
      200,
    );
    assert.equal((await post(listener, { jsonrpc: '2.0', id: 4, method: 'ping' }, session)).status, 404);
  } finally {
    await listener.close();
  }
});

test('HTTP validates authentication, Host, Origin, media types, protocol, body and single-message framing', {
  timeout: 15000,
}, async () => {
  const listener = await serveHttp({ createServer: factory, allowedOrigins: ['http://app.test'], maxBodyBytes: 1024 });
  try {
    const request = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await post(listener, request, undefined, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(listener, request, undefined, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await post(listener, request, undefined, { Origin: '' })).status, 403);
    const badHost = await new Promise((resolve, reject) => {
      const req = httpRequest(
        listener.url,
        { method: 'POST', headers: { Host: 'evil.test', Authorization: `Bearer ${listener.token}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new TypeError('Host fixture deadline')));
      req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await post(listener, request, undefined, { Accept: 'application/json' })).status, 406);
    assert.equal(
      (await post(listener, request, undefined, { Accept: 'application/json, text/event-stream;q=0' })).status,
      406,
    );
    assert.equal((await post(listener, request, undefined, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(listener, request, undefined, { 'Mcp-Protocol-Version': 'invalid' })).status, 400);
    assert.equal((await post(listener, '[')).status, 400);
    assert.equal((await post(listener, [request])).status, 400);
    assert.equal((await post(listener, request)).status, 400);
    assert.equal((await post(listener, 'x'.repeat(1025))).status, 413);
    const preflight = await fetch(listener.url, {
      method: 'OPTIONS',
      signal: signal(),
      headers: { Origin: 'http://app.test' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://app.test');
    const session = await initialize(listener, { Origin: 'http://app.test' });
    assert.equal((await post(listener, request, session, { 'Mcp-Protocol-Version': '2025-03-26' })).status, 400);
    assert.equal((await post(listener, { jsonrpc: '2.0', id: 9, result: {} }, session)).status, 202);
    assert.equal((await post(listener, { jsonrpc: '2.0', id: 9, result: {}, error: {} }, session)).status, 400);
    assert.equal((await post(listener, { jsonrpc: '2.0', id: 9, method: 7, result: {} }, session)).status, 400);
    assert.equal((await post(listener, { jsonrpc: '2.0', id: 9, error: 42 }, session)).status, 400);
  } finally {
    await listener.close();
  }
  await assert.rejects(serveHttp({ host: '0.0.0.0', createServer: factory }), /authorize/);
  assert.throws(
    () => createHttpTransport({ createServer: factory, allowedHosts: [], authorize: () => false }),
    /allowedHosts/,
  );
});

test('sessions isolate identical request ids, reject duplicate ids and cancel only their own work', {
  timeout: 15000,
}, async () => {
  const started = [];
  const listener = await serveHttp({
    createServer: () =>
      createMcpServer({
        tools: [
          {
            name: 'wait',
            title: 'Wait',
            description: 'fixture',
            inputSchema: { type: 'object', properties: {} },
            run: (_, { signal }) =>
              new Promise((resolve) => {
                started.push(resolve);
                signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }] }), {
                  once: true,
                });
              }),
          },
        ],
      }),
  });
  try {
    const a = await initialize(listener),
      b = await initialize(listener);
    const request = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait' } };
    // One at a time, so started[0] is session a's tool and started[1] session b's. Posting both at once let them start
    // in either order; under load b started first, started[1] then resolved a's settled call and b waited forever.
    const first = post(listener, request, a);
    while (started.length < 1) await new Promise((resolve) => setImmediate(resolve));
    const second = post(listener, request, b);
    while (started.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await post(listener, request, a)).status, 409);
    assert.equal(
      (await post(listener, request, a)).status,
      409,
      'a rejected duplicate must not remove the original active id',
    );
    assert.equal(
      (await post(listener, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, a)).status,
      202,
    );
    assert.equal((await (await first).json()).result.content[0].text, 'cancelled');
    started[1]({ content: [{ type: 'text', text: 'other session' }] });
    assert.equal((await (await second).json()).result.content[0].text, 'other session');
  } finally {
    await listener.close();
  }
});

test('sessions bind to principals, enforce capacity, expire idle sessions and abort requests at the deadline', {
  timeout: 15000,
}, async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const listener = await serveHttp({
    createServer: factory,
    authorize: (req) => req.headers.authorization ?? false,
    maxSessions: 1,
    sessionTimeoutMs: 100000,
  });
  try {
    const session = await initialize(listener, { Authorization: 'first' });
    const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
    assert.equal((await post(listener, ping, session, { Authorization: 'other' })).status, 404);
    const response = await post(listener, { jsonrpc: '2.0', id: 3, method: 'initialize' }, undefined, {
      Authorization: 'first',
    });
    assert.equal(response.status, 503);
    now += 100001;
    assert.equal((await post(listener, ping, session, { Authorization: 'first' })).status, 404);
  } finally {
    await listener.close();
  }
  let cancelled = false;
  const timed = await serveHttp({
    timeoutMs: 1000,
    createServer: () =>
      createMcpServer({
        tools: [
          {
            name: 'wait',
            title: 'Wait',
            description: 'fixture',
            inputSchema: { type: 'object', properties: {} },
            run: (_, { signal }) =>
              new Promise((resolve) =>
                signal.addEventListener(
                  'abort',
                  () => {
                    cancelled = true;
                    resolve({ content: [] });
                  },
                  { once: true },
                ),
              ),
          },
        ],
      }),
  });
  try {
    const session = await initialize(timed);
    assert.equal(
      (await post(timed, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wait' } }, session)).status,
      504,
    );
    assert.equal(cancelled, true);
  } finally {
    await timed.close();
  }
});

test('UTF-8 split across HTTP chunks is preserved and malformed UTF-8 is rejected', { timeout: 15000 }, async () => {
  const listener = await serveHttp({
    createServer: () =>
      createMcpServer({
        tools: [
          {
            name: 'echo',
            title: 'Echo',
            description: 'fixture',
            inputSchema: { type: 'object', properties: {} },
            run: (args) => ({ content: [{ type: 'text', text: args.value }] }),
          },
        ],
      }),
  });
  try {
    const session = await initialize(listener);
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: '海🌳' } },
      }),
    );
    const split = body.indexOf(Buffer.from('海')) + 1;
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest(
        listener.url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${listener.token}`,
            Accept: ACCEPT,
            'Content-Type': 'application/json',
            'Mcp-Session-Id': session,
          },
        },
        async (res) => {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new TypeError('HTTP fixture deadline')));
      req.write(body.subarray(0, split));
      setImmediate(() => req.end(body.subarray(split)));
    });
    assert.equal(result.result.content[0].text, '海🌳');
    const response = await fetch(listener.url, {
      method: 'POST',
      signal: signal(),
      headers: {
        Authorization: `Bearer ${listener.token}`,
        Accept: ACCEPT,
        'Content-Type': 'application/json',
        'Mcp-Session-Id': session,
      },
      body: new Uint8Array([0xff]),
    });
    assert.equal(response.status, 400);
  } finally {
    await listener.close();
  }
});
