import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveHttp } from '../dist/http.js';
import { createMcpServer, createTools } from '../dist/index.js';
import { corpus } from './support.js';

const VERSION = '2026-07-28';
const encode = (value) =>
  /^[\x21-\x7e]+$/.test(value) && !value.startsWith('=?base64?')
    ? value
    : `=?base64?${Buffer.from(value).toString('base64')}?=`;
async function post(listener, method, params = {}, headers = {}, meta = {}) {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        ...meta,
      },
    },
  };
  return fetch(listener.url, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${listener.token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': VERSION,
      'Mcp-Method': method,
      ...(['tools/call', 'prompts/get', 'resources/read'].includes(method)
        ? { 'Mcp-Name': encode(method === 'resources/read' ? params.uri : params.name) }
        : {}),
      ...headers,
    },
    body: JSON.stringify(request),
  });
}

test('current HTTP is stateless, discovers capabilities and serves unchanged tools without initialize', {
  timeout: 15000,
}, async () => {
  let factories = 0,
    disposals = 0;
  const listener = await serveHttp({
    createServer: () => {
      factories++;
      const server = createMcpServer({ tools: createTools({ corpus }) }),
        original = server.dispose;
      server.dispose = () => {
        disposals++;
        original();
      };
      return server;
    },
  });
  try {
    const discovery = await post(listener, 'server/discover');
    assert.equal(discovery.status, 200);
    assert.equal(discovery.headers.get('mcp-session-id'), null);
    const data = (await discovery.json()).result;
    assert.equal(data.resultType, 'complete');
    assert.ok(data.supportedVersions.includes(VERSION));
    assert.deepEqual(data.capabilities.tools, {});
    assert.equal(data._meta['io.modelcontextprotocol/serverInfo'].name, 'margoengine');
    const response = await post(
      listener,
      'tools/call',
      { name: 'search_docs', arguments: { query: 'gizmo' } },
      { 'Mcp-Session-Id': 'ignored-legacy-session' },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.resultType, 'complete');
    assert.equal(factories, 2);
    assert.equal(disposals, 2);
    const unknown = await post(listener, 'unknown');
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, -32601);
    const unsupported = await post(listener, 'tools/list', {}, { 'Mcp-Protocol-Version': '2030-01-01' });
    assert.equal(unsupported.status, 400);
    const error = (await unsupported.json()).error;
    assert.equal(error.code, -32022);
    assert.ok(error.data.supported.includes(VERSION));
    const deleted = await fetch(listener.url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${listener.token}`, 'Mcp-Protocol-Version': VERSION },
    });
    assert.equal(deleted.status, 405);
  } finally {
    await listener.close();
  }
});

test('current metadata headers match the body, including encoded names and nested parameter headers', {
  timeout: 15000,
}, async () => {
  const listener = await serveHttp({
    createServer: () =>
      createMcpServer({
        tools: [
          {
            name: '海',
            title: 'Fixture',
            description: 'fixture',
            inputSchema: {
              type: 'object',
              properties: {
                tenant: {
                  type: 'object',
                  properties: {
                    region: { type: 'string', 'x-mcp-header': 'Region' },
                    id: { type: 'integer', 'x-mcp-header': 'Tenant' },
                  },
                },
              },
            },
            run: () => ({ content: [{ type: 'text', text: 'ok' }] }),
          },
        ],
        resources: { list: () => [], read: (uri) => (uri === 'margo://海' ? [{ uri, text: '海' }] : undefined) },
      }),
  });
  try {
    const params = { name: '海', arguments: { tenant: { region: '日本', id: 42 } } };
    const valid = { 'Mcp-Param-Region': encode('日本'), 'Mcp-Param-Tenant': '42.0' };
    assert.equal((await post(listener, 'tools/call', params, valid)).status, 200);
    for (const headers of [
      { ...valid, 'Mcp-Name': 'different' },
      { ...valid, 'Mcp-Method': 'tools/list' },
      {},
      { ...valid, 'Mcp-Param-Tenant': '43' },
      { ...valid, 'Mcp-Param-Region': '=?base64?bad!?=' },
    ]) {
      const response = await post(listener, 'tools/call', params, headers);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, -32020);
    }
    const missing = await post(listener, 'tools/list', {}, {}, { 'io.modelcontextprotocol/clientCapabilities': null });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, -32602);
    const mismatch = await post(
      listener,
      'tools/list',
      {},
      {},
      { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
    );
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, -32020);
    const resource = await post(listener, 'resources/read', { uri: 'margo://海' });
    assert.equal(resource.status, 200);
    assert.equal((await resource.json()).result.contents[0].text, '海');
    const absent = await post(listener, 'resources/read', { uri: 'margo://missing' });
    assert.equal((await absent.json()).error.code, -32602);
  } finally {
    await listener.close();
  }
});

test('current request disconnect cancels only that request, with no protocol session', { timeout: 15000 }, async () => {
  let started, stopped;
  const ready = new Promise((resolve) => {
      started = resolve;
    }),
    cancelled = new Promise((resolve) => {
      stopped = resolve;
    });
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
                    stopped();
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
    const controller = new AbortController();
    const first = fetch(listener.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${listener.token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Mcp-Protocol-Version': VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'wait',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'wait',
          _meta: {
            'io.modelcontextprotocol/protocolVersion': VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const rejected = assert.rejects(first);
    await ready;
    controller.abort();
    await rejected;
    await cancelled;
    assert.equal((await post(listener, 'ping')).status, 200);
  } finally {
    await listener.close();
  }
});
