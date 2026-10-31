// scripts/worktree-node-modules.mjs once linked every entry of the main checkout's node_modules into each worktree,
// Vite's dependency cache `.vite` included. Every worktree's dev server then shared one cache: one re-optimized the
// dependencies while another was serving them, that page got 504 "Outdated Optimize Dep" for
// node_modules/.vite/deps/react_jsx-runtime.js, its module graph never ran, and modern:test:browser (and its
// slow-compile run) timed out waiting for window.modern (2026-10-27, check:merge in two worktrees).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedEntries, missingDependencies } from '../scripts/worktree-node-modules.mjs';

test('a worktree links the installed packages and .bin, never a tool cache or its own packages', () => {
  assert.deepEqual(
    linkedEntries([
      '.bin',
      '.cache',
      '.package-lock.json',
      '.vite',
      '.vite-temp',
      '@margoengine',
      '@playwright',
      'margoengine',
      'react',
      'vite',
    ]),
    ['.bin', '@playwright', 'react', 'vite'],
  );
});

// physics2d's tests failed with "Cannot find package '@dimforge/rapier2d-compat'": root devDependencies and the lock file
// name it, so a clean install has it, but a worktree links the main checkout's older install and nothing said so.
test('a dependency the main checkout has not installed is named, and the engine packages are not asked for', () => {
  const manifest = {
    dependencies: { present: '1', margoengine: '1' },
    devDependencies: { '@dimforge/rapier2d-compat': '1', '@margoengine/core': '1' },
  };
  assert.deepEqual(
    missingDependencies(manifest, (name) => name === 'present'),
    ['@dimforge/rapier2d-compat'],
  );
  assert.deepEqual(
    missingDependencies(manifest, () => true),
    [],
  );
});
