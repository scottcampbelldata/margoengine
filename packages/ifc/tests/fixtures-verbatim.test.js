// Licensed test data that may only be redistributed unmodified (CC BY-ND 4.0: the buildingSMART BCF-XML and IDS test
// cases) lives in a fixture folder with a NOTICE.md table naming each file and its SHA-256. Tests read these files and
// never write them; this test fails when a file is edited, added without a row, or missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const fixtures = new URL('./fixtures/', import.meta.url);
const folders = readdirSync(fixtures).filter(
  (name) =>
    statSync(new URL(name, fixtures)).isDirectory() && readdirSync(new URL(`${name}/`, fixtures)).includes('NOTICE.md'),
);

test('verbatim licensed fixtures keep the SHA-256 their NOTICE.md records', () => {
  assert.ok(folders.includes('bcf'), 'the BCF test cases have a NOTICE.md');
  for (const folder of folders) {
    const root = new URL(`${folder}/`, fixtures);
    const notice = readFileSync(new URL('NOTICE.md', root), 'utf8');
    assert.match(notice, /verbatim/, `${folder}/NOTICE.md states the files are verbatim`);
    const rows = new Map();
    for (const [, file, hash] of notice.matchAll(/^\| ([^|]+?) \|[^\n]*\| `([0-9a-f]{64})` \|$/gm))
      rows.set(file, hash);
    const files = [];
    const walk = (dir, prefix) => {
      for (const name of readdirSync(dir)) {
        const path = new URL(name, dir);
        if (statSync(path).isDirectory()) walk(new URL(`${name}/`, dir), `${prefix}${name}/`);
        else if (`${prefix}${name}` !== 'NOTICE.md') files.push(`${prefix}${name}`);
      }
    };
    walk(root, '');
    assert.deepEqual(
      [...rows.keys()].sort(),
      files.sort(),
      `${folder}/NOTICE.md lists exactly the files in the folder`,
    );
    for (const file of files) {
      const hash = createHash('sha256')
        .update(readFileSync(new URL(file, root)))
        .digest('hex');
      assert.equal(hash, rows.get(file), `${folder}/${file} was changed; licensed test files are kept verbatim`);
    }
  }
});
