import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createMargoServer } from '../dist/index.js';
import {
  createErrorTool,
  errorPageUrl,
  formatError,
  loadErrorEntries,
  lookupError,
} from '../dist/error-codes.js';
import { corpus, repository } from './support.js';

const entries = [
  {
    id: 'disposed',
    title: 'disposed: used after dispose()',
    kind: 'code',
    messages: ['Engine disposed', 'Mesh disposed'],
    cause: 'It was disposed.',
    fix: 'Make a new one.',
  },
  {
    id: 'widgets',
    title: 'Widgets',
    kind: 'family',
    messages: ['Slider needs finite min < max', 'Slider step must be 0 or more', 'Label text is a string'],
    cause: 'A widget got a bad option.',
    fix: 'Pass the option the message names.',
  },
];

test('lookupError finds an entry by its link, its id or code, and a listed message with or without its link', () => {
  assert.deepEqual(
    lookupError(entries, 'see https://margoengine.com/errors#widgets').map((m) => [m.entry.id, m.by]),
    [['widgets', 'link']],
  );
  assert.equal(lookupError(entries, 'DISPOSED')[0].by, 'id', 'an error code in any case');
  const thrown = lookupError(entries, 'Uncaught TypeError: Slider step must be 0 or more');
  assert.deepEqual([thrown[0].entry.id, thrown[0].by, thrown[0].message], ['widgets', 'message', 'Slider step must be 0 or more']);
  assert.equal(lookupError(entries, 'MargoError [disposed]: Mesh disposed')[0].entry.id, 'disposed');
});

test('lookupError falls back to shared words, and a stray word or an unknown link matches nothing', () => {
  const near = lookupError(entries, 'slider min max must be finite');
  assert.equal(near[0].entry.id, 'widgets');
  assert.equal(near[0].by, 'words');
  assert.equal(near[0].message, 'Slider needs finite min < max');
  assert.deepEqual(lookupError(entries, 'the slider exploded completely today'), [], 'one shared word of five is no match');
  assert.deepEqual(lookupError(entries, 'errors#nope'), []);
  assert.deepEqual(lookupError(entries, 'the of and'), [], 'stop words alone match nothing');
  assert.throws(() => lookupError(entries, '  '), { name: 'TypeError', message: /errors#mcp/ });
});

test('the shipped entries are the error help page, and real thrown messages find their entry', async () => {
  const shipped = await loadErrorEntries();
  const { entries: source } = await import(pathToFileURL(join(repository, 'scripts/errors/entries.js')).href);
  assert.deepEqual(shipped, source, 'dist/error-codes.json is scripts/errors/entries.js');
  const { typeError, fault } = await import(pathToFileURL(join(repository, 'packages/shared/errors.js')).href);
  // Every listed message, thrown the way the packages throw it, finds its own entry first.
  for (const entry of source)
    for (const message of entry.messages) {
      const thrown = entry.kind === 'code' ? fault(entry.id, message) : typeError(message, entry.id);
      const [best] = lookupError(shipped, String(thrown));
      assert.equal(best?.entry.id, entry.id, message);
    }
  const [disposed] = lookupError(shipped, 'disposed');
  assert.equal(disposed.entry.kind, 'code');
});

test('explain_error answers with the cause and fix, structured matches, and rejects bad arguments', async () => {
  const tool = createErrorTool(entries);
  assert.equal(tool.name, 'explain_error');
  assert.equal(tool.annotations.readOnlyHint, true);
  const context = { signal: new AbortController().signal };
  const result = await tool.run({ error: 'Engine disposed; see https://margoengine.com/errors#disposed' }, context);
  assert.equal(
    result.content[0].text,
    'disposed: used after dispose()  (https://margoengine.com/errors#disposed)\nCause: It was disposed.\nFix: Make a new one.',
  );
  assert.deepEqual(result.structuredContent.matches[0], {
    id: 'disposed',
    title: 'disposed: used after dispose()',
    kind: 'code',
    url: errorPageUrl('disposed'),
    cause: 'It was disposed.',
    fix: 'Make a new one.',
    by: 'link',
    score: 100,
  });
  const near = await tool.run({ error: 'slider min max must be finite' }, context);
  assert.match(near.content[0].text, /^Widgets {2}\(https:\/\/margoengine\.com\/errors#widgets\)\nClosest listed message: Slider needs finite min < max\n/);
  const none = await tool.run({ error: 'qwertyuiop' }, context);
  assert.deepEqual(none.structuredContent.matches, []);
  assert.equal(none.content[0].text, formatError('qwertyuiop', []));
  assert.throws(() => tool.run({}, context), { name: 'TypeError', message: /error is required/ });
  assert.throws(() => tool.run({ error: 'x', limit: 0.5 }, context), { name: 'TypeError' });
  assert.throws(() => tool.run({ error: 'x', limit: 11 }, context), { name: 'RangeError' });
  assert.throws(() => createErrorTool([]), { name: 'TypeError', message: /at least one entry/ });
});

test('the Margo server lists explain_error and answers it over JSON-RPC', async () => {
  using server = await createMargoServer({ corpus, projectRoot: repository });
  const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(listed.result.tools.some((tool) => tool.name === 'explain_error'));
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'explain_error', arguments: { error: 'Mesh disposed; see https://margoengine.com/errors#disposed' } },
  });
  assert.equal(answer.result.isError, undefined);
  assert.match(answer.result.content[0].text, /^disposed: /);
});

test('loadErrorEntries rejects a missing file with a coded error and honours an aborted signal', async () => {
  await assert.rejects(loadErrorEntries(join(repository, 'no-such-errors.json')), { code: 'failed' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadErrorEntries(join(repository, 'package.json'), controller.signal), { name: 'AbortError' });
});
