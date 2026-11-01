// bfde407d3: top-level frozen tables without a pure mark stayed in every bundle that imported their module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('every top-level frozen table in packages/shared is marked pure', () => {
  const dir = new URL('../packages/shared/', import.meta.url),
    bad = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const lines = readFileSync(new URL(name, dir), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^(export )?const \w+\s*=\s*Object\.(freeze|assign|create)\(/.test(line)) bad.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
