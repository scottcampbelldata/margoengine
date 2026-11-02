// A package build that rewrites tracked generated output must never be reported as a successful dependency prep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('engine:sync checks tracked files immediately after building packages', () => {
  const source = readFileSync(new URL('../scripts/engine-sync.mjs', import.meta.url), 'utf8'),
    build = source.indexOf("['run', 'build:packages']"),
    check = source.indexOf("git('status', '--porcelain', '--untracked-files=no')", build);
  assert.ok(build > 0 && check > build, 'the tracked-file check follows the package build');
  assert.match(source.slice(check), /changed tracked files/);
});

test('engine:sync does not fetch, merge, commit, or push', () => {
  const source = readFileSync(new URL('../scripts/engine-sync.mjs', import.meta.url), 'utf8');
  for (const operation of ["git('fetch'", "git('merge'", "git('commit'", "git('push'"])
    assert.equal(source.includes(operation), false, `${operation} must stay outside engine:sync`);
});
