import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'),
  script = readFileSync(join(root, 'scripts/basic-scene-network.mjs'), 'utf8');

/** Every .js/.mjs/.cjs/.ts file under `dir`, without dependencies, build output, fixtures or worktrees. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|dist|fixtures|\.git|\.claude|\.tmp|test-results|results)$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.(m|c)?js$|\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

// Regression: basic-scene-network opened its preview server on port 5241 and then queued for the GPU lock. Queued
// behind an exclusive benchmark, it held the port for many minutes while selection's x-ray check, holding a GPU slot,
// waited 20 minutes for that port and failed check:merge.
test('basic-scene-network takes the GPU lock before its server port', () => {
  const lock = script.search(/\bacquire\(/),
    server = script.search(/\blistenWhenFree\(/);
  assert.ok(lock > 0 && server > 0, 'both calls are present');
  assert.ok(lock < server, 'acquire() comes before listenWhenFree()');
});

test('basic-scene-network has a server port no other script or suite uses', () => {
  const port = Number(script.match(/\bport = (\d+)/)?.[1]);
  assert.ok(Number.isInteger(port) && port > 1024, 'the port is a fixed constant');
  const users = ['scripts', 'packages', 'examples', 'tests', 'bench']
    .flatMap((dir) => sources(join(root, dir)))
    .filter((file) => !file.endsWith('basic-scene-network.mjs') && !file.endsWith('basic-scene-network-lock.test.js'))
    .filter((file) => new RegExp(`\\b${port}\\b`).test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(users, []);
});
