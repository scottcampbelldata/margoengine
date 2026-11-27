// scripts/test-real-files.mjs once fetched every manifest file its cache lacked just by being run. It fetches only
// with --download now; without it, it names the missing files and opens nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const guard = pathToFileURL(resolve(root, 'tests/support/refuse-downloads.mjs')).href;
const script = resolve(import.meta.dirname, '../scripts/test-real-files.mjs');
const manifest = JSON.parse(readFileSync(new URL('./real-files/manifest.json', import.meta.url)));

test('the real-files check names every missing file and fetches none unless asked', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'margo-real-files-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const item = manifest.files.find((file) => !file.repo);
  const run = (...args) =>
    spawnSync(process.execPath, ['--import', guard, script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, REAL_FILES_DIR: folder, REAL_FILES_ONLY: item.id },
    });
  const plain = run();
  assert.equal(plain.error, undefined);
  assert.notEqual(plain.status, 0);
  assert.doesNotMatch(plain.stderr, /REFUSED/, plain.stderr);
  for (const file of [item, ...(item.companions ?? [])])
    if (!file.repo || !existsSync(resolve(root, file.repo)))
      assert.ok(plain.stderr.includes(join(folder, item.format, file.file)), `${file.file}: ${plain.stderr}`);
  assert.match(plain.stderr, /Nothing was fetched\. To fetch them, run: .*test:real-files.* --download/);
  assert.deepEqual(readdirSync(folder), []);
  // The flag is what reaches the network: the guard stops it there, and the row reports it.
  const asked = run('--download');
  assert.match(asked.stderr + asked.stdout, /REFUSED/);
});
