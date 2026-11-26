// A CI job whose scripts compare with the merge base with origin/main needs that ref. actions/checkout@v4 checks out
// one commit (a pull request's merge commit) and no origin/main, so scripts/lint.mjs failed every pull-request run
// ("fatal: Not a valid object name origin/main", PR 68), and the quality gate's history and document-reader checks,
// which treat a missing merge base as nothing to check, checked nothing there.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;

/** Whether `file` or a module it imports (relative imports, followed through) runs `git merge-base`. */
export function reachesMergeBase(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return false;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  if (/['"]merge-base['"]/.test(text)) return true;
  for (const [, spec] of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g))
    if (reachesMergeBase(resolve(dirname(file), spec), seen)) return true;
  return false;
}

/** The node scripts a CI `run:` line starts, through `npm run <name>` or `node <file>`. */
function entries(line, depth = 0) {
  const found = [];
  for (const [, name] of line.matchAll(/npm run ([\w:.-]+)/g))
    if (scripts[name] && depth < 5) found.push(...entries(scripts[name], depth + 1));
  for (const [, file] of line.matchAll(/\bnode(?:\s+--[\w-]+(?:=\S+)?)*\s+((?:\.\/)?scripts\/\S+\.m?js)/g))
    found.push(resolve(root, file));
  return found;
}

test('lint.mjs and the quality gate are found to reach merge-base (the scan sees what it guards)', () => {
  assert.ok(reachesMergeBase(resolve(root, 'scripts/lint.mjs')));
  assert.ok(entries('npm run quality').some((file) => reachesMergeBase(file)));
});

test('every CI job that runs a merge-base script checks out the whole history', () => {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const jobs = ci.split(/\n {2}(?=[a-z][\w-]*:\n)/).slice(1);
  const missing = [];
  for (const job of jobs) {
    const runs = [...job.matchAll(/^\s*(?:- )?run: (.+)$/gm)].map((m) => m[1]);
    const needs = runs.filter((line) => entries(line).some((file) => reachesMergeBase(file)));
    if (needs.length && !/fetch-depth: 0\b/.test(job)) missing.push(`${job.split(':')[0]}: ${needs.join('; ')}`);
  }
  assert.deepEqual(missing, [], 'give these jobs actions/checkout with fetch-depth: 0');
});
