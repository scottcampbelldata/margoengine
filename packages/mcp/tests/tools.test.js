import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIndex, createTools, packageId, searchCorpus } from '../dist/index.js';
import { corpus, repository } from './support.js';

const tools = createTools({ corpus, projectRoot: repository });
const tool = (name) => tools.find((candidate) => candidate.name === name);
const context = { signal: new AbortController().signal };
const call = async (name, args = {}) => tool(name).run(args, context);

test('the server offers the five tools, each described with an input schema', () => {
  assert.deepEqual(
    tools.map((t) => t.name),
    ['search_docs', 'list_packages', 'get_package', 'list_examples', 'check_snippet'],
  );
  for (const t of tools) {
    assert.ok(t.description.length > 80, `${t.name} describes itself for the model`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.readOnlyHint, true);
  }
});

test('search_docs ranks the section, the declaration and the package that match a name', async () => {
  const result = await call('search_docs', { query: 'makeGizmo' });
  const hits = result.structuredContent.hits;
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].kind, 'api', 'the declaration of the exact name comes first');
  assert.equal(hits[0].entry, '@margoengine/alpha');
  assert.ok(hits.some((hit) => hit.kind === 'readme' && hit.title.includes('Gizmo')));
  assert.match(result.content[0].text, /export function makeGizmo/);
});

test('search_docs finds a package by what it does, and filters by kind and package', async () => {
  const byPurpose = await call('search_docs', { query: 'zebra textures' });
  assert.equal(byPurpose.structuredContent.hits[0].package, 'beta');
  const onlyDocs = await call('search_docs', { query: 'MargoError code', kind: 'doc' });
  assert.deepEqual(
    onlyDocs.structuredContent.hits.map((hit) => hit.kind),
    ['doc'],
  );
  const onlyBeta = await call('search_docs', { query: 'gizmo zebra', package: '@margoengine/beta' });
  assert.ok(onlyBeta.structuredContent.hits.every((hit) => hit.package === 'beta'));
  const examples = await call('search_docs', { query: 'helmet', kind: 'example' });
  assert.equal(examples.structuredContent.hits[0].path, 'examples/flight-helmet.html');
});

test('search_docs matches the parts of a camelCase name and a prefix, and says when nothing matches', async () => {
  const parts = await call('search_docs', { query: 'make gizmo' });
  assert.equal(parts.structuredContent.hits[0].kind, 'api');
  const prefix = await call('search_docs', { query: 'gizm' });
  assert.ok(prefix.structuredContent.hits.length > 0);
  const none = await call('search_docs', { query: 'qwertyuiop' });
  assert.deepEqual(none.structuredContent.hits, []);
  assert.match(none.content[0].text, /No results/);
});

test('search_docs limits results and rejects bad arguments with coded errors', async () => {
  const one = await call('search_docs', { query: 'gizmo', limit: 1 });
  assert.equal(one.structuredContent.hits.length, 1);
  await assert.rejects(() => call('search_docs', {}), TypeError);
  await assert.rejects(() => call('search_docs', { query: '   ' }), TypeError);
  await assert.rejects(() => call('search_docs', { query: 'x', limit: 99 }), RangeError);
  await assert.rejects(() => call('search_docs', { query: 'x', limit: 1.5 }), TypeError);
  await assert.rejects(() => call('search_docs', { query: 'x', kind: 'video' }), RangeError);
  await assert.rejects(() => call('search_docs', { query: 'x', package: 'nope' }), /No package named "nope"/);
  await assert.rejects(
    () => call('search_docs', { query: 'x', kind: 'video' }),
    (error) => error.message.endsWith('see https://margoengine.com/errors#mcp'),
  );
});

test('list_packages groups packages by layer and can filter by layer', async () => {
  const all = await call('list_packages');
  assert.equal(all.structuredContent.packages.length, 2);
  assert.match(all.content[0].text, /Rendering and lighting:\n {2}@margoengine\/alpha: Draws widgets/);
  const loading = await call('list_packages', { category: 'LOADING' });
  assert.deepEqual(
    loading.structuredContent.packages.map((p) => p.name),
    ['@margoengine/beta'],
  );
  await assert.rejects(() => call('list_packages', { category: 'zzz' }), RangeError);
});

