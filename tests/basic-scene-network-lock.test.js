import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'),
  script = readFileSync(join(root, 'scripts/basic-scene-network.mjs'), 'utf8');

/**
 * Every .js/.mjs/.cjs/.ts file under `dir`, without dependencies, build output, fixtures or worktrees. Nor the scratch
 * folders of the README check: a package's test makes and removes one while this walk runs beside it.
 */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|dist|fixtures|\.git|\.claude|\.tmp|test-results|results|\.readme-check-.*)$/.test(entry.name))
      continue;
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
  const settings = script.slice(lock).match(/^acquire\(\{([^}]+)\}/)?.[1];
  assert.match(settings, /\bmax:\s*1\b/, 'the short browser capture has a one-minute GPU hold limit');
  assert.match(settings, /\bwaitMax:\s*60\b/, 'queueing does not use a GPU slot');
});

test('completed capture relinquishes its browser before the final cleanup', async () => {
  const begin = script.indexOf('await context.close();');
  const finish = script.indexOf('releaseGpu();', begin);
  assert.ok(begin >= 0 && finish > begin);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const release = new AsyncFunction('context', 'browser', script.slice(begin, finish) + '\nreturn browser;');
  let closes = 0;
  const browser = {
    version: () => 'test-version',
    close: async () => {
      assert.equal(++closes, 1, 'an ended browser must never receive another close request');
    },
  };
  const remaining = await release({ close: async () => {} }, browser);
  // The real finally passes this remaining owner to closeAll, which closes it if present.
  if (remaining) await remaining.close();
  assert.equal(closes, 1);
});

test('the walk leaves out the scratch folder of a README check running beside it', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'walk-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, '.readme-check-AbC123'));
  writeFileSync(join(folder, '.readme-check-AbC123', 'readme-binding.d.ts'), '');
  assert.deepEqual(sources(folder), []);
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
