// Bug (2026-11-12): docs/known-bugs.md, docs/conventions.md and other public pages said a fix "needs Scott" or "needs
// Scott's yes", which reads as an internal hand-off to an outside reader. Public docs say "needs a maintainer decision".
// docs/work-lists/ and AGENTS.md are the internal records and keep their own wording.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { documents } from '../scripts/docs-links.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const INTERNAL = /^(?:docs\/work-lists\/|AGENTS\.md$)/;
const HANDOFF = /\bneeds? Scott\b/i;

test('the scan finds a hand-off phrase and passes the public wording', () => {
  assert.ok(HANDOFF.test('- **Fix to build (needs Scott):** a model'));
  assert.ok(HANDOFF.test("Intentional breaks need Scott's yes"));
  assert.ok(!HANDOFF.test('needs a maintainer decision'));
});

test('no public doc says a fix needs Scott', () => {
  const found = [];
  for (const file of documents().filter((path) => !INTERNAL.test(path)))
    read(file)
      .split('\n')
      .forEach((line, index) => {
        if (HANDOFF.test(line)) found.push(`${file}:${index + 1}`);
      });
  assert.deepEqual(found, [], 'write "needs a maintainer decision"');
});
