import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ERROR_SOURCES, assertErrorPageCurrent, errorPageFindings } from '../scripts/errors/check.mjs';

// margoengine.com/errors (site/errors.html) and the coded throws come from one source; scripts/errors/check.mjs keeps
// them from drifting apart. Core, the stage, compute and sciviz (whose messages link to their #compute and #sciviz
// entries) go through the same checks, and so do ui, mcp, biomes and cache. `npm run hygiene` runs the same check, so
// every lane's fast gate catches an unlisted message, not only a lane that happens to run this root test (KB-ERR1).
const root = resolve(import.meta.dirname, '..');

test('the committed errors page, its entries and every linked throw agree', () => {
  const { findings, calls } = errorPageFindings(root);
  assert.deepEqual(findings, []);
  assert.ok(calls > 60, `found ${calls} throw sites`);
  assert.ok(ERROR_SOURCES.includes('packages/sciviz/src'));
});

test('core and stage throw only through the linked helpers', () => {
  for (const dir of ERROR_SOURCES)
    for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts'))) {
      const file = `${dir}/${name}`,
        text = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(
        text,
        /new (Error|TypeError|RangeError)\(/,
        `${file}: throw through fault, typeError or rangeError`,
      );
      assert.doesNotMatch(
        text,
        /\bmargoError\(/,
        `${file}: use fault(code, message, anchor) so the message links to its help`,
      );
    }
});

// KB-ERR1: packages/sciviz/src/link-layer.ts threw 'The layer and its drawn marks differ in count' under #sciviz
// without the page listing it; only this root test noticed, and the sciviz lane's gate never ran it.
test('an unlisted message, a missing anchor, a wrong code and a stale page are each reported', () => {
  const home = join(root, 'test-results');
  mkdirSync(home, { recursive: true });
  const dir = mkdtempSync(join(home, 'errors-check-'));
  try {
    mkdirSync(join(dir, 'packages/sciviz/src'), { recursive: true });
    mkdirSync(join(dir, 'site'));
    const entries = [
        { id: 'sciviz', kind: 'family', title: 't', messages: ['Listed'], cause: 'c', fix: 'f' },
        { id: 'state', kind: 'code', title: 't', messages: [], cause: 'c', fix: 'f' },
      ],
      page = '<p>page</p>\n';
    writeFileSync(join(dir, 'site/errors.html'), page.replace('\n', '\r\n'));
    writeFileSync(
      join(dir, 'packages/sciviz/src/a.ts'),
      "throw rangeError('Listed', 'sciviz');\nthrow fault('state', `dynamic ${x}`, 'sciviz');\n",
    );
    assert.deepEqual(errorPageFindings(dir, { entries, page }), { findings: [], calls: 2 });
    writeFileSync(
      join(dir, 'packages/sciviz/src/b.ts'),
      "throw rangeError('The layer and its drawn marks differ in count', 'sciviz');\n" +
        "throw rangeError('Listed', 'nowhere');\nthrow fault('sciviz', 'Listed');\n",
    );
    const { findings } = errorPageFindings(dir, { entries, page: '<p>new page</p>\n' });
    assert.equal(findings.length, 4, findings.join('\n'));
    assert.match(findings[0], /^site\/errors\.html differs/);
    assert.match(findings[1], /differ in count' is not listed under #sciviz/);
    assert.match(findings[2], /links to #nowhere/);
    assert.match(findings[3], /code 'sciviz' needs a code entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hygiene runs the errors page check, so the fast gate of every lane fails on drift', () => {
  const hygiene = readFileSync(join(root, 'scripts/hygiene.js'), 'utf8');
  assert.match(hygiene, /^assertErrorPageCurrent\(root\);\r?$/m);
  assert.doesNotThrow(() => assertErrorPageCurrent(root));
});

test('a thrown message ends with its help link', async () => {
  const { fault, typeError, rangeError } = await import('../packages/shared/errors.js');
  const error = fault('disposed', 'Mesh disposed');
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'disposed');
  assert.equal(error.message, 'Mesh disposed; see https://margoengine.com/errors#disposed');
  assert.equal(
    typeError('Invalid camera', 'arguments').message,
    'Invalid camera; see https://margoengine.com/errors#arguments',
  );
  assert.ok(rangeError('Invalid pick', 'views') instanceof RangeError);
});
