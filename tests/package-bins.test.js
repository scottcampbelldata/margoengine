// Every package's bin script checks out with LF endings (.gitattributes). npm rewrites a bin's CRLF shebang line to LF
// when it links it, so a CRLF checkout (core.autocrlf on Windows) came back modified after every npm ci, which stopped
// scripts/land-records.mjs ("needs a clean tree") inside the landing lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';

const root = new URL('..', import.meta.url),
  rootPath = decodeURIComponent(root.pathname).replace(/^\/([A-Za-z]:)/, '$1');

test('package bin scripts are checked out with LF endings', () => {
  const bins = [];
  for (const dir of readdirSync(join(rootPath, 'packages'))) {
    const file = join(rootPath, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const { bin } = JSON.parse(readFileSync(file, 'utf8'));
    for (const target of typeof bin === 'string' ? [bin] : Object.values(bin ?? {}))
      bins.push(posix.join('packages', dir, target));
  }
  assert.ok(bins.length > 0, 'at least one package has a bin (packages/mcp)');
  const out = execFileSync('git', ['check-attr', 'eol', '--', ...bins], { cwd: rootPath, encoding: 'utf8' });
  for (const bin of bins) assert.match(out, new RegExp(`^${bin.replaceAll('.', '\\.')}: eol: lf$`, 'm'), bin);
});
