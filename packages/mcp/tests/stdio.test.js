// Starts the real command over stdio, as Claude Code, Claude Desktop and Cursor do, and calls every tool.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createMcpServer, runCli, serveStdio } from '../dist/index.js';
import { repository } from './support.js';

const bin = new URL('../bin/margoengine-mcp.js', import.meta.url);

// npm makes a bin executable when it installs, so a mode of 644 in git shows the file as modified on every macOS and Linux checkout.
test('the bin is executable in git', () => {
  const file = fileURLToPath(bin),
    entry = execFileSync('git', ['ls-files', '--stage', '--', file], { encoding: 'utf8' });
  assert.match(entry, /^100755 /);
});

/** A running server process with `send` (one JSON line in) and `receive(id)` (the response with that id). */
function start(args = ['--root', repository]) {
  const child = spawn(process.execPath, [fileURLToPath(bin), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(),
    seen = new Map(),
    lines = [],
    stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    const message = JSON.parse(line);
    if (waiting.has(message.id)) waiting.get(message.id)(message);
    else seen.set(message.id, message);
  });
  return {
    child,
    lines,
    stderr,
    send: (message) => child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
    receive: (id) => (seen.has(id) ? Promise.resolve(seen.get(id)) : new Promise((done) => waiting.set(id, done))),
    async close() {
      // `--help` and a usage error end the process by themselves, before its input does.
      const closed =
        child.exitCode === null ? once(child, 'close').then(([code]) => code) : Promise.resolve(child.exitCode);
      child.stdin.on('error', () => {});
      child.stdin.end();
      return closed;
    },
  };
}
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('the command speaks MCP over stdio and every tool answers', { timeout: 120_000 }, async () => {
  const server = start();
  server.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  const init = await server.receive(1);
  assert.equal(init.result.serverInfo.name, 'margoengine');
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (await server.receive(2)).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['search_docs', 'list_packages', 'get_package', 'list_examples', 'check_snippet', 'port_to_margo', 'explain_error']);

  // All five at once: requests run side by side and answers match by id.
  server.send(call(3, 'search_docs', { query: 'createStage', kind: 'api', limit: 3 }));
  server.send(call(4, 'list_packages', { category: 'AI tools' }));
  server.send(call(5, 'get_package', { package: '@margoengine/mcp', part: 'readme' }));
  server.send(call(6, 'list_examples', { filter: 'helmet' }));
  server.send(
    call(7, 'check_snippet', {
      code: "import { createStage } from 'margoengine';\nconst stage = await createStage('#scene');\nstage.nothing();\n",
    }),
  );
  const [search, packages, readme, examples, check] = await Promise.all(
    [3, 4, 5, 6, 7].map((id) => server.receive(id)),
  );

  assert.ok(search.result.structuredContent.hits.some((hit) => hit.title.endsWith('createStage')));
  assert.deepEqual(
    packages.result.structuredContent.packages.map((p) => p.name),
    ['@margoengine/mcp'],
  );
  assert.match(
    readme.result.content[0].text,
    /Context Protocol\]\(https:\/\/modelcontextprotocol\.io\) server for Margo Engine/,
  );
  assert.ok(examples.result.structuredContent.examples.some((e) => e.path === 'examples/flight-helmet.html'));
  assert.equal(check.result.structuredContent.ok, false);
  assert.match(check.result.structuredContent.diagnostics[0].message, /nothing/);

  server.send(call(8, 'get_package', { package: 'nope' }));
  const failed = await server.receive(8);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.error.code, 'range');

  assert.equal(await server.close(), 0, 'the command ends with exit code 0 when its input ends');
  // stdout carries protocol messages only: every line parsed as JSON-RPC above.
  for (const line of server.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.equal(Buffer.concat(server.stderr).toString(), '', 'nothing is logged on a clean run');
});

test('a line that is not JSON gets a parse error and the server keeps serving', async () => {
  const server = start();
  server.send('this is not json');
  const bad = await server.receive(null);
  assert.equal(bad.error.code, -32700);
  server.send({ jsonrpc: '2.0', id: 'after', method: 'ping' });
  assert.deepEqual((await server.receive('after')).result, {});
  assert.equal(await server.close(), 0);
});

test('--help, --version and an unknown option are answered on stderr with the right exit codes', async () => {
  const run = async (...args) => {
    const server = start(args);
    const code = await server.close();
    return { code, text: Buffer.concat(server.stderr).toString(), out: server.lines };
  };
  const help = await run('--help');
  assert.equal(help.code, 0);
  assert.match(help.text, /Tools: search_docs, list_packages, get_package, list_examples, check_snippet/);
  assert.match((await run('--version')).text, /^1\.0\.0\n$/);
  const unknown = await run('--bogus');
  assert.equal(unknown.code, 2);
  assert.match(unknown.text, /--bogus/);
  assert.deepEqual(unknown.out, []);
});

test('serveStdio answers every request already started when the input ends, and stops on abort', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const tool = {
    name: 'later',
    title: 'Later',
    description: 'Answers after a moment.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      // fixed-wait: the tool under test takes a moment, and nothing depends on how long
      await new Promise((done) => setTimeout(done, 50));
      return { content: [{ type: 'text', text: 'done' }] };
    },
  };
  const server = createMcpServer({ tools: [tool] });
  const served = serveStdio(server, { input, output });
  input.end(
    `${JSON.stringify(call(1, 'later', {}))}\n\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
  );
  await served;
  output.end();
  const answers = Buffer.concat(await output.toArray())
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(answers.map((a) => a.id).sort(), [1, 2]);
  assert.equal(answers.find((a) => a.id === 1).result.content[0].text, 'done');

  const controller = new AbortController();
  const idle = serveStdio(server, { input: new PassThrough(), output: new PassThrough(), signal: controller.signal });
  controller.abort();
  await idle;
  assert.equal(await runCli(['--help'], { messages: { write() {} } }), 0);
});
