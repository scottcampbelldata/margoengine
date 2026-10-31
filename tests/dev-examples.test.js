// `npm run dev:examples` from a checkout reached through a Windows short (8.3) path served every page as 403 "outside of
// Vite serving allow list" (docs/known-bugs.md, fixed 2026-10-31): Vite compared the directory as given with each
// file's real path. scripts/dev-examples.mjs starts Vite in the real path. This runs the package.json command's script
// from the short path, and checks a file outside the repository is still refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serverUrl } from '../scripts/support/server-url.mjs';

const root = realpathSync.native(resolve(import.meta.dirname, '..'));
const shortPath = () =>
  execFileSync('cmd', ['/c', 'for %I in (.) do @echo %~sI'], { cwd: root, encoding: 'utf8' }).trim();

test('package.json starts dev:examples through the wrapper', () => {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['dev:examples'];
  assert.match(script, /^node scripts\/dev-examples\.mjs\b/);
});

test('serves a page from a short-path working directory and still refuses a file outside the repository', async (t) => {
  const windows = process.platform === 'win32',
    cwd = windows ? shortPath() : root;
  if (windows) assert.notEqual(cwd.toLowerCase(), root.toLowerCase(), 'the working directory is the 8.3 name');
  const outside = mkdtempSync(join(tmpdir(), 'dev-examples-')),
    secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'outside');
  const child = spawn(process.execPath, [join(root, 'scripts/dev-examples.mjs'), '--port', '0'], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    if (windows) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
    rmSync(outside, { recursive: true, force: true });
  });
  const { url } = await serverUrl(child, {
    pattern: /Local:\s+(http:\/\/\S+?)\/?\s/,
    name: 'dev:examples',
    ms: 60_000,
  });
  const page = await fetch(`${url}/packages/netcode/examples/arena/`);
  assert.equal(page.status, 200, 'an example page is served');
  const file = await fetch(`${url}/@fs/${secret.replaceAll(String.fromCharCode(92), '/')}`);
  assert.equal(file.status, 403, 'a file outside the repository is refused');
});
