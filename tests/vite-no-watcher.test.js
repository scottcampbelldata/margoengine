// c73ef5d84: a Vite dev server's file watcher crawled the repository, every worktree under it included, and blocked the
// process that serves the pages for 30 to 140 s: the visual check's "Preparing the citadel..." hang.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('every Vite dev server a script under scripts/ starts runs with no file watcher', () => {
  const root = new URL('../', import.meta.url),
    files = execFileSync('git', ['ls-files', 'scripts'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/),
    bad = files.filter((file) => {
      if (!/\.m?js$/.test(file)) return false;
      const text = readFileSync(new URL(file, root), 'utf8');
      if (!/import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*['"]vite['"]/.test(text)) return false;
      return (text.match(/\bcreateServer\(/g) ?? []).length > (text.match(/watch: null/g) ?? []).length;
    });
  assert.deepEqual(bad, [], 'add server: { watch: null }');
});
