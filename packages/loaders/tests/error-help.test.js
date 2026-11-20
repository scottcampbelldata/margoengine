import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LoaderError } from '../dist/index.js';
import { entries } from '../../../scripts/errors/entries.js';

// KB-LOADERR-help: every LoaderError code ends its message with a link to an entry on margoengine.com/errors.
const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const union = types.match(/export type LoaderErrorCode =([^;]+);/)[1];
const codes = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]);
const page = readFileSync(new URL('../../../site/errors.html', import.meta.url), 'utf8');

test('the source lists every loader error code', () => {
  assert.deepEqual(codes.toSorted(), ['aborted', 'fetch', 'header', 'limit', 'range', 'syntax', 'truncated', 'unsupported', 'url', 'zip']);
});

for (const code of codes) {
  test(`LoaderError '${code}' ends with a help link to an existing errors page anchor`, () => {
    const error = new LoaderError('STL', code, 'something went wrong');
    assert.equal(error.code, code);
    assert.equal(error.format, 'STL');
    const message = `STL: something went wrong; see https://margoengine.com/errors#loader-${code}`;
    assert.equal(error.message, message);
    assert.equal(error.message.split('margoengine.com/errors').length, 2, 'the link appears once');
    const anchor = error.message.match(/errors#([a-z-]+)$/)[1];
    assert.ok(page.includes(`<section id="${anchor}">`), `site/errors.html has no #${anchor}`);
    const entry = entries.find((e) => e.id === anchor);
    assert.ok(entry && entry.cause.length > 40 && entry.fix.length > 40, `entry ${anchor} explains the cause and the fix`);
  });
}
