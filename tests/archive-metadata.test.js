import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { archiveMetadata } from '../scripts/support/archive-metadata.mjs';

test('native enumeration matches stat sizes, fractional/pre-epoch timestamps and Node listing order', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'archive metadata é-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, stamp] of [['equal-b.gz', 200], ['equal-a.gz', 200], ['space é.gz', 100.123456], ['old.gz', -10.125]]) {
    writeFileSync(join(dir, name), name);
    utimesSync(join(dir, name), stamp, stamp);
  }
  writeFileSync(join(dir, 'untouched.gz'), 'current fractional timestamp');
  writeFileSync(join(dir, 'ignored.gz.tmp'), 'not an archive');
  mkdirSync(join(dir, 'directory.gz'));
  const reference = archiveMetadata(dir, { platform: 'portable' });
  assert.deepEqual(archiveMetadata(dir), reference);
  assert.equal(reference.length, 6);
  assert.ok(reference.every(({ path, size, at }) => size === statSync(path).size && at === statSync(path).mtimeMs));
});

test('native inventory disappearance is still missing, and helper failures are never hidden', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-metadata-race-')),
    file = join(dir, 'gone.gz'),
    original = childProcess.execFileSync;
  t.after(() => {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(file, 'gone');
  childProcess.execFileSync = (program, args, options) => {
    assert.equal(program, 'powershell.exe');
    assert.equal(args.at(-1), dir);
    assert.equal(options.timeout, 60_000);
    assert.equal(options.windowsHide, true);
    rmSync(file);
    return '';
  };
  syncBuiltinESMExports();
  assert.deepEqual(archiveMetadata(dir, { platform: 'win32' }), []);
  writeFileSync(file, 'again');
  const failure = Object.assign(new Error('inventory failed'), { code: 'EIO' });
  childProcess.execFileSync = () => { throw failure; };
  syncBuiltinESMExports();
  assert.throws(() => archiveMetadata(dir, { platform: 'win32' }), (error) => error === failure);
});
