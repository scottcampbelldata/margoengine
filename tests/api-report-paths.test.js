// The API reports are compared across machines and worktrees, so they must never hold a file path. A namespace type
// import of another package (`import type * as GeometryModule from '@margoengine/geometry'` in react) resolves to that
// module's source-file symbol, whose name is its absolute path; api-report.js once printed it as a named import of
// that path, so every worktree produced a different report and api:check failed everywhere but the one that wrote it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const reports = readdirSync(join(root, 'api')).filter((file) => file.endsWith('.api.md'));

test('no API report holds a file path', () => {
  assert.ok(reports.length > 50);
  for (const file of reports) {
    const text = readFileSync(join(root, 'api', file), 'utf8');
    assert.doesNotMatch(
      text,
      /\b[A-Za-z]:[\\/](?![\\/])|\/(?:Users|home|tmp)\/|worktrees[\\/]|node_modules[\\/]/,
      `${file} holds a path`,
    );
  }
});

test('a namespace type import of another package is reported as `import * as`', () => {
  // The geometry shapes (`Box`, `Sphere`, `Plane`) live in @margoengine/react/geometry since 2026-10-27.
  const react = readFileSync(join(root, 'api', 'react.geometry.api.md'), 'utf8');
  assert.match(react, /^import \* as GeometryModule from "@margoengine\/geometry";$/m);
  assert.match(react, /type GeometryApi = typeof GeometryModule;/);
});
