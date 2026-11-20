// KB-API-SURFACE-CHURN1: the entry size record (and so the Gzip column of docs/api-surface.md) must describe the
// sources, not whichever dist a tree last built. Every reader of dist first rebuilds the packages whose stamp is stale.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { measureEntries } from '../examples/package-benchmarks/entry-sizes.mjs';
import { BUILD_LOCK_DIR } from '../scripts/support/build-lock.mjs';
import { rebuildStalePackages } from '../scripts/support/fresh-dist.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'fresh-dist-'));

test('only the packages whose dist does not match their sources are rebuilt, under the build lock', () => {
  const root = temp();
  try {
    const built = [];
    const lines = [];
    const names = rebuildStalePackages(root, {
      label: 'Entry sizes',
      stale: () => ['cameras', 'vfx'],
      build: (stale) => {
        built.push(stale);
        assert.ok(existsSync(join(root, BUILD_LOCK_DIR)), 'the build runs holding the lock');
      },
      log: (line) => lines.push(line),
    });
    assert.deepEqual(names, ['cameras', 'vfx']);
    assert.deepEqual(built, [['cameras', 'vfx']]);
    assert.match(lines[0], /^Entry sizes: rebuilding 2 package\(s\)/);
    assert.equal(existsSync(join(root, BUILD_LOCK_DIR)), false, 'the lock is released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a current dist is left alone, and a failed build still releases the lock', () => {
  const root = temp();
  try {
    let builds = 0;
    assert.deepEqual(
      rebuildStalePackages(root, { stale: () => [], build: () => builds++, log: () => assert.fail('no message') }),
      [],
    );
    assert.equal(builds, 0);
    assert.throws(
      () =>
        rebuildStalePackages(root, {
          stale: () => ['a'],
          build: () => {
            throw new Error('build failed');
          },
          log: () => {},
        }),
      /build failed/,
    );
    assert.equal(existsSync(join(root, BUILD_LOCK_DIR)), false, 'the lock is released after a failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the entry size measurement makes the dist current before it reads any of it', async () => {
  const order = [];
  await assert.rejects(
    measureEntries({
      log: () => order.push('measured'),
      ensureFresh: () => {
        order.push('fresh');
        throw new Error('stop after the freshness step');
      },
    }),
    /stop after the freshness step/,
  );
  assert.deepEqual(order, ['fresh'], 'nothing is measured before the dist matches the sources');
});
