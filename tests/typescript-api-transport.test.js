// The repository scripts that start TypeScript 7's checker (scripts/hygiene.js gate 6, scripts/api-report.js) used the
// `typescript/unstable/sync` API. On Windows its client starts tsgo with a named pipe and gives it a fixed 500 tries of
// 10 ms to open it, with no option to change that; under verify's parallel load tsgo started later than that and
// `npm run quality` failed with "SyncRpcChannel: timed out connecting to named pipe" (reproduced by starving a new tsgo
// with high-priority busy loops on every core: the sync API failed after 11 s, the async API connected once the load
// ended). The async API talks to tsgo over its stdio and waits for the process, so its start has no fixed time limit;
// each step's own timeout still names a hang. This guards the class: no repository file uses the sync entry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const self = 'tests/typescript-api-transport.test.js';
// Files in git's index (committed or staged); a lane's untracked scratch is not the repository.
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(file) && file !== self && existsSync(join(root, file)));
const read = (file) => readFileSync(join(root, file), 'utf8');

test('no repository file starts the TypeScript checker through the sync API', () => {
  const users = tracked.filter((file) => read(file).includes('typescript/unstable/sync'));
  assert.deepEqual(
    users,
    [],
    'use typescript/unstable/async: the sync client times out starting tsgo on a busy machine',
  );
});

test('the hygiene and API report scripts use the async API', () => {
  for (const file of ['scripts/hygiene.js', 'scripts/api-report.js'])
    assert.match(read(file), /['"]typescript\/unstable\/async['"]/, file);
});

test('the installed async client starts tsgo over stdio, not the timed named-pipe channel', () => {
  const require = createRequire(join(root, 'package.json'));
  const client = join(dirname(require.resolve('typescript/package.json')), 'dist/api/async/client.js');
  const text = readFileSync(client, 'utf8');
  assert.doesNotMatch(text, /syncChannel|SyncRpcChannel/, 'a TypeScript bump changed the async transport');
  assert.match(text, /stdio:\s*\[\s*"pipe",\s*"pipe"/);
});
