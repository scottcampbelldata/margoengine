// Bugs 54 and 55: the licence in the site's JSON-LD and every stated package count must match their source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  jsonLdLicenses,
  licenceProblems,
  buildsCodeAtRunTime,
  packageCountProblems,
  publicTruthProblems,
  restateTestCount,
  testCountProblems,
  unsafeEvalProblems,
} from '../scripts/support/public-truth.mjs';

const apache = 'Apache License\n Version 2.0, January 2004';
const ld = (license) =>
  `<script type="application/ld+json">{"@type":"SoftwareSourceCode","license":"${license}"}</script>`;
const run = (html, licenseText = apache) =>
  licenceProblems({ html, page: 'p.html', license: 'Apache-2.0', licenseText });

test('the repository states its licence and package counts truthfully', () => {
  assert.deepEqual(publicTruthProblems(), []);
});

test('every perf-history entry and every claim has a number of its own', () => {
  const repeats = (file, pattern) => {
    const seen = new Set(),
      twice = [];
    for (const [, id] of readFileSync(new URL(`../docs/whitepaper/${file}`, import.meta.url), 'utf8').matchAll(pattern))
      if (seen.has(id)) twice.push(id);
      else seen.add(id);
    assert.ok(seen.size > 50, `${file}: the pattern found ${seen.size} numbers`);
    return twice;
  };
  assert.deepEqual(repeats('perf-history.md', /^### (\d+)\. /gm), []);
  assert.deepEqual(repeats('claims.md', /^\| (LIM-\d+) \|/gm), []);
});

test('a JSON-LD licence that differs from package.json fails, and the right URL passes', () => {
  assert.deepEqual(run(ld('https://www.apache.org/licenses/LICENSE-2.0')), []);
  assert.deepEqual(run(ld('https://opensource.org/license/apache-2-0')), []);
  assert.match(run(ld('https://opensource.org/license/mit'))[0], /differs from package\.json \(Apache-2\.0\)/);
  assert.match(run('<script type="application/ld+json">{}</script>')[0], /no JSON-LD license/);
  assert.match(run(ld('https://www.apache.org/licenses/LICENSE-2.0'), 'MIT License')[0], /LICENSE is not/);
  assert.deepEqual(jsonLdLicenses('<script type="application/ld+json">{"a":[{"license":{"@id":"u"}}]}</script>'), [
    'u',
  ]);
});

test('a stated package count that differs from the catalog fails, and true counts pass', () => {
  const files = {
    'a.md': '93 packages in 12 layers, the same as the catalog.\nSearch all 93 packages by task.',
    'b.html':
      '<b>93</b><span>packages in the catalog</span> and the release includes 93 packages (none published to npm yet)',
    'c.md': 'The 47 packages whose code runs in Node, and 37 packages with WGSL shaders, are partial counts.',
  };
  assert.deepEqual(packageCountProblems(files, 93), []);
  const wrong = packageCountProblems(
    {
      'a.md': 'Search all 83 packages by task',
      'b.html': 'The release includes 78 packages under it. <b>78</b><span>optional packages</span>',
      'c.md': '75 packages in 12 layers',
      'd.md': 'all 75 packages move in lockstep',
      'e.md': '1,234 packages (none published to npm yet)',
    },
    93,
  );
  assert.equal(wrong.length, 6, wrong.join('\n'));
  assert.match(wrong[0], /a\.md: states 83 packages, the catalog has 93/);
});

// Bug 63 (audit E-09) and E-07: the white paper said nothing in the engine needs 'unsafe-eval' although the optional
// WebGL2 CPU compute tier builds its shaders with `new Function`, and it said 6,373 tests after the count had moved.
const measured = { commit: 'abc1234', tests: 6511, pass: 6509, skipped: 2 };
const eager = { sources: { 'packages/webgl2-compat/src/compute/js.ts': "const f = new Function('H', source);" } };
const withEval = {
  ...eager,
  readme: 'The CPU tier needs a page that allows JavaScript compiled at run time (CSP `unsafe-eval`).',
};

test('a page that says nothing needs unsafe-eval fails while the CPU compute tier builds code with new Function', () => {
  const wrong = {
    'a.html': "Nothing in the engine needs <code>'unsafe-eval'</code>; the Wasm kernel needs wasm-unsafe-eval.",
    'b.md': "- Nothing needs `'unsafe-eval'`, workers included: Draco decoding runs under the same policy.",
    'c.md': 'No package source uses `eval`, `new Function` or string timers, and every import names a fixed module.',
  };
  const problems = unsafeEvalProblems(wrong, withEval);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems[0], /a\.html: says nothing needs 'unsafe-eval', but the optional WebGL2 CPU compute tier does/);
  const right = {
    'a.html':
      "The standard WebGPU path and the other WebGL2 tiers need no 'unsafe-eval'. The optional WebGL2 CPU compute tier needs it or is refused.",
    'b.md': "The wasm directive is 'wasm-unsafe-eval'; nothing else here needs it, except the CPU compute tier.",
  };
  assert.deepEqual(unsafeEvalProblems(right, withEval), []);
});

test('the white paper must say where unsafe-eval is needed, and the README must agree with the code', () => {
  assert.match(
    unsafeEvalProblems({ 'site/whitepaper/engine.html': "The page allows 'unsafe-eval' for workers." }, withEval)[0],
    /never says the optional WebGL2 CPU compute tier needs it/,
  );
  assert.match(
    unsafeEvalProblems({}, { ...eager, readme: 'No mention.' })[0],
    /README\.md does not say that the CPU compute tier needs 'unsafe-eval'/,
  );
  // The code no longer builds code at run time: the README and pages repeating the need are stale.
  assert.match(
    unsafeEvalProblems({}, { sources: { 'x.ts': 'const a = 1;' }, readme: withEval.readme })[0],
    /no source there builds code at run time any more/,
  );
  assert.equal(buildsCodeAtRunTime('new Function("a", b)'), true);
  assert.equal(buildsCodeAtRunTime('a.eval()'), false, 'a method named eval is not eval');
  assert.equal(buildsCodeAtRunTime('// a new Function is not used'), false);
});

test('a stated test count that differs from test-count.json, or names another commit, fails', () => {
  const ok = {
    'engine.html': `<div><b>6,511</b><span>Node tests in every <code>npm run verify</code>: 6,509 pass, 2 skipped, 0 fail</span><i>abc1234</i></div>
      <li><strong>6,511 Node tests</strong> in every <code>npm run verify</code> at abc1234: 6,509 pass, 2 skipped, 0 fail.</li>
      <span>tests at abc1234</span> npm run verify   # the 6,511 tests, quality gates`,
    'claims.md': '| engine | 6,511 tests, 6,509 pass, 2 skipped (Node 26.12, `abc1234`) | file | PROVEN |',
  };
  assert.deepEqual(testCountProblems(ok, measured), []);
  const stale = testCountProblems(
    {
      'engine.html': `<b>6,373</b><span>Node tests in every verify: 6,371 pass, 2 skipped</span> abc1234
        <strong>6,511 Node tests</strong> at abc1234: 6,509 pass, 3 skipped. tests at ec3f9b52. the 6,373 tests, quality gates`,
      'claims.md': '| engine | 6,373 tests, 6,371 pass, 2 skipped (Node 26.12, `ec3f9b52`) |',
    },
    measured,
  );
  assert.ok(
    stale.some((p) =>
      /engine\.html: states 6373 tests, 6371 pass, 2 skipped; .* measured 6511, 6509, 2 at abc1234/.test(p),
    ),
    stale.join('\n'),
  );
  assert.ok(stale.some((p) => /states 6511 tests, 6509 pass, 3 skipped/.test(p)));
  assert.ok(stale.some((p) => /says tests were counted at ec3f9b52/.test(p)));
  assert.ok(stale.some((p) => /states 6,373 tests, .* measured 6511/.test(p)));
  assert.ok(stale.some((p) => /claims\.md: states a test count but does not name the commit/.test(p)));
  assert.match(testCountProblems({}, { ...measured, commit: 'main' })[0], /not a commit hash/);
});

test('a headline with markup inside is read, and restating rewrites every statement so the check passes', () => {
  const page = `<div role="listitem"><b>6,373</b><span>Node tests in every <code>npm run verify</code>: 6,371 pass, 2 skipped, 0 fail</span><i>results/test-count.json · ec3f9b52</i></div>
<span>tests at ec3f9b52; sizes at 51d8786a</span>
<li><strong>6,373 Node tests</strong> in every <code>npm run verify</code> at commit ec3f9b52: 6,371 pass, 2 skipped, 0 fail.</li>
<pre>npm run verify   # the 6,373 tests, quality gates</pre>`;
  const claims = '| engine | 6,373 tests, 6,371 pass, 2 skipped (Node 26.12, `ec3f9b52`) | file | PROVEN |';
  const handoff =
    '- Test count re-measured: 6,373 tests, 6,371 pass, 2 skipped at `ec3f9b52` (`results/test-count.json`).';
  const files = { 'engine.html': page, 'claims.md': claims };
  assert.equal(
    testCountProblems(files, measured).filter((p) => /states 6373 tests/.test(p)).length,
    3,
    'the headline, the sentence and the row are all read',
  );
  const fixed = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path, restateTestCount(text, measured, 'ec3f9b52')]),
  );
  assert.deepEqual(testCountProblems(fixed, measured), []);
  assert.match(fixed['engine.html'], /sizes at 51d8786a/, 'a commit that is not the test commit is left alone');
  assert.match(fixed['engine.html'], /<b>6,511<\/b>.*6,509 pass, 2 skipped, 0 fail.*· abc1234/s);
  assert.match(restateTestCount(handoff, measured, 'ec3f9b52'), /6,511 tests, 6,509 pass, 2 skipped at `abc1234`/);
  assert.match(fixed['engine.html'], /the 6,511 tests, quality gates/);
});

test('record-test-count reads node:test summaries', async () => {
  const { parseSummary } = await import('../scripts/record-test-count.mjs');
  const out =
    'ℹ tests 8\nℹ pass 8\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ tests 6541\nℹ pass 6539\nℹ fail 0\nℹ cancelled 0\nℹ skipped 2\nℹ todo 0\n';
  assert.deepEqual(parseSummary(out), { tests: 6541, pass: 6539, fail: 0, skipped: 2, todo: 0 });
  assert.equal(parseSummary('no summary here'), undefined);
});
