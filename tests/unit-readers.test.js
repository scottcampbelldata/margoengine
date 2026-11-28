// KB-GATE-DOCREADERS1: an edit to docs/limits.md or docs/whitepaper/claims.md ran no test in a lane's fast gate, so a
// broken claims row reached main twice (80ca93fe2c, f7a229b5ad) while tests/claims-file.test.js, which reads both
// documents, failed. `npm run hygiene` now runs the root tests that name a changed document in code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertDocumentReadersPass,
  templatePaths,
  unitReaders,
  withoutComments,
} from '../scripts/support/unit-readers.mjs';

const root = resolve(import.meta.dirname, '..');
const tests = (files) => unitReaders(root, files).map((r) => r.test);

test('an edit to docs/limits.md or docs/whitepaper/claims.md reaches tests/claims-file.test.js', () => {
  assert.ok(tests(['docs/limits.md']).includes('tests/claims-file.test.js'));
  assert.ok(tests(['docs/whitepaper/claims.md']).includes('tests/claims-file.test.js'));
  assert.ok(tests(['docs/whitepaper/claims.md']).includes('tests/public-truth.test.js'), 'every reader, not one');
});

// KB-GATE-READMEREADERS1: aad1fb5ee7 named exporters ./sparse in its README, so the owed list had to shrink, but the
// lane's gate ran no root test for the README and tests/package-readmes.test.js failed on main. That test reads every
// package README through a template literal path.
test('a package README edit reaches tests/package-readmes.test.js, which reads it through a template path', () => {
  assert.ok(tests(['packages/exporters/README.md']).includes('tests/package-readmes.test.js'));
  assert.ok(tests(['packages/humans/README.md']).includes('tests/package-readmes.test.js'));
});

test('a template literal path names a file only when its file name is written out', () => {
  const [readme, prefixed, upward] = templatePaths(
    'const a = `packages/${folder}/README.md`; const b = `${root}docs/${name}/notes.md`; const c = `../docs/${x}/a.md`;',
  );
  assert.ok(readme.test('packages/exporters/README.md'));
  assert.equal(readme.test('packages/exporters/src/README.md'), false, 'a placeholder is one segment');
  assert.equal(readme.test('docs/README.md'), false);
  assert.ok(
    prefixed.test('docs/guide/notes.md') && prefixed.test('x/docs/guide/notes.md'),
    'a leading placeholder is any prefix',
  );
  assert.ok(upward.test('docs/q/a.md'), 'a leading ../ is the repository root');
  assert.deepEqual(
    templatePaths('`${dir}/${name}.html` `${name} is in docs/known-bugs.md` `packages/${x}`'),
    [],
    'no written file name',
  );
});

test('a document no test names, and a file that is code, reach no test', () => {
  assert.deepEqual(tests(['docs/' + 'unnamed-' + 'document.md']), []);
  assert.deepEqual(
    tests(['packages/clustered/src/bounce.ts', 'scripts/cabin-hearth-browser-test.mjs']),
    [],
    'code has its own checks',
  );
  assert.deepEqual(tests([]), []);
});

test('a path in a comment is not a reader', () => {
  assert.equal(
    withoutComments("// docs/limits.md\nconst a = 'x';\n/* docs/limits.md */").includes('docs/limits.md'),
    false,
  );
  assert.equal(
    withoutComments("const u = 'https://x.test/docs/limits.md';").includes('https://x.test/docs/limits.md'),
    true,
    'a URL stays',
  );
  assert.equal(withoutComments("const f = 'docs/limits.md'; // read it").includes("'docs/limits.md'"), true);
});

test('a failing reader of a changed document fails the gate, naming the test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit-readers-'));
  try {
    mkdirSync(join(dir, 'tests'));
    writeFileSync(
      join(dir, 'tests', 'doc.test.js'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('doc row', () => assert.equal(1, 2));\n// docs/other.md\nconst file = 'docs/limits.md';\nconst key = 'limits.md';\n",
    );
    writeFileSync(
      join(dir, 'tests', 'quiet.test.js'),
      "import test from 'node:test';\ntest('quiet', () => {});\n// docs/limits.md only in a comment\n",
    );
    assert.deepEqual(unitReaders(dir, ['docs/limits.md']), [
      { test: 'tests/doc.test.js', documents: ['docs/limits.md'] },
    ]);
    assert.throws(
      () => assertDocumentReadersPass(dir, ['docs/limits.md'], { timeout: 60000 }),
      /tests\/doc\.test\.js[\s\S]*not ok \d+ - doc row/,
    );
    assert.deepEqual(assertDocumentReadersPass(dir, ['docs/unread.md']), [], 'a document nothing reads runs nothing');
    assert.deepEqual(
      unitReaders(dir, ['notes/limits.md']).map((r) => r.test),
      ['tests/doc.test.js'],
      'a quoted file name counts',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run hygiene, which every lane gate runs, runs the readers of the changed documents', () => {
  const hygiene = readFileSync(join(root, 'scripts', 'hygiene.js'), 'utf8');
  assert.match(hygiene, /import \{ assertDocumentReadersPass \} from '\.\/support\/unit-readers\.mjs';/);
  assert.match(hygiene, /^assertDocumentReadersPass\(root\);$/m);
});
