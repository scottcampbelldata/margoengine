import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSIONS, RPC, VERSION, createMcpServer, serveStdio } from '../dist/index.js';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

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

test('a duplicate active tool id rejects without replacing the original cancellation owner', {
  timeout: 10000,
}, async () => {
  const calls = [];
  const server = createMcpServer({
    tools: [
      {
        ...slow,
        run: (_args, { signal }) =>
          new Promise((resolve) => {
            calls.push({ signal, resolve });
            signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }] }), {
              once: true,
            });
          }),
      },
    ],
  });
  const pending = [];
  try {
    pending.push(server.handle(request(7, 'tools/call', { name: 'slow' })));
    const duplicate = server.handle(request(7, 'tools/call', { name: 'slow' }));
    pending.push(duplicate);
    assert.equal(calls.length, 1, 'a duplicate must not invoke the tool or overwrite its controller');
    const rejected = await duplicate;
    assert.equal(rejected.id, 7);
    assert.equal(rejected.error.code, RPC.invalidRequest);
    await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal((await pending[0]).result.content[0].text, 'cancelled');
  } finally {
    server.dispose();
    await Promise.allSettled(pending);
  }
});

test('a resources/read reusing an active tool id is refused and leaves the tool cancellable', {
  timeout: 10000,
}, async () => {
  const calls = [];
  const server = createMcpServer({
    tools: [
      {
        ...slow,
        run: (_args, { signal }) =>
          new Promise((resolve) => {
            calls.push(signal);
            signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }] }), {
              once: true,
            });
          }),
      },
    ],
    resources: { list: () => [], read: (uri) => [{ uri, mimeType: 'text/plain', text: 'x' }] },
  });
  const pending = [server.handle(request(7, 'tools/call', { name: 'slow' }))];
  try {
    const read = await server.handle(request(7, 'resources/read', { uri: 'margo://docs/limits' }));
    assert.equal(read.error?.code, RPC.invalidRequest, 'a reused active id is refused');
    await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    assert.equal(calls[0].aborted, true, 'the tool call keeps its cancellation');
    assert.equal((await pending[0]).result.content[0].text, 'cancelled');
  } finally {
    server.dispose();
    await Promise.allSettled(pending);
  }
});

test('batch duplicate ids preserve cancellation and numeric/string ids remain distinct', {
  timeout: 10000,
}, async () => {
  const calls = [];
  const server = createMcpServer({
    tools: [
      {
        ...slow,
        run: (_args, { signal }) =>
          new Promise((resolve) => {
            calls.push({ signal, resolve });
            signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }] }), {
              once: true,
            });
          }),
      },
    ],
  });
  const pending = server.handle([
    request(7, 'tools/call', { name: 'slow' }),
    request(7, 'tools/call', { name: 'slow' }),
    request('7', 'tools/call', { name: 'slow' }),
  ]);
  try {
    assert.equal(calls.length, 2);
    await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    calls[1].resolve({ content: [{ type: 'text', text: 'string id' }] });
    const answers = await pending;
    assert.equal(answers[0].result.content[0].text, 'cancelled');
    assert.equal(answers[1].error.code, RPC.invalidRequest);
    assert.equal(answers[2].result.content[0].text, 'string id');
  } finally {
    server.dispose();
    await pending;
  }
});

test('stdio rejects a duplicate without losing cancellation of the original call', { timeout: 10000 }, async () => {
  let calls = 0;
  const server = createMcpServer({
    tools: [
      {
        ...slow,
        run: (_args, { signal }) =>
          new Promise((resolve) => {
            calls++;
            signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }] }), {
              once: true,
            });
          }),
      },
    ],
  });
  const input = new PassThrough(),
    output = new PassThrough();
  const lines = createInterface({ input: output });
  const serving = serveStdio(server, { input, output });
  try {
    const duplicate = once(lines, 'line');
    const message = JSON.stringify(request(7, 'tools/call', { name: 'slow' })) + '\n';
    input.write(message + message);
    assert.equal(JSON.parse((await duplicate)[0]).error.code, RPC.invalidRequest);
    assert.equal(calls, 1);
    const original = once(lines, 'line');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }) + '\n');
    assert.equal(JSON.parse((await original)[0]).result.content[0].text, 'cancelled');
    input.end();
    await serving;
  } finally {
    server.dispose();
    input.end();
    await serving;
    lines.close();
    input.destroy();
    output.destroy();
  }
});

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
