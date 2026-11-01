// f1da30b12: a build that rewrites a tracked file (docs/catalog.json) left every later engine:sync reporting uncommitted
// changes with no cause named. It now stops at once and says main is missing a regenerated file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('engine:sync checks tracked files right after the build and names the cause', () => {
  const source = readFileSync(new URL('../scripts/engine-sync.mjs', import.meta.url), 'utf8'),
    build = source.indexOf("['run', 'build:packages']"),
    check = source.indexOf("git('status', '--porcelain', '--untracked-files=no')", build);
  assert.ok(build > 0 && check > build, 'the status check follows the build');
  assert.match(source.slice(check), /main is missing a regenerated file/);
});
