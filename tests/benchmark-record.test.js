// KB-L4-trw (found by a bug sweep, 2026-11-11): the *-gpu.mjs checks in examples/package-benchmarks wrote their
// reports over the tracked records in results/, so a passing test run left the tree dirty and stopped the next rebase,
// and a record the docs cite took the machine, date and commit of whoever ran the check. Every report now goes through
// writeReport: test-results/ unless the run passes --record. Checked on temporary folders and the scripts' text.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeReport } from '../examples/package-benchmarks/results-output.mjs';

const root = join(import.meta.dirname, '..'),
  bench = 'examples/package-benchmarks',
  scripts = readdirSync(join(root, bench)).filter((name) => name.endsWith('-gpu.mjs'));
/** The script without its comment lines: comments may name the tracked record. */
const code = (name) =>
  readFileSync(join(root, bench, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

test('a plain run writes test-results/ and leaves the record alone; --record writes the record', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'margo-report-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const record = join(temp, bench, 'results/example-gpu.json');
  const check = writeReport('example-gpu.json', '{"run":1}\n', { argv: ['node', 'x.mjs', '--bench'], root: temp });
  assert.equal(check, 'test-results/example-gpu.json');
  assert.equal(readFileSync(join(temp, check), 'utf8'), '{"run":1}\n');
  assert.equal(existsSync(record), false);
  const kept = writeReport('example-gpu.json', '{"run":2}\n', { argv: ['node', 'x.mjs', '--record'], root: temp });
  assert.equal(kept, `${bench}/results/example-gpu.json`);
  assert.equal(readFileSync(record, 'utf8'), '{"run":2}\n');
  assert.equal(readFileSync(join(temp, check), 'utf8'), '{"run":1}\n');
});

test('a plain report path is ignored by git, so a check run leaves the tree clean', () => {
  execFileSync('git', ['check-ignore', '-q', '--no-index', '--', 'test-results/example-gpu.json'], { cwd: root });
});

test('no *-gpu.mjs script names a tracked report of its own', () => {
  assert.ok(scripts.length >= 25, `${scripts.length} scripts found`);
  for (const name of scripts) {
    // post-effects-gpu.mjs plans its sections through post-effects-output.mjs (tests/post-effects-gpu-record.test.js).
    if (name === 'post-effects-gpu.mjs') continue;
    const source = code(name);
    assert.doesNotMatch(source, /(?<!test-)results\/[^'"`\s]*\.json/, `${name} writes its report with writeReport`);
    assert.doesNotMatch(source, /['"`](?:\.\/)?results\/?['"`]/, `${name} builds no path into results/ itself`);
    if (/\bwriteReport\(/.test(source))
      assert.match(source, /import \{ writeReport \} from '\.\/results-output\.mjs';/, name);
  }
});

test('every script that had a tracked report still writes it, through writeReport', () => {
  const records = readdirSync(join(root, bench, 'results'));
  for (const name of scripts) {
    const stem = name.slice(0, -'.mjs'.length);
    if (name === 'post-effects-gpu.mjs' || !records.includes(`${stem}.json`)) continue;
    assert.match(code(name), /\bwriteReport\(/, name);
  }
});

test('the features suite records the report it copies out of examples/package-benchmarks', () => {
  const suite = readFileSync(join(root, 'bench/suites/features.mjs'), 'utf8');
  assert.match(suite, /\['textured-instancing-gpu', `\$\{bench\}\/textured-instancing-gpu\.mjs`, '--record'\]/);
});
