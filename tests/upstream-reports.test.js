// Every upstream report folder holds a report.md draft in the bug-report format the README describes, and the
// README table lists exactly the folders on disk (KB1042f once shipped its repro page without the report).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../docs/upstream-reports/', import.meta.url);
const folders = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test('every upstream report folder has a report.md draft', () => {
  assert.ok(folders.length > 0);
  for (const folder of folders) {
    const file = new URL(`${folder}/report.md`, root);
    assert.ok(existsSync(file), `${folder} has no report.md`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^# \S/, `${folder}/report.md starts with a title`);
    assert.ok(text.split('\n').length > 5, `${folder}/report.md is more than a title`);
  }
});

test('the README table lists exactly the report folders', () => {
  const readme = readFileSync(new URL('README.md', root), 'utf8');
  const listed = [...readme.matchAll(/^\| (KB\w+) \| `(KB\w+)` \|/gm)].map(([, row, folder]) => {
    assert.equal(row, folder);
    return folder;
  });
  assert.deepEqual(listed.sort(), folders);
});
