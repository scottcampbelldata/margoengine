import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression (amd-gpu-hunt row 32, 2026-11-11): under MARGO_COMPAT=1 subgroups-check asserted that the adapter offers
// subgroups and shader-f16, which the WebGL2 layer never does, so the check failed on every machine. Its compat branch
// must assert the layer's documented fallback (no features, one-lane subgroups checked lane for lane), not skip the run.
test('subgroups-check asserts the WebGL2 layer fallback under MARGO_COMPAT=1', () => {
  const text = readFileSync(new URL('./subgroups-check.mjs', import.meta.url), 'utf8');
  assert.match(text, /const compat = compatRun\(\)/, 'the check knows a compatibility run');
  const branch = text.slice(text.indexOf('if (compat) {'), text.indexOf('} else {', text.indexOf('if (compat) {')));
  assert.match(branch, /assert\.ok\(!fast\.supported && !fast\.half/, 'compat: the requested features are absent');
  assert.match(branch, /const a = verify\(fast, inputs\)/, 'compat: every lane is still verified');
  assert.match(branch, /assert\.equal\(a\.lanes, 1/, 'compat: one-lane subgroups');
  assert.ok(text.indexOf('const plain = await run([])') > text.indexOf('if (compat) {'), 'the featureless run follows on both backends');
});
