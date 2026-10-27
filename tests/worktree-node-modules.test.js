// scripts/worktree-node-modules.mjs once linked every entry of the main checkout's node_modules into each worktree,
// Vite's dependency cache `.vite` included. Every worktree's dev server then shared one cache: one re-optimized the
// dependencies while another was serving them, that page got 504 "Outdated Optimize Dep" for
// node_modules/.vite/deps/react_jsx-runtime.js, its module graph never ran, and modern:test:browser (and its
// slow-compile run) timed out waiting for window.modern (2026-10-27, check:merge in two worktrees).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedEntries } from '../scripts/worktree-node-modules.mjs';

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
