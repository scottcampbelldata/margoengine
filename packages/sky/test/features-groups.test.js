import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression (KB1042h): test:gpu ran all eleven feature checks at both sample counts in one command, which passed every
// value assertion but outlived the 98 s bound. It now runs them as named groups of at most three, each in its own
// browser, and every case carries its own hard limit inside features-check.mjs.
test('sky test:gpu runs every feature check once, in named groups of at most three', () => {
  const script = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['test:gpu'];
  const source = readFileSync(new URL('./features-check.mjs', import.meta.url), 'utf8');
  const all = [
    ...[...source.matchAll(/^ {2}async '?([a-z-]+)'?\(page, samples\)/gm)].map((m) => m[1]),
    ...[...source.matchAll(/^checks\.([a-z]+) = async/gm)].map((m) => m[1]),
  ];
  assert.equal(all.length, 11);
  const groups = [...script.matchAll(/features-check\.mjs((?: [a-z-]+)*)/g)].map((m) => m[1].trim().split(' '));
  assert.ok(groups.length >= 4, `groups ${JSON.stringify(groups)}`);
  for (const group of groups) assert.ok(group.length >= 1 && group[0] !== '' && group.length <= 3, `group ${group}`);
  assert.deepEqual(groups.flat().sort(), [...all].sort());
  assert.match(source, /const CASE_LIMIT_MS = 60000;/);
  assert.match(source, /unknown sky feature check/);
});
