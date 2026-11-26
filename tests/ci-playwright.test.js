// CI installs browsers with the repository's Playwright (`npx playwright install chromium`); a fixture that installs
// Playwright itself must take that same version, or it asks for a browser build CI never fetched. The bundler matrix
// took npm's latest and failed "End-user proof on Node 22" (PR 68, job 139720307968) wanting chromium-headless-shell
// 1255 beside the 1248 CI had installed (KB-CI-PWVERSION1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoPlaywright } from '../scripts/support/playwright-version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const version = (name) => JSON.parse(read(`node_modules/${name}/package.json`)).version;

test('the pinned Playwright is the one whose browsers npx playwright install fetches', () => {
  const pinned = repoPlaywright(root);
  assert.equal(pinned, version('playwright-core'), 'npx playwright install runs playwright-core');
  assert.equal(pinned, version('@playwright/test'));
});

test('the fixtures that install Playwright take the pinned version, not npm latest or a range', () => {
  const matrix = read('scripts/bundler-matrix.mjs');
  const tools = /const tools = \[([\s\S]*?)\];/.exec(matrix)?.[1] ?? '';
  assert.ok(tools, 'the bundler matrix lists the tools it resolves from npm');
  assert.doesNotMatch(tools, /['"]playwright['"]/, 'Playwright is not resolved to npm latest');
  assert.match(matrix, /playwright: repoPlaywright\(root\)/);
  assert.match(read('scripts/modern-package-tests.js'), /'@playwright\/test': repoPlaywright\(/);
});

test('CI installs browsers through the repository Playwright', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const [, command] of ci.matchAll(/run: (.*playwright install.*)$/gm))
    assert.match(command, /^npx playwright install\b/, `${command}: use the installed Playwright`);
});
