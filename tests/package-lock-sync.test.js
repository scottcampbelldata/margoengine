// ec2429404: a workspace's package.json moved dependencies while the lock kept the old set, so `npm install` rewrote the
// lock in every checkout and `npm ci` could refuse it. 29b4a5cea did it again with an optional peer (fixed in
// 991322178c); the check now runs in hygiene, which the fast gate runs before every push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertLockInSync, lockProblems } from '../scripts/support/lock-sync.mjs';

const root = resolve(import.meta.dirname, '..');
const manifests = (map) => (path) => map[path] ?? null;
const rootJson = { name: 'r', workspaces: ['packages/a'], devDependencies: { x: '^1.0.0' } };
const lockRoot = { name: 'r', workspaces: ['packages/a'], devDependencies: { x: '^1.0.0' } };

test('package-lock.json lists each workspace with the dependencies of its package.json', () => {
  assert.doesNotThrow(() => assertLockInSync(root));
});

test('a peer added to package.json but not to the lock is reported (29b4a5cea)', () => {
  const a = {
    peerDependencies: { '@m/core': '^1.0.0', '@m/compute': '^1.0.0' },
    peerDependenciesMeta: { '@m/compute': { optional: true } },
  };
  const lock = { packages: { '': lockRoot, 'packages/a': { peerDependencies: { '@m/core': '^1.0.0' } } } };
  assert.deepEqual(lockProblems(lock, manifests({ '': rootJson, 'packages/a': a })), [
    'packages/a peerDependencies @m/compute: package.json ^1.0.0, lock undefined',
    'packages/a optional peers: package.json [@m/compute], lock []',
  ]);
});

test('an optional flag that differs is reported even when the peer ranges match', () => {
  const a = { peerDependencies: { b: '^1.0.0' }, peerDependenciesMeta: { b: { optional: true } } };
  const lock = { packages: { '': lockRoot, 'packages/a': { peerDependencies: { b: '^1.0.0' } } } };
  assert.deepEqual(lockProblems(lock, manifests({ '': rootJson, 'packages/a': a })), [
    'packages/a optional peers: package.json [b], lock []',
  ]);
});

test('root dependencies and a workspace missing from the lock are reported', () => {
  const lock = { packages: { '': { ...lockRoot, devDependencies: { x: '^0.9.0' } } } };
  assert.deepEqual(lockProblems(lock, manifests({ '': rootJson, 'packages/a': {} })), [
    '(root) devDependencies x: package.json ^1.0.0, lock ^0.9.0',
    'packages/a: workspace missing from the lock',
  ]);
});

test('a matching lock passes; key order and non-optional meta do not matter', () => {
  const a = { dependencies: { b: '1', c: '2' }, peerDependenciesMeta: { d: { optional: false } } };
  const lock = { packages: { '': lockRoot, 'packages/a': { dependencies: { c: '2', b: '1' } } } };
  assert.deepEqual(lockProblems(lock, manifests({ '': rootJson, 'packages/a': a })), []);
});

test('hygiene runs the lock check, so the fast gate fails on a stale lock', () => {
  assert.match(readFileSync(resolve(root, 'scripts/hygiene.js'), 'utf8'), /assertLockInSync\(root\);/);
});
