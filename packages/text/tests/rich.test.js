import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRichText, layoutRichText, RichText } from '@margoengine/text/rich';
import { BitmapFont } from '@margoengine/text/msdf';
import { readFileSync } from 'node:fs';
import { decodePNG } from '@margoengine/decoders/png';

test('the documented prebuilt atlas has a real SDF page and every printable ASCII glyph', () => {
  const base = new URL('./fixtures/fonts/readme/', import.meta.url);
  const data = JSON.parse(readFileSync(new URL('source-sans.json', base), 'utf8'));
  const pages = data.pages.map((name) => decodePNG(readFileSync(new URL(name, base))));
  const font = new BitmapFont(data, pages);
  assert.equal(data.chars.length, 95);
  assert.equal(data.distanceField.fieldType, 'sdf');
  assert.ok(font.advance('Hello') > 1);
  assert.equal(font.glyph(' '), null);
  for (let id = 33; id < 127; id++) {
    const glyph = font.glyph(String.fromCodePoint(id));
    assert.ok(glyph, `missing ${id}`);
    assert.ok(
      glyph.data.some((value) => value < 128),
      `no outside in ${id}`,
    );
    assert.ok(
      glyph.data.some((value) => value > 128),
      `no inside in ${id}`,
    );
  }
  assert.notDeepEqual(font.glyph('H').data, font.glyph('o').data);
});
import { layoutText, Text } from '@margoengine/text';

const mock = {
  advance: (s) => s.length * 0.5,
  kerning: () => 0,
  metrics: () => ({ ascent: 0.8, descent: 0.2 }),
};

test('parseRichText turns markup into styled spans', () => {
  const spans = parseRichText('a <b>b<i>c</i></b> <color=#f80>d</color><size=2>e</size><link=/x>f</link><img=g>\\<');
  assert.deepEqual(
    spans.map((s) => s.text),
    ['a ', 'b', 'c', ' ', 'd', 'e', 'f', '', '<'],
  );
  assert.equal(spans[1].bold, true);
  assert.equal(spans[2].bold && spans[2].italic, true);
  assert.equal(spans[3].bold, false);
  assert.equal(spans[4].color, '#f80');
  assert.equal(spans[5].size, 2);
  assert.equal(spans[6].link, '/x');
  assert.equal(spans[7].image, 'g');
});

test('parseRichText names what is wrong', () => {
  for (const bad of ['<nope>', '<b>x', '<b></i>', '<size=0>', 'a<b'])
    assert.throws(() => parseRichText(bad), TypeError);
  assert.throws(() => parseRichText(1), TypeError);
});

test('layoutRichText wraps at spaces, keeps styles apart and joins equal styles', () => {
  const { pieces, width, height } = layoutRichText(parseRichText('aa bb <b>cc</b> dd'), { maxWidth: 3.2 }, () => mock);
  assert.deepEqual(
    pieces.map((p) => [p.text.trim(), p.line]),
    [
      ['aa bb', 0],
      ['cc', 1],
      ['dd', 1],
    ],
  );
  assert.equal(pieces[0].x, 0);
  assert.equal(pieces[1].x, 0);
  assert.equal(width, 2.5);
  assert.ok(Math.abs(height - 2.4) < 1e-9);
  assert.ok(pieces[1].y < pieces[0].y);
});

test('layoutRichText sizes a line by its tallest piece, places images and reverses pieces in rtl', () => {
  const tall = layoutRichText(parseRichText('<size=2>a</size>b'), {}, () => mock);
  assert.ok(Math.abs(tall.height - 2.4) < 1e-9);
  assert.equal(tall.pieces[1].x, 1);
  assert.equal(tall.pieces[0].y, tall.pieces[1].y);
  const image = layoutRichText(
    parseRichText('a<img=s>b'),
    {},
    () => mock,
    () => 2,
  );
  assert.equal(image.pieces[1].width, 2);
  assert.equal(image.pieces[2].x, 2.5);
  const rtl = layoutRichText(parseRichText('a<b>b</b>'), { direction: 'rtl' }, () => mock);
  assert.ok(rtl.pieces[0].x > rtl.pieces[1].x);
  assert.deepEqual(
    layoutRichText(parseRichText('a\nb'), {}, () => mock).pieces.map((p) => p.line),
    [0, 1],
  );
});

