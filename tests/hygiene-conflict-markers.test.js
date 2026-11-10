import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertNoConflictMarkers, conflictMarkers } from '../scripts/support/conflict-markers.mjs';

test('hygiene rejects tracked markers across text formats, including unchanged files', () => {
  const home = resolve(import.meta.dirname, '..', 'test-results');
  mkdirSync(home, { recursive: true });
  const root = mkdtempSync(join(home, 'hygiene-conflicts-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, timeout: 30_000 });
  const put = (file, text) => writeFileSync(join(root, file), text);
  try {
    git('init', '--quiet');
    mkdirSync(join(root, 'docs'));
    const formats = ['md', 'ts', 'js', 'json', 'mjs', 'wgsl', 'glsl'];
    for (const ext of formats)
      put(`tracked.${ext}`, `safe\r\n${'<'.repeat(7)} HEAD\r\n${'='.repeat(7)}\r\n${'>'.repeat(7)} branch\r\n`);
    put('docs/notes.txt', `${'>'.repeat(7)} branch\n`);
    put('safe.md', `inline ${'<'.repeat(7)} HEAD\n========\n =======\n`);
    put('binary.md', Buffer.from(`\0${'>'.repeat(7)} branch\n`));
    put('attribute.md', `${'>'.repeat(7)} branch\n`);
    put('large.md', `${'>'.repeat(7)} branch\n`);
    put('pointer.md', `version https://git-lfs.github.com/spec/v1\n${'>'.repeat(7)} branch\n`);
    put('.gitattributes', 'attribute.md -diff\nlarge.md filter=lfs\n');
    git('add', '--all');
    put('untracked.md', `${'>'.repeat(7)} branch\n`);
    const expected = [
      'docs/notes.txt:1',
      ...formats.flatMap((ext) => [2, 3, 4].map((line) => `tracked.${ext}:${line}`)),
    ].sort();
    assert.deepEqual(conflictMarkers(root).sort(), expected);
    assert.throws(() => assertNoConflictMarkers(root), /Unresolved conflict markers.*\n/s);
    for (const ext of formats) put(`tracked.${ext}`, 'resolved\n');
    put('docs/notes.txt', 'both entries preserved\n');
    assert.doesNotThrow(() => assertNoConflictMarkers(root));
    const hygiene = readFileSync(join(home, '..', 'scripts/hygiene.js'), 'utf8');
    assert.match(hygiene, /assertNoConflictMarkers\(root\);/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hygiene propagates conflict rejection before scored gates, in both modes', () => {
  const scanner = new URL('../scripts/support/conflict-markers.mjs', import.meta.url).href;
  const hygiene = new URL('../scripts/hygiene.js', import.meta.url).href;
  for (const args of [[], ['--verify']]) {
    const script = `
      import { mock } from 'node:test';
      mock.module(${JSON.stringify(scanner)}, {
        namedExports: { assertNoConflictMarkers() { throw new Error('conflict-regression-sentinel'); } }
      });
      process.argv.push(...${JSON.stringify(args)});
      await import(${JSON.stringify(hygiene)});
    `;
    const result = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflict-regression-sentinel/);
  }
});
