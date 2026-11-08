import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMargoServer, createMcpServer } from '../dist/index.js';
import { createDocResources, createStarterPrompts, RESOURCE_SCHEME } from '../dist/resources.js';
import { corpus, repository } from './support.js';

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('createDocResources lists the README, each package README and API report, and each docs page', () => {
  const resources = createDocResources(corpus);
  assert.equal(RESOURCE_SCHEME, 'margo://');
  assert.deepEqual(
    resources.list().map((r) => r.uri),
    [
      'margo://readme',
      'margo://packages/alpha/readme',
      'margo://packages/alpha/api',
      'margo://packages/beta/readme',
      'margo://docs/conventions',
    ],
    'beta has no entries, so no API resource',
  );
  const [readme, alpha] = resources.list();
  assert.deepEqual(readme, {
    uri: 'margo://readme',
    name: 'readme',
    title: 'Margo Engine README',
    description: 'What Margo is, how to install it and the package map.',
    mimeType: 'text/markdown',
    size: 7,
  });
  assert.equal(alpha.description, 'Draws widgets with a fancy gizmo.');
  assert.equal(alpha.size, new TextEncoder().encode(corpus.packages[0].readme).length);
  assert.deepEqual(
    resources.templates().map((t) => t.uriTemplate),
    ['margo://packages/{id}/readme', 'margo://packages/{id}/api', 'margo://docs/{+path}'],
  );
  assert.throws(() => createDocResources({}), { name: 'TypeError', message: /errors#mcp/ });
});

test('reading a resource gives its markdown; a package in any spelling resolves and an unknown address is undefined', () => {
  const resources = createDocResources(corpus);
  const [api] = resources.read('margo://packages/alpha/api');
  assert.equal(api.uri, 'margo://packages/alpha/api');
  assert.equal(api.mimeType, 'text/markdown');
  assert.match(api.text, /^# @margoengine\/alpha\n\n## API Report File/);
  assert.match(api.text, /\n# @margoengine\/alpha\/extras\n\n```ts\nexport const extraThing: number;/);
  assert.equal(resources.read('margo://packages/@margoengine/beta/readme')[0].text, corpus.packages[1].readme);
  assert.equal(resources.read('margo://docs/conventions')[0].text, corpus.docs[0].text);
  assert.equal(resources.read('margo://docs/nothing'), undefined);
  assert.equal(resources.read('file:///etc/passwd'), undefined, 'only the listed addresses are served');
});

test('the server serves resources over JSON-RPC: capability, paging with an opaque cursor, read and not found', async () => {
  using server = createMcpServer({ tools: [], resources: createDocResources(corpus), prompts: [], pageSize: 2 });
  const init = await server.handle(rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }));
  assert.deepEqual(init.result.capabilities, {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  });
  const uris = [];
  let cursor;
  let pages = 0;
  do {
    const answer = await server.handle(rpc(2, 'resources/list', cursor ? { cursor } : {}));
    uris.push(...answer.result.resources.map((r) => r.uri));
    cursor = answer.result.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3, 'five resources in pages of two');
  assert.equal(uris.length, 5);
  assert.equal(new Set(uris).size, 5, 'no resource twice');
  const bad = await server.handle(rpc(3, 'resources/list', { cursor: 'not-a-cursor' }));
  assert.equal(bad.error.code, -32602);
  const far = await server.handle(rpc(3, 'resources/list', { cursor: Buffer.from('99').toString('base64url') }));
  assert.equal(far.error.code, -32602, 'a cursor past the end is invalid');
  const templates = await server.handle(rpc(4, 'resources/templates/list'));
  assert.equal(templates.result.resourceTemplates.length, 2);
  assert.ok(templates.result.nextCursor);
  const read = await server.handle(rpc(5, 'resources/read', { uri: 'margo://docs/conventions' }));
  assert.equal(read.result.contents[0].text, corpus.docs[0].text);
  const missing = await server.handle(rpc(6, 'resources/read', { uri: 'margo://docs/nothing' }));
  assert.deepEqual(missing.error, { code: -32002, message: 'Resource not found', data: { uri: 'margo://docs/nothing' } });
  assert.equal((await server.handle(rpc(7, 'resources/read', {}))).error.code, -32602);
});

test('a server without resources or prompts declares neither and answers their methods as unknown', async () => {
  using server = createMcpServer({ tools: [] });
  const init = await server.handle(rpc(1, 'initialize', { protocolVersion: '2025-11-25' }));
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  for (const method of ['resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get'])
    assert.equal((await server.handle(rpc(2, method, {}))).error.code, -32601, method);
  assert.throws(() => createMcpServer({ tools: [], pageSize: 0 }), { name: 'RangeError' });
});

test('the starter prompts name the tools to use and put the arguments in; missing or bad arguments are invalid params', async () => {
  const prompts = createStarterPrompts();
  assert.deepEqual(
    prompts.map((p) => p.name),
    ['start_scene', 'port_code', 'fix_error', 'add_feature'],
  );
  using server = createMcpServer({ tools: [], prompts });
  const listed = await server.handle(rpc(1, 'prompts/list'));
  const port = listed.result.prompts.find((p) => p.name === 'port_code');
  assert.deepEqual(port.arguments.map((a) => [a.name, a.required ?? false]), [
    ['code', true],
    ['from', false],
  ]);
  assert.equal(listed.result.nextCursor, undefined);
  const scene = await server.handle(rpc(2, 'prompts/get', { name: 'start_scene' }));
  assert.equal(scene.result.messages[0].role, 'user');
  assert.match(scene.result.messages[0].content.text, /shows a lit box on a ground plane[\s\S]*check_snippet/);
  const ported = await server.handle(
    rpc(3, 'prompts/get', { name: 'port_code', arguments: { code: 'new Acme.Box()', from: 'Acme' } }),
  );
  const text = ported.result.messages[0].content.text;
  assert.match(text, /\(it uses Acme\)[\s\S]*port_to_margo with from set to Acme/);
  assert.match(text, /```\nnew Acme\.Box\(\)\n```$/);
  const fix = await server.handle(rpc(4, 'prompts/get', { name: 'fix_error', arguments: { error: 'Mesh disposed' } }));
  assert.match(fix.result.messages[0].content.text, /explain_error/);
  assert.doesNotMatch(fix.result.messages[0].content.text, /```ts/, 'no code block without code');
  const feature = await server.handle(rpc(5, 'prompts/get', { name: 'add_feature', arguments: { feature: 'shadows' } }));
  assert.match(feature.result.messages[0].content.text, /^Add shadows to this Margo Engine project\./);
  const lacking = await server.handle(rpc(6, 'prompts/get', { name: 'port_code', arguments: { code: '  ' } }));
  assert.deepEqual(lacking.error, { code: -32602, message: 'Missing required argument: code' });
  assert.equal((await server.handle(rpc(7, 'prompts/get', { name: 'nope' }))).error.code, -32602);
  const numbers = await server.handle(rpc(8, 'prompts/get', { name: 'fix_error', arguments: { error: 3 } }));
  assert.equal(numbers.error.message, 'arguments must be an object of strings');
});

test('the Margo server offers the docs as resources and the starter prompts', async () => {
  using server = await createMargoServer({ corpus, projectRoot: repository });
  const init = await server.handle(rpc(1, 'initialize', { protocolVersion: '2025-11-25' }));
  assert.ok(init.result.capabilities.resources && init.result.capabilities.prompts);
  const read = await server.handle(rpc(2, 'resources/read', { uri: 'margo://packages/alpha/readme' }));
  assert.match(read.result.contents[0].text, /makeGizmo/);
  const prompts = await server.handle(rpc(3, 'prompts/list'));
  assert.equal(prompts.result.prompts.length, 4);
});