test('RichText makes a Text per piece with its style and finds links', () => {
  const data = {
      pages: ['p.png'],
      chars: [...'abcd '].map((c, i) => ({
        id: c.codePointAt(0),
        x: i * 4,
        y: 0,
        width: c === ' ' ? 0 : 4,
        height: 4,
        xoffset: 0,
        yoffset: 0,
        xadvance: 16,
        page: 0,
      })),
      info: { size: 32 },
      common: { lineHeight: 40, base: 30 },
      distanceField: { fieldType: 'msdf', distanceRange: 4 },
    },
    pages = [{ width: 32, height: 4, data: new Uint8Array(32 * 4 * 4) }],
    bitmap = new BitmapFont(data, pages),
    rich = new RichText({
      markup: 'a <color=#f00>b</color> <link=/go>c</link> <img=s>',
      font: bitmap,
      bold: bitmap,
      images: { s: { width: 2, height: 1 } },
      position: [1, 2, 3],
      fontSize: 2,
      opacity: 0.5,
    });
  assert.ok(rich.texts.every((t) => t instanceof Text));
  assert.deepEqual(
    rich.texts.map((t) => t.text.trim()),
    ['a', 'b', '', 'c', '', '￼'],
  );
  assert.equal(rich.texts[0].opacity, 0.5);
  const link = rich.texts[3];
  assert.equal(link.fontSize, 2);
  assert.throws(() => new RichText({ markup: '<img=x>', font: bitmap }), /names image/);
  const inside = layoutRichText(
    parseRichText(rich.options.markup),
    { fontSize: 2 },
    () => bitmap,
    () => 2,
  ).pieces.find((p) => p.link);
  assert.equal(rich.linkAt(inside.x + 0.1, inside.y), '/go');
  assert.equal(rich.linkAt(-5, 0), undefined);
});

test('BitmapFont measures from the BMFont file and reads a median field', () => {
  const data = {
      pages: ['p.png'],
      chars: [
        { id: 65, x: 1, y: 0, width: 2, height: 1, xoffset: 1, yoffset: 3, xadvance: 16, page: 0 },
        { id: 86, x: 0, y: 0, width: 1, height: 1, xoffset: 0, yoffset: 0, xadvance: 8, page: 0 },
        { id: 32, x: 0, y: 0, width: 0, height: 0, xoffset: 0, yoffset: 0, xadvance: 4, page: 0 },
      ],
      info: { size: -32 },
      common: { lineHeight: 40, base: 30 },
      kernings: [{ first: 65, second: 86, amount: -4 }],
      distanceField: { fieldType: 'msdf', distanceRange: 6 },
    },
    px = [
      [0, 0, 0, 255],
      [10, 200, 100, 255],
      [255, 0, 128, 255],
    ],
    font = new BitmapFont(data, [{ width: 3, height: 1, data: Uint8Array.from(px.flat()) }]);
  assert.equal(font.size, 32);
  assert.equal(font.radius, 6);
  assert.equal(font.cutoff, 0.5);
  assert.equal(font.loaded, true);
  assert.equal(font.advance('A'), 0.5);
  assert.equal(font.kerning('A', 'V'), -0.125);
  assert.equal(font.kerning('V', 'A'), 0);
  assert.deepEqual(font.metrics(), { ascent: 30 / 32, descent: 10 / 32 });
  const glyph = font.glyph('A');
  assert.deepEqual([...glyph.data], [100, 128]);
  assert.equal(glyph.left, 1);
  assert.equal(glyph.top, 27);
  assert.equal(glyph.color, false);
  assert.equal(font.glyph(' '), null);
  assert.equal(font.glyph('Z'), null);
  assert.equal(font.glyph('A'), glyph);
  assert.equal(layoutText('AV', {}, font).glyphs[1].x, 0.5 - 0.125);
  assert.ok(new Text({ text: 'A', font }) instanceof Text);
  assert.throws(() => new BitmapFont({ chars: [] }, []), TypeError);
  assert.throws(() => new BitmapFont({ ...data, pages: ['a', 'b'] }, []), /atlas pages/);
});
