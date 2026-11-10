// Generated public metadata must never retain a merge conflict after concurrent lane landings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('generated API, import metadata and public help contain no unresolved merge boundaries', () => {
  for (const path of [
    'docs/api-surface.md',
    'docs/architecture/operational-playbook.md',
    'docs/clean-room.md',
    'docs/known-bugs.md',
    'docs/limits.md',
    'docs/work-lists/readme-owed.md',
    'site/llms.txt',
    'site/llms-full.txt',
    'site/errors.html',
    'packages/margoengine/package.json',
  ]) {
    assert.equal(
      /^(?:<{7}|>{7})(?:\s|$)/m.test(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')),
      false,
      `${path} retains a merge boundary; regenerate with its owning script and stop the landing on any failure`,
    );
  }
});
