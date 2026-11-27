import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A Vite test server keeps an HMR websocket nothing uses; when the OS refuses the socket the page logs console
// errors and the test fails (known-bugs: Vite test servers keep the HMR socket). scripts/browser.js keeps its
// socket on purpose (it counts full reloads) and is outside packages/, so this sweep never reaches it.
test('every package script that starts a Vite server turns HMR off', () => {
  const root = new URL('..', import.meta.url);
  const files = execFileSync('git', ['ls-files', 'packages/*.js', 'packages/*.mjs'], {
    maxBuffer: 2 ** 28,
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const bad = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(new URL(file, root), 'utf8');
    if (!/import\s*\{[^}]*\bcreateServer\b(?!\s+as)[^}]*\}\s*from\s*['"]vite['"]/.test(source)) continue;
    checked++;
    const calls = source.match(/\bcreateServer\s*\(/g)?.length ?? 0;
    const off = source.match(/\bhmr:\s*false\b/g)?.length ?? 0;
    if (off < calls) bad.push(file);
  }
  assert.ok(checked > 40, `expected the sweep to find the package Vite test servers, found ${checked}`);
  assert.deepEqual(bad, [], "add hmr: false to the script's server options");
});