test('get_package returns a README, an API report or both, under any spelling of the name', async () => {
  for (const name of ['alpha', '@margoengine/alpha', 'margoengine/alpha', ' ALPHA ']) {
    const readme = await call('get_package', { package: name });
    assert.match(readme.content[0].text, /Call `makeGizmo\(\)`/);
    assert.equal(readme.structuredContent.package, '@margoengine/alpha');
  }
  const api = await call('get_package', { package: 'alpha', part: 'api' });
  assert.match(api.content[0].text, /export function makeGizmo/);
  assert.match(api.content[0].text, /extraThing/);
  assert.doesNotMatch(api.content[0].text, /Install alpha/);
  assert.deepEqual(api.structuredContent.entries, ['@margoengine/alpha', '@margoengine/alpha/extras']);
  const one = await call('get_package', { package: 'alpha', part: 'api', entry: './extras' });
  assert.match(one.content[0].text, /extraThing/);
  assert.doesNotMatch(one.content[0].text, /makeGizmo/);
  const both = await call('get_package', { package: 'alpha', part: 'both', entry: '@margoengine/alpha' });
  assert.match(both.content[0].text, /Install alpha[\s\S]*makeGizmo/);
  assert.match((await call('get_package', { package: 'beta', part: 'api' })).content[0].text, /has no API report/);
});

test('get_package truncates at maxChars and names the way to get the rest', async () => {
  const big = createTools({
    corpus: { ...corpus, packages: [{ ...corpus.packages[1], readme: `# big\n\n${'line of text\n'.repeat(500)}` }] },
  }).find((t) => t.name === 'get_package');
  const result = await big.run({ package: 'beta', maxChars: 1000 }, context);
  assert.equal(result.structuredContent.truncated, true);
  assert.match(result.content[0].text, /\[truncated at 1000 of \d+ characters: raise maxChars\]/);
});

test('get_package suggests near names and rejects bad arguments', async () => {
  await assert.rejects(() => call('get_package', { package: 'alph' }), /did you mean @margoengine\/alpha\?/);
  await assert.rejects(() => call('get_package', { package: 'zzz' }), /call list_packages/);
  await assert.rejects(() => call('get_package', {}), TypeError);
  await assert.rejects(() => call('get_package', { package: 'alpha', part: 'x' }), RangeError);
  await assert.rejects(
    () => call('get_package', { package: 'alpha', part: 'api', entry: './nope' }),
    /its entries are/,
  );
  await assert.rejects(() => call('get_package', { package: 'alpha', maxChars: 5 }), RangeError);
});

test('list_examples lists every example, or those that match a filter', async () => {
  const all = await call('list_examples');
  assert.equal(all.structuredContent.examples.length, 2);
  assert.match(all.content[0].text, /examples\/flight-helmet\.html: The Khronos Flight Helmet/);
  const some = await call('list_examples', { filter: 'MINIMAP' });
  assert.deepEqual(
    some.structuredContent.examples.map((e) => e.id),
    ['minimap'],
  );
  assert.deepEqual((await call('list_examples', { filter: 'zzz' })).structuredContent.examples, []);
  await assert.rejects(() => call('list_examples', { filter: 3 }), TypeError);
});

