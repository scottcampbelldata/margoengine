// One attribute per value type, read from text and from Crate, against the values OpenUSD 26.11 reads back
// (tests/oracle/crate-types-truth.py, usd-core black-box). Before the fix three Crate types differed: an inlined int64
// came back as its unsigned low word (-5 as 4294967291), an inlined half2 as int8 bytes of its halves ([1, 2] as
// [0, 60]), and an asset[] array read its string-table indices as token indices.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const folder = new URL('./fixtures/crate-types/', import.meta.url),
  truth = JSON.parse(readFileSync(new URL('types.json', folder), 'utf8'));
const same = (a, b) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((x, i) => same(x, b[i]))
    : typeof a === 'number' && typeof b === 'number'
      ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))
      : a === b || (b === true && a === 1) || (b === false && a === 0);
const file = (value) => (typeof value === 'string' ? value.replace(/^.*\//, '') : value);

for (const root of ['types.usda', 'types.usdc'])
  test(`every value type of ${root} reads as OpenUSD reads it`, async () => {
    const { specs } = await composeUSDFiles(root, (id) =>
      /.usd[ac]$/.test(id) ? new Uint8Array(readFileSync(new URL(id, folder))) : undefined,
    );
    const differ = [];
    for (const [name, want] of Object.entries(truth)) {
      let got = specs['/A.' + name]?.fields.default;
      got = Array.isArray(got) ? got.map(file) : file(got);
      if (!same(got, want)) differ.push(`${name}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
    assert.deepEqual(differ, []);
  });
