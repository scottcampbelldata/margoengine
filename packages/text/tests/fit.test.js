import test from 'node:test';
import assert from 'node:assert/strict';
import { fitText, FittedText } from '@margoengine/text/fit';
import { Font, Text, caretRect, hitTest } from '../dist/index.js';

const measure = { advance: s => [...s].length * 0.5, kerning: () => 0, metrics: () => ({ ascent: 0.8, descent: 0.2 }) };
test('clamps wrapped lines with a measured marker and source offsets', () => {
  const l = fitText('abcd efgh ijkl', { maxWidth: 2, maxLines: 2 }, measure);
  assert.equal(l.lines.length, 2);
  assert.equal(l.displayText, 'abcd efg\u2026');
  assert.equal(l.text, 'abcd efgh ijkl');
  assert.equal(l.truncated, true);
  assert.ok(l.bounds.right <= 2);
  assert.ok(l.glyphs.every(g => g.index + g.length <= l.visibleEnd));
});
test('auto-fit chooses the largest fitting size within bounds before truncating', () => {
  const l = fitText('abcd', { maxWidth: 3, maxHeight: 2, autoFit: true, minFontSize: 0.2, maxFontSize: 4 }, measure);
  assert.ok(Math.abs(l.fontSize - 1.5) < 1e-8);
  assert.equal(l.fits, true);
  assert.equal(l.truncated, false);
  assert.equal(fitText('a', { maxWidth: 50, autoFit: true, maxFontSize: 3 }, measure).fontSize, 3);
});
test('handles explicit paragraphs, zero visible lines, no marker and impossible marker', () => {
  assert.equal(fitText('abc\ndef', { maxLines: 1 }, measure).displayText, 'abc\u2026');
  assert.equal(fitText('abc\ndef', { maxLines: 1, ellipsis: false }, measure).displayText, 'abc');
  assert.equal(fitText('abc', { maxHeight: 0.1 }, measure).lines.length, 0);
  assert.equal(fitText('abc', { maxWidth: 0.1, whiteSpace: 'nowrap' }, measure).displayText, '');
});
test('keeps graphemes intact and puts the ellipsis at the RTL logical end', () => {
  const l = fitText('e\u0301\ud83d\ude00abcd', { maxWidth: 2, whiteSpace: 'nowrap' }, measure);
  assert.ok(!/\ud83d$/.test(l.displayText));
  const rtl = fitText('\u05d0\u05d1\u05d2\u05d3\u05d4', { maxWidth: 2, whiteSpace: 'nowrap', direction: 'rtl' }, measure);
  assert.equal(rtl.glyphs[0].cluster, '\u2026');
});
test('clips are local metadata and invalid inputs have coded linked errors', () => {
  assert.deepEqual(fitText('abc', { clipRect: [0, -1, 1, 0] }, measure).clipRect, [0, -1, 1, 0]);
  for (const options of [{ maxLines: 0 }, { maxLines: 1.2 }, { minFontSize: NaN }, { minFontSize: 2, maxFontSize: 1 }, { clipRect: [1, 0, 0, 1] }]) {
    assert.throws(() => fitText('a', options, measure), e => e.code === 'failed' && /https:/.test(e.message));
  }
});
test('FittedText is a renderer member and invalidates on bounds, font and text changes', () => {
  const font = new Font();
  font.advance = measure.advance; font.kerning = measure.kerning; font.metrics = measure.metrics;
  const t = new FittedText({ text: 'abcdefgh', font, maxWidth: 2, maxLines: 1 });
  assert.ok(t instanceof Text);
  const first = t.layout;
  assert.equal(t.layout, first);
  const revision = t.layoutVersion;
  t.maxWidth = 4;
  assert.equal(t.layout.truncated, false);
  assert.ok(t.layoutVersion > revision);
  t.text = 'abc';
  assert.equal(t.layout.text, 'abc');
});

test('empty fitted blocks have stable caret and hit testing', () => {
  const l = fitText('abc', { maxHeight: 0.1 }, measure);
  assert.equal(hitTest(l, 0, 0), 0);
  assert.deepEqual(caretRect(l, 1), { x: 0, top: 0, bottom: 0, line: 0 });
});
