// The browser stress suite once read Engine's private `recovery` field. The build renames private members, so the
// read was always undefined and both dispose-recovery sessions timed out. The suite may use public members only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('tests/modern-stress.js reads no private Engine member', () => {
  const engine = readFileSync(new URL('../packages/core/src/engine.ts', import.meta.url), 'utf8');
  const privates = new Set([...engine.matchAll(/^\s+private (?:readonly )?(?:get |set )?([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  assert.ok(privates.has('recovery') && privates.size > 10);
  const stress = readFileSync(new URL('./modern-stress.js', import.meta.url), 'utf8');
  const used = [...stress.matchAll(/\bengine\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((name) => privates.has(name));
  assert.deepEqual([...new Set(used)], []);
});
