// erosion-dem.mjs once fetched its 64 elevation tiles just by being run. It fetches only with --download now.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const guard = pathToFileURL(resolve(root, 'tests/support/refuse-downloads.mjs')).href;
const script = resolve(import.meta.dirname, 'erosion-dem.mjs');
const manifest = JSON.parse(readFileSync(new URL('./fixtures/erosion-dem.json', import.meta.url)));

test('the elevation check names every missing tile and fetches none unless asked', (t) => {
  // The check keeps its tiles under the folder it is run from.
  const folder = mkdtempSync(join(tmpdir(), 'margo-dem-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync(process.execPath, ['--import', guard, script, ...args], {
      cwd: folder,
      encoding: 'utf8',
      timeout: 60_000,
    });
  const plain = run();
  assert.equal(plain.error, undefined);
  assert.notEqual(plain.status, 0);
  assert.doesNotMatch(plain.stderr, /REFUSED/, plain.stderr);
  for (const tile of manifest.tiles) assert.ok(plain.stderr.includes(tile.url), `${tile.url} is not named`);
  assert.match(plain.stderr, /Nothing was fetched\. To fetch them, run: .*erosion-dem\.mjs --download/);
  assert.deepEqual(readdirSync(folder), []);
  assert.match(run('--download').stderr, /REFUSED fetch/);
});
