// Proof for @margoengine/text: single ASCII characters are classified (whitespace, bidi class, ideograph) by char
// code instead of by Unicode patterns, ASCII-only strings skip Intl.Segmenter, and Font caches kerning per left
// cluster instead of building a joined key for every pair.
// Run: node examples/package-benchmarks/proofs/text.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/text.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { refs, versions, time, record } from './compare.js';

// Font measures through a 2D canvas. This stand-in gives deterministic widths (with pair kerning for "AV"-like
// pairs) and records every measureText call, so both versions must measure the same strings in the same order.
const measured = [];
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return {
      canvas: this,
      measureText(text) {
        measured.push(text);
        let width = 0;
        for (const point of text) {
          const c = point.codePointAt(0);
          width += c === 32 ? 16 : c > 0x2e80 ? 64 : 24 + (c % 13);
        }
        if (text.length === 2 && 'ATVWY'.includes(text[0]) && 'AVWYo.'.includes(text[1])) width -= 4;
        return { width, fontBoundingBoxAscent: 51, fontBoundingBoxDescent: 13 };
      },
    };
  }
};

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('text', ref, undefined, pin);
const same = (run, message) => {
  measured.length = 0;
  const a = run(baseline),
    callsA = measured.slice();
  measured.length = 0;
  const b = run(candidate);
  assert.deepStrictEqual(b, a, message);
  assert.deepStrictEqual(measured, callsA, 'measureText calls differ');
};
const outcome = (run) => {
  try {
    return run();
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};

// --- Classification and segmentation ---------------------------------------------------------------------------
const clusters = [
  '',
  'a',
  'Z',
  '5',
  ' ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\v',
  '\f',
  '(',
  ')',
  '-',
  '\u0000',
  '\u007f',
  ' ',
  '​',
  'é',
  'é',
  'א',
  'ا',
  '١',
  '中',
  'あ',
  '　',
  '！',
  '가',
  '𠀀',
  '𐤀',
  '𞤀',
  '\u{1F468}‍\u{1F469}',
  '\u{1F1FA}\u{1F1F8}',
  'ab',
  ' a',
  'a ',
  '  ',
  '1א',
  '⹿',
  '⺀',
  '֏',
  '֐',
  '\ud83f',
  '\udc00',
];
for (let c = 0; c < 0x10000; c++)
  assert.equal(candidate.bidiClass(String.fromCharCode(c)), baseline.bidiClass(String.fromCharCode(c)));
for (const cluster of clusters) assert.equal(candidate.bidiClass(cluster), baseline.bidiClass(cluster));
// Every ordered pair of the characters the ASCII path accepts, plus the ones it must leave to the segmenter.
const ascii = Array.from({ length: 128 }, (_, c) => String.fromCharCode(c));
for (const a of ascii)
  assert.deepStrictEqual(
    candidate.graphemes(ascii.map((b) => a + b).join('')),
    baseline.graphemes(ascii.map((b) => a + b).join('')),
  );
for (const text of [
  '',
  'a\r\nb',
  'a\rb',
  'éa',
  '\u{1F468}‍\u{1F469}‍\u{1F467}!',
  '\u{1F1FA}\u{1F1F8}x',
  'plain ascii\n\twith tab',
  'café',
  'a b',
])
  assert.deepStrictEqual(candidate.graphemes(text), baseline.graphemes(text));
// isWhitespace and isIdeograph are internal; Font.kerning returns 0 for them before measuring, so the kerning
// values and the measureText log of every cluster pair cover both (0x0000..0x33ff holds every ASCII, space, RTL and
// CJK-punctuation boundary).
const units = [
  ...clusters,
  ...Array.from({ length: 0x3400 }, (_, c) => String.fromCharCode(c)),
  ...Array.from({ length: 256 }, (_, c) => String.fromCharCode(0xd700 + c * 16)),
  'ﹰ',
  'ﻼ',
  '＀',
  '￯',
  '￰',
];
same((module) => {
  const font = new module.Font({ family: 'Inter' });
  return units.map((unit) => [font.kerning(unit, 'A'), font.kerning('V', unit), font.advance(unit)]);
}, 'kerning against every code unit');
// The empty string is left out here: it is never a cluster, and the old joined key confused ('', NUL) with (NUL, '').
const real = clusters.filter(Boolean);
same((module) => {
  const font = new module.Font();
  return real
    .flatMap((left) => real.map((right) => font.kerning(left, right)))
    .concat(real.map((left) => font.kerning(left, left)));
}, 'kerning of cluster pairs');

// --- Layout: identical results for the cases of packages/text/tests and for random option combinations -----------
const mock = {
  advance: (cluster) => (/\s/.test(cluster) ? 0.25 : cluster === 'W' ? 0.8 : /[぀-鿿]/.test(cluster) ? 1 : 0.5),
  kerning: (a, b) => (a === 'A' && b === 'V' ? -0.1 : 0),
  metrics: () => ({ ascent: 0.8, descent: 0.2 }),
};
const paragraph =
  'The quick brown fox jumps over the lazy dog. WAVE To. AVATAR (alpha) [beta] {gamma} <delta> 0123456789, tab\there; trailing spaces   \nSecond line: pack my box with five dozen liquor jugs!\n\nLast   line  ';
const texts = [
  '',
  ' ',
  '\n',
  'AB',
  'AV',
  'ABC',
  'aaa bbb ccc',
  'aaa   bbb',
  'abcdefghij',
  'a\nb\n\nc',
  'a\r\nb\rc',
  'one two three four',
  'trailing  \n  leading',
  'W W W',
  paragraph,
  'supercalifragilisticexpialidocious and more',
  'שלום עולם',
  'abc אבג 123 (דה) def',
  'אב (abc) ג',
  'a (אב) b [c] «d»',
  '漢字かな交じり文 mixed 文字',
  'été \u{1F468}‍\u{1F469}‍\u{1F467} ok \u{1F1FA}\u{1F1F8}',
  'nbsp here zero​width',
  'line separator',
];
const pick = (list, n) => list[n % list.length];
let combos = 0;
for (const text of texts)
  for (let n = 0; n < 48; n++) {
    const options = {
      fontSize: pick([1, 2, 0.35], n),
      lineHeight: pick([1.2, 1.5], n >> 1),
      letterSpacing: pick([0, 0.1, -0.05], n >> 2),
      maxWidth: pick([Infinity, 3, 1.2, 0.1, 7.5], n),
      textAlign: pick(['left', 'center', 'right', 'justify'], n),
      anchorX: pick(['left', 'center', 'right'], n >> 2),
      anchorY: pick(['top', 'middle', 'bottom', 'baseline', 'bottom-baseline'], n),
      direction: pick(['auto', 'ltr', 'rtl'], n >> 3),
      whiteSpace: pick(['normal', 'normal', 'normal', 'nowrap'], n >> 1),
      overflowWrap: pick(['break-word', 'normal'], n >> 4),
    };
    assert.deepStrictEqual(
      candidate.layoutText(text, options, mock),
      baseline.layoutText(text, options, mock),
      JSON.stringify([text, options]),
    );
    combos++;
    if (n % 12 === 0)
      same((module) => {
        const font = new module.Font(),
          layout = module.layoutText(text, options, font);
        return [layout, module.hitTest(layout, 0.7, -0.4), module.caretRect(layout, 3)];
      }, 'layout with a Font');
  }
assert.ok(combos > 1000);
for (const bad of [
  [5, {}],
  ['a', { fontSize: 0 }],
  ['a', { maxWidth: -1 }],
  ['a', { textAlign: 'middle' }],
  ['a', { direction: 'up' }],
])
  assert.equal(
    outcome(() => candidate.layoutText(bad[0], bad[1], mock)),
    outcome(() => baseline.layoutText(bad[0], bad[1], mock)),
  );

// --- Timing ----------------------------------------------------------------------------------------------------
const cases = [];
// 150 name tags and stat readouts of about 20 characters whose text changes (scores, timers, coordinates): each
// change is one layout. The Font caches are warm, as they are after the first frame.
const tags = Array.from({ length: 150 }, (_, i) => `Player ${i} HP ${(i * 37) % 100}/100 (${i % 7}.${i % 10} km)`);
// A 1,200 character help panel wrapped to 40 em, relaid out when its width or text changes.
const panel = Array.from({ length: 8 }, () => paragraph.replace(/\t/g, ' '))
  .join(' ')
  .slice(0, 1200);
for (const [name, list, options, rounds] of [
  ['150 changing name tags, Font measurer', tags, { anchorX: 'center', anchorY: 'middle' }, 4],
  ['1,200 character wrapped panel, Font measurer', [panel], { maxWidth: 40, textAlign: 'justify' }, 12],
]) {
  const make = (module) => {
    const font = new module.Font({ family: 'Inter' });
    for (const text of list) module.layoutText(text, options, font);
    return () => {
      for (let round = 0; round < rounds; round++) for (const text of list) module.layoutText(text, options, font);
    };
  };
  cases.push({ case: name, layouts: list.length * rounds, ...time(make(baseline), make(candidate)) });
}
// Text.validate runs for every drawn text every frame. Same error (or none) for each bad field first.
for (const [key, value] of [
  ['text', 5],
  ['font', {}],
  ['fontSize', 0],
  ['lineHeight', NaN],
  ['letterSpacing', Infinity],
  ['maxWidth', 0],
  ['textAlign', 'middle'],
  ['anchorX', 'top'],
  ['anchorY', 'center'],
  ['direction', 'up'],
  ['whiteSpace', 'pre'],
  ['overflowWrap', 'anywhere'],
  ['opacity', 2],
  ['opacity', '1'],
  ['opacity', NaN],
  ['outlineOpacity', -0.1],
  ['shadowOpacity', 1.5],
  ['outlineWidth', -1],
  ['outlineWidth', Infinity],
  ['shadowBlur', '2'],
  ['shadowBlur', NaN],
  ['billboard', 1],
  ['onTop', null],
  ['visible', 'yes'],
  ['opacity', 0],
  ['outlineWidth', 0],
]) {
  const check = (module) => {
    const text = new module.Text({ text: 'ok' });
    text[key] = value;
    return outcome(() => text.validate());
  };
  assert.equal(check(candidate), check(baseline), key);
}
for (const bad of [
  { opacity: 2 },
  { outlineWidth: -1 },
  { anchorX: 'middle' },
  { shadowOpacity: -1, opacity: 3 },
  { visible: 1, billboard: 'x' },
])
  assert.equal(
    outcome(() => {
      new candidate.Text(bad);
    }),
    outcome(() => {
      new baseline.Text(bad);
    }),
  );
{
  // 150 visible texts (the name tags above), validated once per frame for two seconds at 60 FPS.
  const make = (module) => {
    const font = new module.Font(),
      list = tags.map((text) => new module.Text({ text, font, outlineWidth: 0.02, shadowOpacity: 0.5 }));
    return () => {
      for (let frame = 0; frame < 120; frame++) for (const text of list) text.validate();
    };
  };
  cases.push({ case: 'Text.validate, 150 texts per frame', frames: 120, ...time(make(baseline), make(candidate)) });
}
await record(
  'text',
  ref,
  cases,
  'ASCII fast paths in bidiClass, isWhitespace, isIdeograph and graphemes; Font.kerning caches in a map per left cluster. Text.validate checks its fields without building arrays. Layout arithmetic is unchanged.',
  pin,
);
