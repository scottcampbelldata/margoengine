import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSIONS, RPC, VERSION, createMcpServer } from '../dist/index.js';
import { readFileSync } from 'node:fs';

const echo = {
  name: 'echo',
  title: 'Echo',
  description: 'Returns its text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  run: (args) => ({ content: [{ type: 'text', text: String(args.text ?? '') }] }),
};
const slow = {
  name: 'slow',
  title: 'Slow',
  description: 'Waits until cancelled.',
  inputSchema: { type: 'object', properties: {} },
  run: (_args, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
    ),
};
const broken = {
  name: 'broken',
  title: 'Broken',
  description: 'Always throws.',
  inputSchema: { type: 'object', properties: {} },
  run: () => {
    throw Object.assign(new Error('Thing disposed; create a new Thing; see https://margoengine.com/errors#mcp'), {
      code: 'disposed',
    });
  },
};
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('the version matches the manifest', () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('initialize negotiates the protocol version and reports what the server is', async () => {
  const server = createMcpServer({ tools: [echo], instructions: 'Use echo.' });
  for (const version of PROTOCOL_VERSIONS) {
    const answer = await server.handle(
      request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '0' } }),
    );
    assert.equal(answer.result.protocolVersion, version);
  }
  const newer = await server.handle(request(2, 'initialize', { protocolVersion: '2099-01-01' }));
  assert.equal(
    newer.result.protocolVersion,
    PROTOCOL_VERSIONS[0],
    'an unknown version gets the newest the server speaks',
  );
  assert.deepEqual(newer.result.capabilities, { tools: { listChanged: false } });
  assert.equal(newer.result.serverInfo.name, 'margoengine');
  assert.equal(newer.result.serverInfo.version, VERSION);
  assert.equal(newer.result.instructions, 'Use echo.');
  assert.equal(newer.id, 2);
  assert.equal(server.initialized, false);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(server.initialized, true);
});

test('ping, tools/list and tools/call answer with the request id', async () => {
  const server = createMcpServer({ tools: [echo] });
  assert.deepEqual(await server.handle(request('a', 'ping')), { jsonrpc: '2.0', id: 'a', result: {} });
  const list = await server.handle(request(7, 'tools/list'));
  assert.equal(list.result.tools[0].name, 'echo');
  assert.equal(list.result.tools[0].inputSchema.type, 'object');
  const called = await server.handle(request(8, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }));
  assert.deepEqual(called.result.content, [{ type: 'text', text: 'hi' }]);
  const noArguments = await server.handle(request(9, 'tools/call', { name: 'echo' }));
  assert.equal(noArguments.result.content[0].text, '');
});

test('protocol faults are JSON-RPC errors with the standard codes', async () => {
  const server = createMcpServer({ tools: [echo] });
  assert.equal((await server.handle(request(1, 'nope/nothing'))).error.code, RPC.methodNotFound);
  assert.equal((await server.handle(request(2, 'tools/call', { name: 'missing' }))).error.code, RPC.invalidParams);
  assert.equal(
    (await server.handle(request(3, 'tools/call', { name: 'echo', arguments: [] }))).error.code,
    RPC.invalidParams,
  );
  const bad = await server.handle({ id: 4, method: 'ping' });
  assert.equal(bad.error.code, RPC.invalidRequest);
  assert.equal(bad.id, 4);
  assert.equal((await server.handle('text')).id, null);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, RPC.invalidRequest);
  assert.equal((await server.handle([])).error.code, RPC.invalidRequest);
});

test('a tool that throws is a result with isError, the code and the help link, not a protocol error', async () => {
  const server = createMcpServer({ tools: [broken] });
  const answer = await server.handle(request(1, 'tools/call', { name: 'broken' }));
  assert.equal(answer.error, undefined);
  assert.equal(answer.result.isError, true);
  assert.equal(answer.result.structuredContent.error.code, 'disposed');
  assert.equal(answer.result.structuredContent.error.help, 'https://margoengine.com/errors#mcp');
  assert.match(answer.result.content[0].text, /^disposed: Thing disposed/);
});

test('a batch is answered in order, without answers for notifications', async () => {
  const server = createMcpServer({ tools: [echo] });
  const answers = await server.handle([
    request(1, 'ping'),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    request(2, 'tools/list'),
  ]);
  assert.deepEqual(
    answers.map((a) => a.id),
    [1, 2],
  );
  assert.equal(await server.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), undefined);
});

test('notifications/cancelled aborts the running request and the other requests carry on', async () => {
  const server = createMcpServer({ tools: [slow, echo] });
  const running = server.handle(request(10, 'tools/call', { name: 'slow' }));
  const other = await server.handle(request(11, 'tools/call', { name: 'echo', arguments: { text: 'still here' } }));
  assert.equal(other.result.content[0].text, 'still here');
  await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } });
  const answer = await running;
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /stopped/);
});

test('dispose cancels what is running and refuses later messages with a disposed error', async () => {
  const server = createMcpServer({ tools: [slow] });
  const running = server.handle(request(1, 'tools/call', { name: 'slow' }));
  server[Symbol.dispose]();
  assert.equal((await running).result.isError, true);
  const later = await server.handle(request(2, 'ping'));
  assert.equal(later.id, 2);
  assert.match(later.error.message, /The server was disposed; see https:\/\/margoengine\.com\/errors#mcp/);
});
