import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

// private/ is git-excluded (agents' handoffs, queue and control files): a tracked file that sends a reader there sends
// them to a path that does not exist in a clone. Files that handle those folders themselves are listed with the reason.
const MAY_NAME_PRIVATE = new Map([
  ['AGENTS.md', 'the agents’ own rules name the queue and control files'],
  ['docs/architecture/operational-playbook.md', 'the playbook names the folders agents write to'],
  ['scripts/session-start.mjs', 'reads private/control.json'],
  ['scripts/support/result-cache.mjs', 'excludes private/ from the tree it hashes'],
  ['tests/file-classes.test.js', 'classifies private/ as an inert path'],
  ['tests/no-private-paths.test.js', 'this test'],
  ['packages/fbx/test/loading-materials.test.js', 'file:///private/ is a URL under test'],
]);

test('no tracked file points at a private/ path, except the ones that handle those folders', () => {
  const found = execFileSync('git', ['grep', '-l', '-I', '-E', '(^|[^A-Za-z0-9_./-])private/', '--', '.'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((file) => !MAY_NAME_PRIVATE.has(file) && !file.startsWith('api/'));
  assert.deepEqual(found, [], 'reword the pointer without the private/ path (the file is not in a clone)');
});
