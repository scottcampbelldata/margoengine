import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkGpuPolicy, policyViolations } from '../scripts/check-gpu-policy.mjs';

test('the exclusive class gate rejects CLI, environment and aliased API correctness requests', {
  timeout: 30_000,
}, () => {
  for (const source of [
    `spawn('node scripts/gpu-lock.mjs run --exclusive --owner=x -- npm run verify');`,
    `spawn('node', ['scripts/gpu-lock.mjs', 'run', '--exclusive', '--', 'node', 'view.mjs']);`,
    `spawn('node', ['view.mjs'], {env: {MARGO_GPU_EXCLUSIVE: '1'}});`,
    `import {acquire as take} from './gpu-lock.mjs'; await take({owner:'x', mode:'exclusive'});`,
  ])
    assert.ok(policyViolations('scripts/view.mjs', source, new Set()).length, source);
  assert.equal(
    policyViolations('package.json', JSON.stringify({ scripts: { gate: 'MARGO_GPU_EXCLUSIVE=1 npm run verify' } }))
      .length,
    1,
  );
});

test('classified benchmarks, explicit CLI timing and inventoried speed drivers pass without reading comments as code', () => {
  for (const source of [
    `spawn('node scripts/gpu-lock.mjs run --exclusive -- node bench/run.mjs');`,
    `spawn('node scripts/gpu-lock.mjs run --exclusive --timing=frame-cost -- node frames.mjs');`,
    `// await acquire({mode:'exclusive'});\nconsole.log('ok');`,
  ])
    assert.deepEqual(policyViolations('scripts/view.mjs', source, new Set()), []);
  const source = `import {acquire} from './gpu-lock.mjs'; await acquire({mode:'exclusive'});`;
  assert.deepEqual(policyViolations('scripts/cost.mjs', source, new Set(['scripts/cost.mjs'])), []);
});

test('regex and interpolated templates cannot stall the scanner or conceal later requests', () => {
  const source =
    "const t = `value ${ /^([a-zA-Z][\\w-]*)?(?:#([\\w-]+))?/.test('x') } end`;\n" +
    "spawn('node scripts/gpu-lock.mjs run --exclusive -- npm run verify');";
  assert.equal(policyViolations('scripts/view.mjs', source, new Set()).length, 1);
});

test('the tracked repository passes and verify runs the class check before building', { timeout: 60_000 }, () => {
  assert.deepEqual(checkGpuPolicy(), []);
  const verify = readFileSync(new URL('../scripts/verify.mjs', import.meta.url), 'utf8');
  assert.ok(verify.indexOf("'node scripts/check-gpu-policy.mjs'") < verify.indexOf("'npm run build:packages'"));
  assert.match(verify, /'node scripts\/check-gpu-policy\.mjs'/);
});
