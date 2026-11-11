// check:gpu-packages refuses to plan when a browser test file has no script that runs it. Four such files reached main
// on 2026-11-10 (culling compat-cost, loaders split-scale-check, points scale-check, terrain planet-recipes) because
// only the full check planned the suites; hygiene, which the fast gate runs on every push, now plans them too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { plan } from '../scripts/gpu-package-tests.mjs';

test('every browser test file in the repository is run by a GPU suite script', () => {
  const tests = plan();
  const ids = new Set(tests.map((t) => `${t.dir}/${t.script}`));
  for (const id of ['loaders/test:gpu:split-scale', 'points/test:gpu:scale']) assert.ok(ids.has(id), id);
  const terrain = tests.find((t) => t.dir === 'terrain' && t.script === 'test:gpu');
  assert.match(terrain.command, /planet-recipes\.browser\.mjs/);
});

test('hygiene plans the GPU suites before its scored gates', () => {
  const hygiene = readFileSync(new URL('../scripts/hygiene.js', import.meta.url), 'utf8');
  assert.match(hygiene, /\r?\ngpuPlan\(\);\r?\nconst quick/);
});
