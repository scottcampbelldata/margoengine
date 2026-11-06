// The CPU tier without `new Function` (a page whose Content-Security-Policy has no 'unsafe-eval'): Node's
// `--disallow-code-generation-from-strings` refuses it the same way, and every buffer-only kernel of the corpus must
// leave the same memory on the interpreter as on the compiled JavaScript. compute-browser.mjs runs the same refusal
// under a real policy, textures included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runComputeOnCPU } from '../dist/compute.js';

const run = (...flags) => {
  const script = fileURLToPath(new URL('interpret-run.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [...flags, script], {
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 1 << 26,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('every buffer-only corpus kernel leaves the same memory with and without new Function', () => {
  const compiled = run(),
    interpreted = run('--disallow-code-generation-from-strings');
  assert.equal(compiled.evalRefused, false);
  assert.equal(interpreted.evalRefused, true, 'the flag must refuse new Function, or this compares nothing');
  const ids = Object.keys(compiled.digests);
  assert.ok(ids.length >= 250, `only ${ids.length} kernels ran`);
  for (const id of ids) assert.equal(interpreted.digests[id], compiled.digests[id], id);
  assert.equal(Object.keys(interpreted.digests).length, ids.length);
});

test('a work budget stops runComputeOnCPU, coded, on an endless loop', () => {
  const out = new Uint32Array(4);
  assert.throws(
    () =>
      runComputeOnCPU({
        source: `@group(0) @binding(0) var<storage, read_write> o: array<atomic<u32>>;
          @compute @workgroup_size(1) fn main() { loop { atomicAdd(&o[0], 1u); } }`,
        workgroups: [1],
        buffers: new Map([['0:0', out]]),
        workBudget: 1000,
      }),
    (error) => error.code === 'failed' && /work budget of 1000/.test(error.message),
  );
  assert.ok(out[0] > 0 && out[0] <= 1000);
});

test('without the interpreter a page that forbids new Function gets a refusal naming the fix', () => {
  const script = `import { runComputeOnCPU } from ${JSON.stringify(new URL('../dist/compute.js', import.meta.url).href)};
    try {
      runComputeOnCPU({
        source: '@group(0) @binding(0) var<storage, read_write> o: array<u32>; @compute @workgroup_size(1) fn main() { o[0] = 1u; }',
        workgroups: [1],
        buffers: new Map([['0:0', new Uint32Array(1)]]),
      });
      console.log('ran');
    } catch (error) {
      console.log(error.code, error.message);
    }`;
  const r = spawnSync(
    process.execPath,
    ['--disallow-code-generation-from-strings', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.match(r.stdout, /^unsupported .*loadInterpreter\(\)/, r.stderr);
});
