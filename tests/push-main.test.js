import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockReason } from '../scripts/push-main.mjs';

const clean = { inProgress: null, unmerged: [], markers: [], containsUpstream: true };

test('push:main pushes only a clean HEAD that contains origin/main', () => {
  assert.equal(blockReason(clean), null);
});

test('push:main refuses while a rebase, merge, cherry-pick or revert is stopped', () => {
  for (const kind of ['rebase', 'merge', 'cherry-pick', 'revert'])
    assert.match(blockReason({ ...clean, inProgress: kind }), new RegExp(`a ${kind} is in progress`));
});

test('push:main refuses unmerged files, conflict markers and a HEAD behind origin/main', () => {
  assert.match(blockReason({ ...clean, unmerged: ['docs/api-surface.md'] }), /unmerged files: docs\/api-surface\.md/);
  assert.match(blockReason({ ...clean, markers: ['scripts/quality/baselines/sizes.json'] }), /conflict markers in/);
  assert.match(blockReason({ ...clean, containsUpstream: false }), /does not contain origin\/main/);
});
