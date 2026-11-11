import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { layoutText } from '../dist/index.js';
import { texts, variants, measured, layoutBytes } from './layout-workcount-corpus.js';

test('logical kerning is reused for unchanged visual neighbors', () => {
  const { measurer, calls } = measured();
  layoutText('AVATAR'.repeat(100), {}, measurer);
  assert.equal(calls.kern, 599); // Parent: 1198, the same pairs measured twice.
  assert.equal(calls.advance, 600);
});

test('a shaped prefix is measured once and reused for its caret', () => {
  const { measurer, calls } = measured();
  layoutText('officeaffinewaffle', { ligatures: true }, measurer);
  assert.equal(calls.advance, 18); // Parent: 35, remeasuring the previous prefix.
  assert.equal(calls.kern, 0);
});

test('35 multilingual layouts retain every output byte from the parent', () => {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const text of texts)
    for (const options of variants) {
      const result = layoutBytes(layoutText(text, options, measured().measurer));
      bytes += result.length;
      hash.update(result);
    }
  // Re-recorded 2026-11-10 (batch 132 audit, lane I): UAX #9 weak types moved '(123)' next to the Hebrew in
  // 'abc \u05d0\u05d1\u05d2 (123) xyz' (variants 0, 1 and 4), as the annex's rules N0 and N1 require. Was 387896 bytes,
  // b671ae63...; every other layout is unchanged (text.test.js holds the bidi cases).
  // Re-recorded 2026-11-11 (batch 132b, lane N): levels are now resolved over the paragraph (UAX #9 section 3.4), so
  // in variant 2 (maxWidth 3.7, justify) the wrapped line '(123) ' of that same text follows the Hebrew on the line
  // above: W7 keeps 123 a European number, N0 gives the brackets R, and the line runs right to left. The drawn
  // characters are the same; their rtl flags and x positions moved. Every other layout is unchanged. Was 387926 bytes, 7e59f19a....
  assert.equal(bytes, 387924);
  assert.equal(hash.digest('hex'), 'b8ff0196b13302d1bd613e422ab0a8d24a34e120defd6bdbb7fa32c7c42b6144');
});

test('measurer edits between calls are visible', () => {
  const { measurer } = measured();
  const before = layoutText('AVATAR', {}, measurer);
  measurer.advance = () => 2;
  const after = layoutText('AVATAR', {}, measurer);
  assert.notDeepEqual(after, before);
  assert.equal(after.glyphs[0].advance, 2);
});
