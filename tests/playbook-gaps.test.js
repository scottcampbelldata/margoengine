// The playbook's evidence gaps (docs/architecture/operational-playbook.md, section 5) are one numbered list that
// AGENTS.md has every change extend. Regression (2026-11-07): two changes landed in parallel and both took item 23,
// so a reference to "item 23" named two gaps. The list must count 1, 2, 3 ... with no number used twice or skipped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const playbook = readFileSync(join(import.meta.dirname, '..', 'docs/architecture/operational-playbook.md'), 'utf8');

/** The item numbers of the numbered list in section 5, in file order. */
function gapNumbers(text) {
  const start = text.search(/^## 5\. /m);
  assert.ok(start >= 0, 'section 5 exists');
  const rest = text.slice(start + 1),
    next = rest.search(/^## /m),
    section = next >= 0 ? rest.slice(0, next) : rest;
  return [...section.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
}

test('the evidence gaps count 1, 2, 3 ... with no number twice', () => {
  const numbers = gapNumbers(playbook);
  assert.ok(numbers.length > 0);
  assert.deepEqual(
    numbers,
    numbers.map((_, i) => i + 1),
  );
});

test('a list with a number used twice fails the check', () => {
  const twice = '## 5. Gaps\n\n1. a\n2. b\n2. c\n## 6. Next\n1. d\n';
  const numbers = gapNumbers(twice);
  assert.deepEqual(numbers, [1, 2, 2]);
  assert.notDeepEqual(
    numbers,
    numbers.map((_, i) => i + 1),
  );
});
