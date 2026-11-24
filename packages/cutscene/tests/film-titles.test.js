import test from 'node:test';
import assert from 'node:assert/strict';
import { Ui } from '@margoengine/ui';
import { FilmTitles, checkFilmTitles, defaultClosingLines, filmTitlesAt } from '../dist/film-titles.js';

const measurer = { advance: () => 0.5, kerning: () => 0, metrics: () => ({ ascent: 0.8, descent: 0.2 }) };
const makeUi = () => new Ui({ width: 1920, height: 1080, measurer, reducedMotion: true, safeArea: [0, 0, 0, 0] });

const spec = () => ({
  title: 'Fauld',
  cues: [[10, 14, 'Second line.'], { start: 1, end: 4, text: 'First line.' }],
  chapters: [
    { start: 0, title: 'Cold open', card: false },
    { start: 43, title: 'Gentle country', place: 'Fauld, Staffordshire, 1944' },
    { start: 97, title: 'The Dump', place: 'RAF Fauld, 21 MU, 1937' },
  ],
  chapterCount: 13,
  closing: { start: 880 },
});

test('a caption shows inside its cue, fully at mid cue and not at its end', () => {
  const s = spec();
  assert.equal(filmTitlesAt(s, 0.5).caption, null);
  assert.deepEqual(filmTitlesAt(s, 2), { caption: { text: 'First line.', opacity: 1 }, chapter: null, closing: 0 });
  assert.equal(filmTitlesAt(s, 4).caption, null, 'a cue ends exclusively');
  assert.equal(filmTitlesAt(s, 12).caption.text, 'Second line.', 'cues are sorted, whatever order they came in');
});

test('captions fade in over 0.22 s and out over 0.24 s by default', () => {
  const s = spec();
  assert.equal(filmTitlesAt(s, 1).caption.opacity, 0);
  assert.ok(Math.abs(filmTitlesAt(s, 1.11).caption.opacity - 0.5) < 1e-9, 'smoothstep mid point at half the fade');
  assert.equal(filmTitlesAt(s, 1.22).caption.opacity, 1);
  assert.equal(filmTitlesAt(s, 3.76).caption.opacity, 1);
  assert.ok(Math.abs(filmTitlesAt(s, 3.88).caption.opacity - 0.5) < 1e-9);
});

test('a short cue keeps its fades inside half its length, so it still reaches full opacity', () => {
  const s = { title: 'x', cues: [[0, 0.2, 'Short.']] };
  assert.equal(filmTitlesAt(s, 0.1).caption.opacity, 1);
});

test('chapter cards read "NN / count" with the title and place, and a card: false chapter shows none', () => {
  const s = spec();
  assert.equal(filmTitlesAt(s, 1).chapter, null, 'the cold open has no card');
  const card = filmTitlesAt(s, 45).chapter;
  assert.deepEqual(card, {
    index: 1,
    label: '01 / 13',
    title: 'Gentle country',
    place: 'Fauld, Staffordshire, 1944',
    opacity: 1,
  });
  assert.equal(filmTitlesAt(s, 47).chapter, null, 'the card holds 4 s by default');
  assert.equal(filmTitlesAt(s, 98).chapter.label, '02 / 13');
});

test('a card is cut short at the next chapter and a chapter number may be given', () => {
  const s = {
    title: 'x',
    chapters: [
      { start: 0, title: 'A', hold: 10 },
      { start: 3, number: 7, title: 'B' },
    ],
  };
  assert.equal(filmTitlesAt(s, 2.9).chapter.title, 'A');
  assert.equal(filmTitlesAt(s, 3).chapter.label, '07 / 07', 'count defaults to the highest number');
});

test('the closing card fades in over 1 s from its start and stays', () => {
  const s = spec();
  assert.equal(filmTitlesAt(s, 879).closing, 0);
  assert.ok(Math.abs(filmTitlesAt(s, 880.5).closing - 0.5) < 1e-9);
  assert.equal(filmTitlesAt(s, 900).closing, 1);
  assert.equal(filmTitlesAt({ title: 'x' }, 900).closing, 0, 'no closing card, opacity 0');
});

