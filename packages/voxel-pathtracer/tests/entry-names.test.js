import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// KB0986c (review 99): the resampled emitter entry is per-pixel RIS without spatial or
// temporal reservoir reuse, so its public name must not claim ReSTIR (reservoir-based
// spatiotemporal importance resampling, Bitterli et al. 2020).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the RIS entry is named for what it does, not for spatiotemporal reuse', () => {
  const entries = Object.keys(pkg.exports);
  assert.ok(entries.includes('./resampled'), 'expected the ./resampled entry');
  assert.deepEqual(
    entries.filter((name) => /restir/i.test(name)),
    [],
    'no entry may claim ReSTIR while it has no spatial or temporal reuse',
  );
  assert.deepEqual(
    Object.keys(pkg.scripts).filter((name) => /restir/i.test(name)),
    [],
  );
});
