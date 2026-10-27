// A file URL's `.pathname` is not a file path: it is percent-encoded and, on Windows, starts with '/C:'. geometry's
// tree-shake test imported `new URL('../dist/index.js', import.meta.url).pathname`, which resolved nowhere once the
// checkout sat under an 8.3 or spaced folder ('/C:/Users/%7E1/...'; the fresh-clone check clones into
// os.tmpdir()). Use fileURLToPath(). This catches the pattern anywhere in the repository's own scripts and tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('no file URL is used through .pathname as a path', () => {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '*.js', '*.mjs', '*.ts'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file && !file.includes('node_modules/') && !file.endsWith('file-url-paths.test.js'));
  const found = [];
  for (const file of files) {
    if (!existsSync(resolve(root, file))) continue; // tracked but deleted in the working tree
    const text = readFileSync(resolve(root, file), 'utf8');
    for (const [i, line] of text.split('\n').entries())
      if (/import\.meta\.url\)\.pathname|pathToFileURL\([^)]*\)\.pathname/.test(line)) found.push(`${file}:${i + 1}`);
  }
  assert.deepEqual(found, [], 'use fileURLToPath(url), not url.pathname, for a file path');
});
