// The package test files need the Required external test assets (scripts/support/external-test-assets.mjs, outside
// the repository) and a Chromium for their browser cases. GitHub CI's test and Node 22 jobs had neither: "Missing
// Required test fixture" (gltf, environment, loaders) and "cannot start chromium" (ecs) on every run (PR 68, job
// 139720354973; KB-CI-FIXTURES1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const jobs = ci.split(/\n {2}(?=[a-z][\w-]*:\n)/).slice(1);
const runsPackageTests = (line) => /packages\/\*\/tests?\/\*\.test\.js|node22-tests\.mjs/.test(line);

test('the CI jobs that run the package tests are found', () => {
  const names = jobs.filter((job) => job.split('\n').some(runsPackageTests)).map((job) => job.split(':')[0]);
  assert.deepEqual(names.sort(), ['node22-tests', 'test']);
});

test('every CI job running the package tests fetches the external assets and a Chromium first', () => {
  const missing = [];
  for (const job of jobs) {
    const lines = job.split('\n');
    const at = lines.findIndex(runsPackageTests);
    if (at < 0) continue;
    const before = lines.slice(0, at).join('\n');
    const name = job.split(':')[0];
    if (!before.includes('node scripts/reference-rendering/fetch-skip-assets.mjs')) missing.push(`${name}: assets`);
    if (!/run: npx playwright install chromium\b/.test(before)) missing.push(`${name}: chromium`);
  }
  assert.deepEqual(missing, []);
});
