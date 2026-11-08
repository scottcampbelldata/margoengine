import test from 'node:test';
import assert from 'node:assert/strict';
import { Label, Panel, Ui } from '../dist/index.js';
import { makeUi, near } from './helpers.js';

const ink = (layout) => layout.glyphs.filter((g) => !g.whitespace).map((g) => g.cluster);

test('Arabic and Indic words reach the renderer as whole shaped runs, not letter by letter', () => {
  const ui = makeUi();
  // Each Arabic word is one run, so the browser's shaper picks the joined letter forms. Glyphs come in visual order,
  // left to right, so the right-to-left line lists its second word first.
  assert.deepEqual(ink(ui.textLayout('مرحبا بالعالم', 'body')), ['بالعالم', 'مرحبا']);
  // Devanagari conjuncts and vowel signs: one run per word.
  assert.deepEqual(ink(ui.textLayout('नमस्ते दुनिया', 'body')), ['नमस्ते', 'दुनिया']);
  // Tamil and Bengali are Indic too.
  assert.equal(ink(ui.textLayout('வணக்கம்', 'body')).length, 1);
  assert.equal(ink(ui.textLayout('নমস্কার', 'body')).length, 1);
  // Latin stays one cluster per letter unless ligatures are on.
  assert.equal(ink(ui.textLayout('office', 'body')).length, 6);
});

test('ligatures: true shapes Latin words as runs too, so fi and fl join where the font has them', () => {
  const ui = makeUi({ ligatures: true });
  assert.deepEqual(ink(ui.textLayout('office flow', 'body')), ['office', 'flow']);
  assert.equal(ui.ligatures, true);
  ui.ligatures = false;
  assert.equal(ink(ui.textLayout('office flow', 'body')).length, 10, 'switching it off lays the text out again');
  assert.throws(() => makeUi({ ligatures: 'yes' }), TypeError);
});

test('right-to-left text: start means the right edge, and the paragraph direction comes from the text', () => {
  const ui = makeUi();
  assert.equal(ui.textDirection('مرحبا'), 'rtl');
  assert.equal(ui.textDirection('Hello مرحبا'), 'ltr');
  assert.equal(ui.textDirection('שלום'), 'rtl', 'Hebrew too');
  assert.equal(ui.textDirection('...'), 'ltr', 'no strong character: left to right');
  const arabic = new Label({ text: 'مرحبا', width: 300 }),
    english = new Label({ text: 'Hello', width: 300 });
  ui.add(new Panel({ anchor: 'top-left', children: [arabic, english] }));
  ui.update(0);
  const list = ui.draw();
  const texts = list.commands.filter((c) => c.type === 'text');
  const right = (c) => c.x / list.scale + c.layout.bounds.right,
    left = (c) => c.x / list.scale + c.layout.bounds.left;
  near(right(texts[0]), arabic.rect.x + arabic.rect.width, 'the Arabic label sits at the right edge of its box');
  near(left(texts[1]), english.rect.x, 'the English label sits at the left edge');
  arabic.align = 'end';
  ui.update(0);
  const moved = ui.draw().commands.filter((c) => c.type === 'text')[0];
  near(left(moved), arabic.rect.x, 'end in right-to-left text is the left edge');
});

test("direction: 'rtl' makes the UI right-to-left for text with no strong letter; 'ltr' forces left-to-right", () => {
  const rtl = makeUi({ direction: 'rtl' });
  assert.equal(rtl.textDirection('123'), 'rtl');
  assert.equal(rtl.textDirection('Hello'), 'rtl', 'a set direction applies to every text');
  const ltr = makeUi({ direction: 'ltr' });
  assert.equal(ltr.textDirection('مرحبا'), 'ltr');
  assert.throws(() => new Ui({ direction: 'up' }), TypeError);
});
