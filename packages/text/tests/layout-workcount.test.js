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
  assert.equal(bytes, 387896);
  assert.equal(hash.digest('hex'), 'b671ae6317ed56c5fc4a7dfc9681af9327008300d9e28b2844bd90e8f9c99dcf');
});

test('measurer edits between calls are visible', () => {
  const { measurer } = measured();
  const before = layoutText('AVATAR', {}, measurer);
  measurer.advance = () => 2;
  const after = layoutText('AVATAR', {}, measurer);
  assert.notDeepEqual(after, before);
  assert.equal(after.glyphs[0].advance, 2);
});