test('check_snippet accepts code that type-checks against the installed Margo types', async () => {
  const result = await call('check_snippet', {
    code: "import { createStage } from 'margoengine';\nconst stage = await createStage('#scene');\nstage.dispose();\n",
  });
  assert.equal(result.structuredContent.ok, true, result.content[0].text);
  assert.match(result.content[0].text, /^OK: no type errors \(TypeScript \d/);
});

test('check_snippet reports the line, column and code of a wrong name', async () => {
  const result = await call('check_snippet', {
    code: "import { createStage } from 'margoengine';\nconst stage = await createStage('#scene');\nstage.paintItRed();\n",
  });
  assert.equal(result.structuredContent.ok, false);
  const [problem] = result.structuredContent.diagnostics;
  assert.equal(problem.line, 3);
  assert.equal(problem.column, 7);
  assert.equal(problem.code, 'TS2339');
  assert.match(problem.message, /paintItRed/);
  assert.match(result.content[0].text, /^FAILED: 1 problem/);
  assert.match(result.content[0].text, /line 3:7 error TS2339/);
  assert.match(result.content[0].text, /stage\.paintItRed\(\);/);
});

test('check_snippet reports a missing package and a wrong export, and checks JavaScript and TSX', async () => {
  const missing = await call('check_snippet', { code: "import { x } from '@margoengine/not-a-package';\nx;\n" });
  assert.equal(missing.structuredContent.ok, false);
  assert.match(missing.structuredContent.diagnostics[0].message, /not-a-package/);
  const noExport = await call('check_snippet', { code: "import { nope } from 'margoengine';\nnope;\n" });
  assert.match(noExport.structuredContent.diagnostics[0].message, /no exported member 'nope'/);
  const js = await call('check_snippet', {
    language: 'js',
    code: "import { createStage } from 'margoengine';\n/** @type {number} */\nconst n = 'text';\ncreateStage;\n",
  });
  assert.equal(js.structuredContent.ok, false);
  assert.equal(js.structuredContent.diagnostics[0].line, 3);
  const tsx = await call('check_snippet', { language: 'tsx', code: 'const view = <div>{1 + 1}</div>;\nview;\n' });
  assert.ok(
    tsx.structuredContent.diagnostics.every((d) => !d.code.startsWith('TS1')),
    'JSX parses (no syntax errors)',
  );
});

test('check_snippet is strict unless asked otherwise, and a snippet without imports may use top-level await', async () => {
  const code = 'function f(a) { return a; }\nawait Promise.resolve(f(1));\n';
  const strict = await call('check_snippet', { code });
  assert.equal(strict.structuredContent.ok, false);
  assert.equal(strict.structuredContent.diagnostics[0].code, 'TS7006');
  const loose = await call('check_snippet', { code, strict: false });
  assert.equal(loose.structuredContent.ok, true, loose.content[0].text);
});

test('check_snippet rejects bad arguments, a project without TypeScript, and cancellation', async () => {
  await assert.rejects(() => call('check_snippet', {}), TypeError);
  await assert.rejects(() => call('check_snippet', { code: '  ' }), TypeError);
  await assert.rejects(() => call('check_snippet', { code: 'let a = 1;', language: 'py' }), RangeError);
  await assert.rejects(() => call('check_snippet', { code: 'let a = 1;', strict: 'yes' }), TypeError);
  await assert.rejects(() => call('check_snippet', { code: 'x'.repeat(200_001) }), RangeError);
  const empty = mkdtempSync(join(tmpdir(), 'margo-mcp-empty-'));
  const away = createTools({ corpus, projectRoot: empty });
  const none = away.find((t) => t.name === 'check_snippet');
  await assert.rejects(
    () => none.run({ code: 'let a = 1;' }, context),
    (error) => error.name === 'MargoError' && error.code === 'unsupported' && /--root/.test(error.message),
  );
  rmSync(empty, { recursive: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => tool('check_snippet').run({ code: 'let a: number = 1;' }, { signal: controller.signal }));
});

test('the search index handles empty corpora and package names in any spelling', () => {
  assert.equal(packageId('@margoengine/sciviz'), 'sciviz');
  assert.equal(packageId('margoengine/sciviz'), 'sciviz');
  assert.equal(packageId('  Stage '), 'stage');
  const empty = createIndex({ packages: [], docs: [], examples: [], readme: '' });
  assert.deepEqual(searchCorpus(empty, 'anything'), []);
  assert.throws(() => searchCorpus(empty, ''), TypeError);
});
