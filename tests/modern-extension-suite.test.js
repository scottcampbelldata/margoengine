// Regression: `npm run modern:test:extensions` ran its eight suites in one process with no time limit, so a wait that
// never ended (getCompilationInfo() that Chromium left pending, in material-extension-tests.js) held the run until the
// GPU lock's 30 minute limit with no message. Each suite now runs alone under runLimited, which ends its process tree
// at the limit and names the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { NOT_IN_CHECKS, ROOT, unrunBrowserSuites, unrunReleaseGates } from '../scripts/gpu-package-tests.mjs';
import { STEPS } from '../scripts/modern-extension-suite.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('modern:test:extensions runs every suite as its own time-limited step', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts['modern:test:extensions'], 'node scripts/modern-extension-suite.mjs');
  assert.match(read('scripts/modern-extension-suite.mjs'), /await runLimited\(`node \$\{step\}`/);
  for (const step of STEPS) assert.ok(existsSync(new URL('../' + step, import.meta.url)), step);
  assert.equal(new Set(STEPS).size, STEPS.length);
});

test('no suite of the chain starts another one inside its own process, outside the limit', () => {
  for (const step of STEPS)
    for (const other of STEPS)
      if (other !== step)
        assert.ok(!read(step).includes(`import('./${other.slice('scripts/'.length)}')`), `${step} imports ${other}`);
});

// The class of bug: modern:test:extensions drove a browser from test:release alone, its name matched no guard
// (scripts/gpu-package-tests.mjs looks for `browser` or `gpu`), and it rotted for two weeks unseen.
test('a test:release suite that drives a browser must be in a check, or say why it is not', () => {
  const page = "import { openBrowser } from './browser.js';\nawait openBrowser();\n";
  const read = (file) =>
    ({ 'scripts/a.js': page, 'scripts/b.js': page, 'scripts/c.js': page, 'scripts/d.js': '' })[file];
  const scripts = {
    'test:release': 'npm run lost && npm run listed && npm run merged && npm run plain && npm run fuzz -- --short',
    'check:merge:steps': 'npm run verify && npm run merged',
    lost: 'node scripts/a.js',
    listed: 'node scripts/b.js',
    merged: 'node scripts/c.js',
    plain: 'node scripts/d.js',
  };
  assert.deepEqual(unrunReleaseGates(scripts, read, {}, { listed: 'its reason' }), ['lost']);
  assert.deepEqual(unrunReleaseGates(scripts, read, { lost: '' }, { listed: 'its reason' }), []);
});

test('check:gpu-packages runs modern:test:extensions, and this repo has no unrun release gate', () => {
  assert.ok('modern:test:extensions' in ROOT);
  const scripts = JSON.parse(read('package.json')).scripts,
    file = (path) => (path && existsSync(new URL('../' + path, import.meta.url)) ? read(path) : undefined);
  assert.deepEqual(unrunReleaseGates(scripts, file), []);
});

// The class of bug again: modern:test:sky, finalization and test:tokyo were in no check at all, not even test:release.
test('a test:* browser suite must be in a check, a copy of one, a step of the extension suite, or say why not', () => {
  const page = "import { openBrowser } from './browser.js';\nawait openBrowser();\n";
  const read = (file) => (file === 'scripts/plain.js' ? '' : page);
  const scripts = {
    'check:merge:steps': 'npm run verify && npm run test:merged',
    'test:lost': 'node scripts/lost.js',
    'modern:test:lost': 'node scripts/lost2.mjs',
    'test:ran': 'node scripts/ran.js',
    'test:copy': 'node scripts/ran.js',
    'test:merged': 'node scripts/merged.js',
    'test:step': 'node scripts/step.js',
    'test:said': 'node scripts/said.js',
    'test:plain': 'node scripts/plain.js',
  };
  assert.deepEqual(
    unrunBrowserSuites(scripts, read, { 'test:ran': '' }, { 'test:said': 'a reason' }, ['scripts/step.js']),
    ['test:lost', 'modern:test:lost'],
  );
});

test('every browser suite of this repo is in a check or in NOT_IN_CHECKS with a reason', () => {
  const scripts = JSON.parse(read('package.json')).scripts,
    file = (path) => (path && existsSync(new URL('../' + path, import.meta.url)) ? read(path) : undefined);
  assert.deepEqual(unrunBrowserSuites(scripts, file, ROOT, NOT_IN_CHECKS, STEPS), []);
  for (const [name, reason] of Object.entries(NOT_IN_CHECKS)) {
    assert.ok(scripts[name], `${name} is gone from package.json; remove it from NOT_IN_CHECKS`);
    assert.ok(reason.length > 20, `${name} needs a stated reason`);
  }
  for (const name of ['modern:test:sky', 'modern:test:finalization', 'test:tokyo']) assert.ok(name in ROOT, name);
});
