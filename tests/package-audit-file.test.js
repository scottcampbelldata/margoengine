import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// docs/whitepaper/package-audit.md is edited by every audit lane. Two lanes once landed at the same time and left the
// header saying 11 rows were partial when the table held 10, and nothing noticed. A later pass that leaves files owed
// opens its first cell with "(<pass>, still partial" and counts as partial too.
const audit = readFileSync('docs/whitepaper/package-audit.md', 'utf8').replace(/\r\n/g, '\n'),
  rows = [...audit.matchAll(/^\| ([a-z0-9-]+)( \((?:[^:|]*, still )?partial)?[^|]*\|/gm)].filter((m) => m[1] !== 'Package' && !/^-+$/.test(m[1])),
  words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
  count = (text) => (/^\d+$/.test(text) ? Number(text) : words.indexOf(text.toLowerCase()));

test('the header counts the partial rows the table holds', () => {
  const said = audit.match(/(\w+) rows? says? "partial"/);
  assert.ok(said, 'the header states how many rows are partial');
  assert.equal(count(said[1]), rows.filter((m) => m[2]).length);
});

test('the header names every package with two rows', () => {
  const said = audit.match(/(\d+) of those \(([^)]+)\) have two rows/);
  assert.ok(said, 'the header names the packages with two rows');
  const seen = new Map();
  for (const m of rows) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  const twice = [...seen].filter(([, n]) => n > 1).map(([name]) => name).sort();
  assert.deepEqual(said[2].split(/,\s+/).sort(), twice);
  assert.equal(Number(said[1]), twice.length);
});
