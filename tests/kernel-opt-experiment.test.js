// The kernel optimisation experiment reads core's shipping kernel the way core ships it (raw deflate), not as gzip.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateKernel } from '../scripts/build-core-kernel.mjs';
import { readBlueprint } from '../scripts/lib/kernel-blueprint.mjs';

const source = readFileSync(new URL('../packages/core/src/wasm.ts', import.meta.url), 'utf8');

test('readBlueprint inflates the committed core kernel to valid WebAssembly', () => {
  const { compressed, wasm } = readBlueprint(source);
  assert.deepEqual([...wasm.subarray(0, 4)], [0, 0x61, 0x73, 0x6d]);
  assert.ok(WebAssembly.validate(wasm));
  assert.deepEqual(deflateKernel(wasm), compressed, 'the blueprint uses the deflateKernel settings');
});

test('kernel-opt-experiment decodes and compresses kernels with the blueprint format', () => {
  const experiment = readFileSync(new URL('../scripts/kernel-opt-experiment.js', import.meta.url), 'utf8');
  assert.match(experiment, /readBlueprint\(wasmSource\)/);
  assert.doesNotMatch(experiment, /gunzipSync/, 'the blueprint is raw deflate; gunzip throws "incorrect header check"');
});

test('kernel-opt-experiment bundles core + stage with the measure:size externals, RegExp entries included', async () => {
  const experiment = readFileSync(new URL('../scripts/kernel-opt-experiment.js', import.meta.url), 'utf8');
  assert.match(experiment, /external: coreStageExternal/);
  const { coreStageExternal, external } = await import('../scripts/measure-size.js');
  assert.ok(external.some((name) => name instanceof RegExp), 'measure:size keeps RegExp externals');
  assert.ok(!coreStageExternal.some((name) => typeof name === 'string' && name.startsWith('@margoengine/core')));
  assert.deepEqual(
    coreStageExternal.filter((name) => name instanceof RegExp),
    external.filter((name) => name instanceof RegExp),
  );
});
