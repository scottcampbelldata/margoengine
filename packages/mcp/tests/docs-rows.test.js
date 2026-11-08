import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { repository } from './support.js';

// A rebase of the render_snippet commit once took the other side of docs/limits.md whole and dropped its row, and
// every check passed. Each optional entry of this package keeps its row in the limits page.
test('every optional entry of @margoengine/mcp has a row in docs/limits.md', () => {
  const pkg = JSON.parse(readFileSync(`${repository}/packages/mcp/package.json`, 'utf8'));
  const limits = readFileSync(`${repository}/docs/limits.md`, 'utf8');
  const entries = Object.keys(pkg.exports).filter((key) => key !== '.');
  assert.ok(entries.length >= 4);
  for (const entry of entries) {
    const name = `@margoengine/mcp/${entry.slice(2)}`;
    assert.match(limits, new RegExp(`^\\| [^|\\n]*\`${name}\``, 'm'), `${name} has no row in docs/limits.md`);
  }
});
