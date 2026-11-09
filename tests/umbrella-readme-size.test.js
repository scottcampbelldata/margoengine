import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the umbrella README and root README report the same core plus stage size', () => {
  const root = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const umbrella = readFileSync(new URL('../packages/margoengine/README.md', import.meta.url), 'utf8');
  const measured = root.match(/The core and the stage together are ([\d,]+) bytes gzip/);
  const alias = umbrella.match(/core \+ stage alone, ([\d,]+) B gzip/);
  assert.ok(measured, 'the root README records the measured size');
  assert.ok(alias, 'the umbrella README records the alias size');
  assert.equal(alias[1], measured[1]);
});
