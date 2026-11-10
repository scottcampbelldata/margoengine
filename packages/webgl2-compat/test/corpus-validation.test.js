import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('corpus validates negative pipelines without weakening positive dispatch checks', () => {
  const source = readFileSync(new URL('./corpus-draw.html', import.meta.url), 'utf8').replaceAll('\r', '');
  const method = source.match(/function computeValidationResult\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(method, 'the corpus must explicitly check expected validation');
  const check = new Function(`${method[0]}; return computeValidationResult`)();
  const bindings = (n, visibility = 4, type = 'storage') =>
    Array.from({ length: n }, () => ({ visibility, buffer: { type } }));
  const layouts = [
    { entries: bindings(5) },
    { entries: [...bindings(5), ...bindings(4, 2), ...bindings(2, 4, 'uniform')] },
  ];
  const limits = { maxStorageBuffersPerShaderStage: 8 };
  const error = {
    name: 'GPUValidationError',
    message: 'createComputePipeline: 10 bindings exceed maxStorageBuffersPerShaderStage (8); use fewer bindings',
  };
  assert.deepEqual(check(layouts, limits, error), { invalid: true, problem: null });
  assert.match(check(layouts, limits, null).problem, /got no error/);
  assert.match(
    check(layouts, limits, { name: 'GPUInternalError', message: error.message }).problem,
    /expected validation/,
  );
  assert.match(check(layouts, limits, { name: error.name, message: 'different failure' }).problem, /different failure/);
  assert.deepEqual(check(layouts, { maxStorageBuffersPerShaderStage: 10 }, null), { invalid: false, problem: null });
  assert.equal(check(layouts, { maxStorageBuffersPerShaderStage: 10 }, error).problem, error.message);
});
