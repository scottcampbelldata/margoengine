// `@margoengine/math/fields` holds the shared-field contracts as types only: importing it adds no code at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the fields entry is types only: no code, no exports at run time', async () => {
  const fields = await import('../dist/fields.js');
  assert.deepEqual(Object.keys(fields), []);
  assert.equal(readFileSync(new URL('../dist/fields.js', import.meta.url), 'utf8').trim(), '');
  const types = readFileSync(new URL('../dist/fields.d.ts', import.meta.url), 'utf8');
  for (const name of ['FlowField', 'FlowSample', 'Wind', 'FollowTarget', 'FollowSource'])
    assert.ok(types.includes(name), `${name} is declared`);
});