test('state is a pure function of film time: a seek straight to T equals a run through to T', () => {
  const run = spec(),
    seek = spec();
  for (let frame = 0; frame <= 24 * 120; frame++) filmTitlesAt(run, frame / 24);
  for (const t of [2, 12.5, 43.1, 45, 97.2, 101]) assert.deepEqual(filmTitlesAt(seek, t), filmTitlesAt(run, t));
});

test('captions take the cue shape of @margoengine/text/captions (lines joined by newlines)', () => {
  // An SRT read by parseSrt gives cues of this shape.
  const cues = [{ id: '1', start: 1, end: 3.5, lines: ['November 1944.', 'Staffordshire.'], settings: '' }];
  assert.equal(filmTitlesAt({ title: 'x', cues }, 2).caption.text, ['November 1944.', 'Staffordshire.'].join('\n'));
});

test('overlapping cues show the one that starts first', () => {
  const s = {
    title: 'x',
    cues: [
      [0, 10, 'long'],
      [2, 3, 'inner'],
    ],
  };
  assert.equal(filmTitlesAt(s, 2.5).caption.text, 'long');
  assert.equal(filmTitlesAt(s, 9).caption.text, 'long');
});

test('bad specs fail at once with a TypeError linked to the help page', () => {
  for (const bad of [
    { title: 'x', cues: [[2, 1, 'backwards']] },
    { title: 'x', cues: [[0, 1, 5]] },
    { title: 'x', cues: [[0, Number.NaN, 'a']] },
    {
      title: 'x',
      chapters: [
        { start: 5, title: 'b' },
        { start: 2, title: 'a' },
      ],
    },
    { title: 'x', chapterHold: 0 },
    { title: 3 },
  ])
    assert.throws(
      () => checkFilmTitles(bad),
      (error) => error instanceof TypeError && /errors#film-titles/.test(error.message),
    );
  assert.throws(() => filmTitlesAt({ title: 'x' }, Number.NaN), TypeError);
});

test('FilmTitles adds its panels to the UI, fades them with film time and removes them on dispose', () => {
  const ui = makeUi();
  const titles = new FilmTitles(ui, spec());
  const [caption, card, closing] = ui.root.children.slice(-3);
  assert.equal(ui.root.children.length, 3);
  titles.update(2);
  ui.update();
  assert.equal(caption.visible, true);
  assert.equal(caption.opacity, 1);
  assert.equal(caption.children[0].text, 'First line.');
  assert.equal(card.visible, false);
  titles.update(45);
  assert.equal(caption.visible, false);
  assert.equal(card.visible, true);
  assert.deepEqual(
    card.children.map((label) => label.text),
    ['01 / 13', 'Gentle country', 'Fauld, Staffordshire, 1944'],
  );
  titles.update(1.11);
  assert.ok(Math.abs(caption.opacity - 0.5) < 1e-9);
  titles.update(900);
  assert.equal(closing.opacity, 1);
  assert.deepEqual(
    closing.children.map((label) => label.text),
    defaultClosingLines('Fauld').map((line) => line.text),
  );
  titles[Symbol.dispose]();
  assert.equal(ui.root.children.length, 0);
  titles.dispose();
  assert.throws(() => titles.update(1), { name: 'MargoError', code: 'disposed' });
});

test('FilmTitles hides the place line of a chapter that has none and makes no closing panel without a closing card', () => {
  const ui = makeUi();
  const titles = new FilmTitles(ui, { title: 'x', chapters: [{ start: 0, title: 'Only' }] });
  assert.equal(ui.root.children.length, 2);
  titles.update(1);
  const card = ui.root.children[1];
  assert.equal(card.children[2].visible, false);
  assert.throws(() => new FilmTitles({}, { title: 'x' }), TypeError);
});
