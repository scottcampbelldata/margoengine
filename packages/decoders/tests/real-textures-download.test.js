// scripts/test-real-textures.mjs once fetched every manifest file its folder lacked: a run on a folder holding only the
// KTX2 files downloaded 166 more that nobody had asked for. It fetches only with --download now.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const guard = pathToFileURL(resolve(root, 'tests/support/refuse-downloads.mjs')).href;
const script = resolve(import.meta.dirname, '../scripts/test-real-textures.mjs');
const manifest = JSON.parse(readFileSync(new URL('./real-files/manifest.json', import.meta.url)));

/** Runs the check with the network, other programs and every file write refused. */
const run = (...args) =>
  spawnSync(process.execPath, ['--import', guard, script, ...args], { encoding: 'utf8', timeout: 60_000 });

test('the texture check names every missing file and fetches none unless asked', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'margo-textures-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const plain = run(folder);
  assert.equal(plain.error, undefined);
  assert.notEqual(plain.status, 0);
  assert.doesNotMatch(plain.stderr, /REFUSED/, plain.stderr);
  for (const row of [...manifest.webp, ...manifest.dds, ...manifest.ktx2])
    assert.ok(plain.stderr.includes(join(folder, row.file)), `${row.file} is not named`);
  assert.match(plain.stderr, /Nothing was fetched\. To fetch them, run: .*test-real-textures\.mjs .* --download/);
  assert.deepEqual(readdirSync(folder), []);
  // The flag is what reaches the network; the guard stops it there.
  assert.match(run(folder, '--download').stderr, /REFUSED fetch/);
});

test('the texture check prints usage and refuses unknown arguments without doing work', () => {
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage:/i);
  for (const args of [[], ['one', 'two'], ['folder', '--no-such-flag']]) {
    const refused = run(...args);
    assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stderr}`);
    assert.doesNotMatch(refused.stderr, /REFUSED/);
    assert.match(refused.stderr, /usage:/i);
  }
});
