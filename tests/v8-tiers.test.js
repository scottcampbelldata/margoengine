// Regression (2026-11-07): the allocation tests read Turbofan as bit 64 of %GetOptimizationStatus, which is true of V8 13
// (Node 24) and on V8 14 (Node 26) means the interpreter. On Node 26 those tests failed with code that was optimized,
// and could pass with code that was not. The tier bits are now found by measurement.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { v8Tiers } from '../scripts/support/v8-tiers.mjs';

// Each source differs: V8 shares code between functions compiled from the same text.
let serial = 0.5;
const fresh = () => new Function('a', 'b', `return a * b + ${++serial};`);

test('each forced tier reads as itself', () => {
  const { bits, isOptimized, isTurbofan } = v8Tiers(),
    run = (f, optimize) =>
      new Function('f', `%PrepareFunctionForOptimization(f); f(1, 2); f(2, 3); ${optimize}(f); f(3, 4);`)(f),
    plain = fresh(),
    maglev = fresh(),
    turbofan = fresh();
  plain(1, 2);
  run(maglev, '%OptimizeMaglevOnNextCall');
  run(turbofan, '%OptimizeFunctionOnNextCall');
  assert.deepEqual([isOptimized(plain), isTurbofan(plain)], [false, false], 'a function called twice');
  assert.deepEqual([isOptimized(maglev), isTurbofan(maglev)], [true, false], 'Maglev code');
  assert.deepEqual([isOptimized(turbofan), isTurbofan(turbofan)], [true, true], 'Turbofan code');
  assert.equal(new Set(Object.values(bits)).size, 3, `three different bits: ${JSON.stringify(bits)}`);
});

test('a function that loses its optimized code reads as unoptimized again', () => {
  const { isOptimized } = v8Tiers(),
    f = fresh();
  new Function('f', '%PrepareFunctionForOptimization(f); f(1, 2); f(2, 3); %OptimizeFunctionOnNextCall(f); f(3, 4);')(f);
  assert.equal(isOptimized(f), true);
  new Function('f', '%DeoptimizeFunction(f);')(f);
  assert.equal(isOptimized(f), false);
});

test('the bits are found under a flag that stops Turbofan in the caller', () => {
  const source = `import { v8Tiers } from ${JSON.stringify(new URL('../scripts/support/v8-tiers.mjs', import.meta.url).href)};
console.log(JSON.stringify(v8Tiers().bits));`,
    run = (...flags) =>
      execFileSync(process.execPath, [...flags, '--input-type=module', '-e', source], {
        encoding: 'utf8',
        timeout: 60_000,
      });
  assert.equal(run('--max-opt=2'), run());
});
