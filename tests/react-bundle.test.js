// Bundler checks for the React package, from the built packages (no install, no GPU):
//   1. every "react-server" entry of the built package starts with 'use client', so Next.js server components may import it;
// Next.js (webpack and Turbopack) builds are in scripts/bundler-matrix.mjs, part of check:merge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const react = join(root, 'packages/react');

test('every react-server entry of the React package starts with "use client"', () => {
  const exports = JSON.parse(readFileSync(join(react, 'package.json'), 'utf8')).exports;
  const entries = Object.entries(exports).filter(([key]) => key !== './package.json');
  assert.ok(entries.length >= 5);
  for (const [key, value] of entries) {
    const file = join(react, typeof value === 'string' ? value : value['react-server']);
    assert.match(readFileSync(file, 'utf8'), /^['"]use client['"];?/, `${key} (${file}) must start with 'use client'`);
  }
});

test('the dist of the React package is free of side effects on import', () => {
  assert.equal(JSON.parse(readFileSync(join(react, 'package.json'), 'utf8')).sideEffects, false);
});
