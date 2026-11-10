import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('VFX manifest remains valid JSON with one complete parity GPU gate after merging script additions', () => {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(text);
  assert.equal([...text.matchAll(/"test:gpu"\s*:/g)].length, 1);
  const gate = [manifest.scripts['test:gpu'], manifest.scripts['test:gpu:parity']].join(' && ');
  assert.match(gate, /parity\.mjs --all/);
  assert.match(gate, /parity\.mjs --all --compat/);
});
