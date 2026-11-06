// scripts/check-wall-budgets.mjs: an assert that compares a wall clock against a fixed number is caught, and the tree
// holds no more of them than its baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scan, wallBudgets } from '../scripts/check-wall-budgets.mjs';

const lines = (source) => wallBudgets(source).map((b) => b.line);

test('an upper bound on elapsed wall time inside an assert is a budget, directly or through a variable', () => {
  assert.deepEqual(lines('const t = performance.now();\nassert.ok(performance.now() - t < 500);'), [2]);
  assert.deepEqual(lines('assert.ok(Date.now() - begun <= 2000, `took`);'), [1]);
  assert.deepEqual(lines('const s = performance.now();\nconst ms = performance.now() - s;\nassert.ok(ms < 100);'), [3]);
  // The bug this check exists for: elapsed time divided by a count, the limit on the next line of a long assert.
  assert.deepEqual(
    lines(
      'const start = performance.now();\nconst each = (performance.now() - start) / 4;\nassert.ok(\n  each < 400,\n  "x",\n);',
    ),
    [4],
  );
  assert.deepEqual(lines('const r = { ms: Date.now() - begun };\nconst { ms } = r;\nassert.ok(ms < 5000);'), [3]);
  assert.deepEqual(lines('if (performance.now() - t0 > 20000) throw new Error("late");'), [1]);
});

test('a marked wait, a lower bound, a deadline poll, CPU time and a comment are not budgets', () => {
  assert.deepEqual(lines('// wall-clock: the 30 s timeout did not run out\nassert.ok(Date.now() - t < 15000);'), []);
  assert.deepEqual(lines('assert.ok(Date.now() - t < 15000); // wall-clock: near the hang it tells apart'), []);
  assert.deepEqual(lines('assert.ok(performance.now() - start >= 55, "the delay happened");'), []);
  assert.deepEqual(lines('for (const end = Date.now() + 9000; !ready(); ) assert.ok(Date.now() < end);'), []);
  assert.deepEqual(lines('const cpu = cpuTimer();\nwork();\nassert.ok(cpu() < 200);'), []);
  assert.deepEqual(lines('// assert.ok(performance.now() - t < 500);\nconst x = 1;'), []);
  assert.deepEqual(lines('while (Date.now() - started < 3000) await poll();'), []);
  assert.deepEqual(lines('const ms = performance.now() - s;\nconsole.log(ms < 100);'), []);
});

test('a mark needs its reason', () => {
  assert.deepEqual(lines('// wall-clock:\nassert.ok(Date.now() - t < 15000);'), [2]);
});

test('the tree holds no more wall-clock budgets than the baseline', () => {
  const { files } = JSON.parse(readFileSync(new URL('../scripts/wall-budgets-baseline.json', import.meta.url), 'utf8'));
  const over = Object.entries(scan())
    .filter(([file, budgets]) => budgets.length > (files[file] ?? 0))
    .map(([file, budgets]) => `${file}: ${budgets.map((b) => `${b.line}: ${b.text}`).join('; ')}`);
  assert.deepEqual(
    over,
    [],
    'use cpuTimer() from scripts/support/cpu-budget.mjs, move the budget to a bench, or mark a bound on a wait // wall-clock: <reason>',
  );
});

test('a budget in a git-ignored scratch build is not scanned; every tracked file is, ignored or dotted path or not', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'wall-budgets-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const budget = 'const t = performance.now();\nassert.ok(performance.now() - t < 500);\n';
  const put = (file, text) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  put('.gitignore', '.lane/\n');
  put('.lane/p/dry/tests/scratch.test.js', budget);
  put('tests/tracked.test.js', budget);
  put('.tools/tests/dotted.test.js', budget);
  put('.lane/tests/forced.test.js', budget);
  put('tests/removed.test.js', budget);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.gitignore', 'tests', '.tools');
  // Tracked in spite of the ignore rule: git holds it, so it can reach main.
  git('add', '-f', '.lane/tests/forced.test.js');
  rmSync(join(repo, 'tests/removed.test.js'));
  assert.deepEqual(Object.keys(scan(repo)), [
    '.lane/tests/forced.test.js',
    '.tools/tests/dotted.test.js',
    'tests/tracked.test.js',
  ]);
});
