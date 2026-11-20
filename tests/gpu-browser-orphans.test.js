// The class guard for browser test files (Scott, 2026-11-16, "fix this the right way"): every browser test file of a
// package is reached by something check:gpu-packages runs, with no hand-kept list of tests, so a check dropped from a
// package's test:gpu chain is named on the next push (hygiene plans the suites). Since 238e5eab9d the heat-containment
// test reads the split chains from the package scripts, so nothing else noticed a chain losing a file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isBrowserFile, testUniverse, unrunBrowserFiles } from '../scripts/gpu-package-tests.mjs';

const files = {
  'packages/demo/test/a-browser.mjs': "import { launchBrowser } from '../../../scripts/lib/browser.mjs';\nawait launchBrowser();",
  'packages/demo/test/b.browser.mjs': "import { run } from './harness.mjs';\nawait run('page');",
  // A harness that names a check only in a comment does not run it: a-browser.mjs.
  'packages/demo/test/harness.mjs': '// Like a-browser.mjs, but for pages.\nexport const run = (name) => go(`/packages/demo/test/${name}.html`);',
  'packages/demo/test/page.html': '<script type="module" src="./page-browser.js"></script>',
  'packages/demo/test/page-browser.js': 'window.check = () => 1;',
  'packages/demo/scripts/test-browser.js':
    "import { launchBrowser } from '../../../scripts/lib/browser.mjs';\nconst name = process.argv[2]?.slice(7) ?? 'gi';\nawait launchBrowser();\ngo(`tests/${name}.html`);",
  'packages/demo/tests/gi.html': '<script type="module" src="gi-browser.js"></script>',
  'packages/demo/tests/gi-browser.js': 'window.runTests = () => [];',
  'packages/demo/tests/ground.html': '<script type="module" src="ground-browser.js"></script>',
  'packages/demo/tests/ground-browser.js': 'window.runTests = () => [];',
  'packages/demo/tests/shot-browser.mjs': "import { launchBrowser } from '../../../scripts/lib/browser.mjs';\nawait launchBrowser();",
  'packages/demo/tests/unit.test.js': "import { launchBrowser } from 'x';",
};
const read = (file) => files[file];
const universe = Object.keys(files);
const chain = 'cd ../.. && node packages/demo/test/a-browser.mjs && node packages/demo/test/b.browser.mjs';
const commands = (gpu = chain, page = 'node scripts/test-browser.js --page=ground') => [
  { cwd: 'packages/demo', command: gpu },
  { cwd: 'packages/demo', command: 'node scripts/test-browser.js' },
  { cwd: 'packages/demo', command: page },
];
const exempt = { 'packages/demo/tests/shot-browser.mjs': 'a tool run by hand' };

test('a browser test file is one named for the browser or driving one, outside node tests and fixtures', () => {
  assert.equal(isBrowserFile('packages/demo/tests/gi-browser.js', ''), true);
  assert.equal(isBrowserFile('packages/demo/test/b.browser.mjs', ''), true);
  assert.equal(isBrowserFile('packages/demo/tests/browser-check.js', ''), true);
  assert.equal(isBrowserFile('packages/demo/tests/rig.mjs', "await launchBrowser();"), true);
  assert.equal(isBrowserFile('packages/demo/tests/rig.mjs', 'export const x = 1;'), false);
  assert.equal(isBrowserFile('packages/demo/tests/unit.test.js', "await launchBrowser();"), false);
  assert.equal(isBrowserFile('packages/demo/tests/fixtures/x-browser.js', ''), false);
});

test('every file is reached: started by a chain, imported, loaded by a page, or named by a page argument', () => {
  assert.deepEqual(unrunBrowserFiles(commands(), universe, read, exempt), []);
  // Without its reason, the tool is named too.
  assert.deepEqual(unrunBrowserFiles(commands(), universe, read, {}), ['packages/demo/tests/shot-browser.mjs']);
});

test('a check dropped from its package chain is named, and a comment naming it does not count', () => {
  assert.deepEqual(
    unrunBrowserFiles(commands('cd ../.. && node packages/demo/test/b.browser.mjs'), universe, read, exempt),
    ['packages/demo/test/a-browser.mjs'],
  );
  // Dropping the page check leaves the page module it loads unreached as well.
  assert.deepEqual(
    unrunBrowserFiles(commands('cd ../.. && node packages/demo/test/a-browser.mjs'), universe, read, exempt),
    ['packages/demo/test/b.browser.mjs', 'packages/demo/test/page-browser.js'],
  );
  // A page run only through its runner's argument: dropping the argument names the page module.
  assert.deepEqual(unrunBrowserFiles(commands(chain, 'node scripts/test-browser.js'), universe, read, exempt), [
    'packages/demo/tests/ground-browser.js',
  ]);
});

// KB-ROOT-RED18 part 5: tests/dev-server-watch.test.js makes tests/.dev-server-watch-<pid> and removes it while other
// root tests plan the GPU check, so the walk listed its mod.js and the read that followed failed with ENOENT. A
// dot-named folder is scratch, never a test source, and the walk does not enter it.
test('the test universe leaves dot-named scratch folders out', () => {
  const base = mkdtempSync(join(tmpdir(), 'margo-universe-'));
  try {
    for (const file of [
      'packages/demo/test/a-browser.mjs',
      'packages/demo/test/.scratch/b-browser.mjs',
      'scripts/run.mjs',
      'tests/page.html',
      'tests/.dev-server-watch-1/mod.js',
      'tests/.dev-server-watch-1/page.html',
    ]) {
      mkdirSync(join(base, dirname(file)), { recursive: true });
      writeFileSync(join(base, file), '');
    }
    assert.deepEqual(testUniverse(base), ['packages/demo/test/a-browser.mjs', 'scripts/run.mjs', 'tests/page.html']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
