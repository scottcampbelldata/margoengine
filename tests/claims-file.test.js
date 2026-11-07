import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// docs/whitepaper/claims.md is edited by every lane and merged often. A rebase once left two rows with one number and the
// page's title below the table, and nothing noticed.
const claims = readFileSync('docs/whitepaper/claims.md', 'utf8').replace(/\r\n/g, '\n'),
  limits = readFileSync('docs/limits.md', 'utf8'),
  ids = [...claims.matchAll(/^\| LIM-(\d+) \|/gm)].map((m) => Number(m[1]));

test('claims.md opens with its title and has only that one', () => {
  assert.ok(claims.startsWith('# Claims and evidence\n'), 'the title leads the page');
  assert.equal(claims.match(/^# /gm).length, 1);
});

test('no two limit claims share a number', () => {
  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(id), `LIM-${id} is used twice`);
    seen.add(id);
  }
});

test('no two limit claims say the same thing', () => {
  const seen = new Map();
  for (const [, id, text] of claims.matchAll(/^\| LIM-(\d+) \| ([^|]+) \|/gm)) {
    assert.ok(!seen.has(text), `LIM-${id} repeats LIM-${seen.get(text)}`);
    seen.set(text, id);
  }
});

// A keep-both in a rebase once brought back two rows under new numbers with their old figures, so the text differed.
test('no two limit claims open with the same name', () => {
  const seen = new Map();
  for (const [, id, text] of claims.matchAll(/^\| LIM-(\d+) \| ([^|:]{1,60}): /gm)) {
    assert.ok(!seen.has(text), `LIM-${id} repeats the name of LIM-${seen.get(text)}: ${text}`);
    seen.set(text, id);
  }
});

test('docs/limits.md names the last limit claim', () => {
  const [, last] = /LIM-001 to LIM-(\d+)/.exec(limits);
  assert.equal(Number(last), Math.max(...ids));
});
