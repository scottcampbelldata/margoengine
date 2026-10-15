import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutText,
  hitTest,
  caretRect,
  graphemes,
  bidiClass,
  alphaToSdf,
  squaredDistanceTransform,
  sdfDistance,
  SDF_DEFAULTS,
  ShelfPacker,
  Font,
  Text,
  TextRenderer,
  parseColor,
} from '../dist/index.js';

const close = (actual, expected, message = '', epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message} expected ${expected}, got ${actual}`);

// Deterministic measurer: spaces 0.25 em, W 0.8, ideographs 1, everything else 0.5; "AV" kerns by -0.1.
const mock = {
  calls: 0,
  advance(cluster) {
    this.calls++;
    return /\s/.test(cluster) ? 0.25 : cluster === 'W' ? 0.8 : /[぀-鿿]/.test(cluster) ? 1 : 0.5;
  },
  kerning(a, b) {
    return a === 'A' && b === 'V' ? -0.1 : 0;
  },
  metrics() {
    return { ascent: 0.8, descent: 0.2 };
  },
};
const layout = (text, options = {}) => layoutText(text, options, mock);
const visual = (l, line = 0) => {
  const L = l.lines[line];
  return l.glyphs.slice(L.firstGlyph, L.firstGlyph + L.glyphCount);
};
const lineText = (l, line) =>
  visual(l, line)
    .map((g) => g.cluster)
    .join('');

test('grapheme clusters keep combining marks, emoji sequences and flags together', () => {
  assert.deepEqual(
    graphemes('éa').map((g) => g.cluster),
    ['é', 'a'],
  );
  assert.deepEqual(
    graphemes('\u{1F468}‍\u{1F469}‍\u{1F467}!').map((g) => g.cluster),
    ['\u{1F468}‍\u{1F469}‍\u{1F467}', '!'],
  );
  assert.deepEqual(
    graphemes('\u{1F1FA}\u{1F1F8}x').map((g) => g.index),
    [0, 4],
  );
  assert.equal(bidiClass('א'), 'R');
  assert.equal(bidiClass('ا'), 'R');
  assert.equal(bidiClass('a'), 'L');
  assert.equal(bidiClass('5'), 'L');
  assert.equal(bidiClass('('), 'N');
});

test('single line: advances, kerning, letter spacing, font size and line metrics', () => {
  const l = layout('AB');
  assert.deepEqual(
    l.glyphs.map((g) => g.x),
    [0, 0.5],
  );
  close(l.bounds.right, 1);
  assert.equal(l.bounds.top, 0);
  close(l.bounds.bottom, -1.2);
  close(l.lines[0].baseline, -0.9, 'half-leading baseline');
  const kerned = layout('AV');
  close(kerned.glyphs[1].x, 0.4, 'kerned');
  close(kerned.bounds.right, 0.9);
  const spaced = layout('ABC', { letterSpacing: 0.1 });
  assert.deepEqual(
    spaced.glyphs.map((g) => Math.round(g.x * 1e9) / 1e9),
    [0, 0.6, 1.2],
  );
  close(spaced.bounds.right, 1.7, 'letter spacing goes between clusters only');
  const big = layout('AV', { fontSize: 2, lineHeight: 1.5 });
  close(big.glyphs[1].x, 0.8);
  close(big.bounds.right, 1.8);
  close(big.bounds.bottom, -3);
  close(big.lineHeight, 3);
  close(big.lines[0].baseline, -(3 - 2) / 2 - 1.6);
  const empty = layout('');
  assert.equal(empty.lines.length, 1);
  assert.equal(empty.glyphs.length, 0);
  close(empty.bounds.bottom, -1.2);
  close(empty.bounds.right, 0);
});

test('wrapping breaks on spaces, keeps trailing spaces hanging, and splits long words', () => {
  const l = layout('aaa bbb ccc', { maxWidth: 3.6 });
  assert.equal(l.lines.length, 2);
  assert.equal(lineText(l, 0), 'aaa bbb ');
  assert.equal(lineText(l, 1), 'ccc');
  assert.deepEqual([l.lines[0].start, l.lines[0].end, l.lines[1].start, l.lines[1].end], [0, 8, 8, 11]);
  close(l.lines[0].right, 3.25, 'trailing space excluded from width');
  close(l.bounds.right, 3.25);
  close(l.lines[1].top, -1.2);
  close(l.lines[1].baseline, -2.1);
  close(l.bounds.bottom, -2.4);
  const long = layout('abcdefgh', { maxWidth: 1.6 });
  assert.deepEqual(
    long.lines.map((_, i) => lineText(long, i)),
    ['abc', 'def', 'gh'],
  );
  const nobreak = layout('abcdefgh', { maxWidth: 1.6, overflowWrap: 'normal' });
  assert.equal(nobreak.lines.length, 1);
  const nowrap = layout('aaa bbb ccc', { maxWidth: 1, whiteSpace: 'nowrap' });
  assert.equal(nowrap.lines.length, 1);
  const mixed = layout('hi abcdefgh', { maxWidth: 1.6 });
  assert.deepEqual(
    mixed.lines.map((_, i) => lineText(mixed, i)),
    ['hi ', 'abc', 'def', 'gh'],
    'a long word starts on its own line before splitting',
  );
  const cjk = layout('日本語のテキスト', { maxWidth: 3.5 });
  assert.deepEqual(
    cjk.lines.map((line) => line.glyphCount),
    [3, 3, 2],
    'ideographs break anywhere',
  );
  const exact = layout('ab cd', { maxWidth: 2.25 });
  assert.equal(exact.lines.length, 1, 'a line exactly maxWidth wide does not wrap');
});

test('newlines make paragraphs, including empty ones', () => {
  const l = layout('a\n\nbb\r\nc\n');
  assert.equal(l.lines.length, 5);
  assert.deepEqual(
    l.lines.map((line) => [line.start, line.end]),
    [
      [0, 1],
      [2, 2],
      [3, 5],
      [7, 8],
      [9, 9],
    ],
  );
  assert.deepEqual(
    l.lines.map((line) => line.glyphCount),
    [1, 0, 2, 1, 0],
  );
  close(l.bounds.bottom, -6);
});

test('alignment: left, center, right and justify within the widest line', () => {
  const text = 'aaaaaaa b c dddddd',
    maxWidth = 3.6;
  const lines = (align) => layout(text, { maxWidth, textAlign: align }).lines;
  assert.deepEqual(
    lines('left').map((line) => line.glyphCount),
    [8, 4, 6],
  );
  assert.deepEqual(
    lines('left').map((line) => line.left),
    [0, 0, 0],
  );
  const center = lines('center'),
    right = lines('right');
  close(center[1].left, (3.5 - 1.25) / 2);
  close(center[2].left, 0.25);
  close(right[1].left, 2.25);
  close(right[1].right, 3.5);
  close(right[2].left, 0.5);
  const justified = layout(text, { maxWidth, textAlign: 'justify' });
  const second = visual(justified, 1);
  close(second[2].x, 3.0, 'justified c');
  close(justified.lines[1].right, 3.5, 'justified line fills the block');
  close(second[1].advance, 0.25 + 2.25, 'the space absorbs the extra width');
  close(justified.lines[2].left, 0, 'last line of a paragraph is not justified');
  close(justified.lines[0].left, 0);
});

test('anchors place the block relative to the local origin', () => {
  const opts = { maxWidth: 3.6 };
  const at = (anchorX, anchorY) => layout('aaa bbb ccc', { ...opts, anchorX, anchorY }).bounds;
  const tl = at('left', 'top');
  assert.deepEqual(
    [tl.left, tl.top].map((v) => Math.round(v * 1e9) / 1e9),
    [0, 0],
  );
  close(at('center', 'top').left, -3.25 / 2);
  close(at('center', 'top').right, 3.25 / 2);
  close(at('right', 'top').right, 0);
  close(at('right', 'top').left, -3.25);
  close(at('left', 'middle').top, 1.2);
  close(at('left', 'middle').bottom, -1.2);
  close(at('left', 'bottom').bottom, 0);
  close(at('left', 'bottom').top, 2.4);
  const base = layout('aaa bbb ccc', { ...opts, anchorY: 'baseline' });
  close(base.lines[0].baseline, 0, 'first baseline at the origin');
  const last = layout('aaa bbb ccc', { ...opts, anchorY: 'bottom-baseline' });
  close(last.lines[1].baseline, 0, 'last baseline at the origin');
  const glyph = layout('a', { anchorX: 'center', anchorY: 'middle' }).glyphs[0];
  close(glyph.x, -0.25);
  close(glyph.y, 0.6 - 0.9);
});

test('right-to-left: Hebrew runs reverse, numbers stay left to right, brackets mirror', () => {
  const he = layout('אבג');
  assert.equal(he.lines[0].rtl, true);
  assert.deepEqual(
    he.glyphs.map((g) => g.index),
    [2, 1, 0],
  );
  assert.ok(he.glyphs.every((g) => g.rtl));
  const mixed = layout('abc אבג');
  assert.equal(mixed.lines[0].rtl, false);
  assert.deepEqual(
    mixed.glyphs.map((g) => g.index),
    [0, 1, 2, 3, 6, 5, 4],
  );
  const numbers = layout('א 12');
  assert.deepEqual(
    numbers.glyphs.map((g) => g.cluster),
    ['1', '2', ' ', 'א'],
  );
  const brackets = layout('א(ב)');
  assert.deepEqual(
    brackets.glyphs.map((g) => g.cluster),
    ['(', 'ב', ')', 'א'],
  );
  assert.deepEqual(
    brackets.glyphs.map((g) => g.index),
    [3, 2, 1, 0],
  );
  const paired = layout('x \u05d0 (\u05d1) y');
  assert.deepEqual(
    paired.glyphs.map((g) => g.cluster),
    ['x', ' ', '(', '\u05d1', ')', ' ', '\u05d0', ' ', 'y'],
    'bracket pair around Hebrew joins the Hebrew run',
  );
  const latinInHebrew = layout('\u05d0 (abc)');
  assert.deepEqual(
    latinInHebrew.glyphs.map((g) => g.cluster),
    ['(', 'a', 'b', 'c', ')', ' ', '\u05d0'],
  );
  const forced = layout('abc', { direction: 'rtl', textAlign: 'right' });
  assert.equal(forced.lines[0].rtl, true);
  assert.deepEqual(
    forced.glyphs.map((g) => g.cluster),
    ['a', 'b', 'c'],
  );
  const wrapped = layout('אא בב', { maxWidth: 1.2, textAlign: 'right' });
  assert.equal(wrapped.lines.length, 2);
  assert.deepEqual(
    visual(wrapped, 0).map((g) => g.cluster),
    [' ', 'א', 'א'],
    'trailing space hangs on the left',
  );
  close(visual(wrapped, 0)[1].x, 0);
  close(wrapped.lines[0].right, 1);
});

test('hit testing and caret placement', () => {
  const l = layout('AB\ncd');
  assert.equal(hitTest(l, 0.2, -0.5), 0);
  assert.equal(hitTest(l, 0.3, -0.5), 1);
  assert.equal(hitTest(l, 0.8, -0.5), 2);
  assert.equal(hitTest(l, 5, -0.5), 2);
  assert.equal(hitTest(l, -5, -0.5), 0);
  assert.equal(hitTest(l, 0.9, -1.5), 5);
  assert.equal(hitTest(l, 0.6, -1.5), 4);
  assert.equal(hitTest(l, 0.1, -99), 3, 'below the block maps to the last line');
  assert.deepEqual(caretRect(l, 1), { x: 0.5, top: 0, bottom: -1.2, line: 0 });
  assert.equal(caretRect(l, 2).x, 1);
  assert.equal(caretRect(l, 2).line, 0);
  assert.equal(caretRect(l, 3).line, 1);
  assert.equal(caretRect(l, 3).x, 0);
  assert.equal(caretRect(l, 5).x, 1);
  const he = layout('אב');
  assert.equal(caretRect(he, 0).x, 1, 'RTL caret at offset 0 is on the right');
  assert.equal(caretRect(he, 2).x, 0);
  assert.equal(hitTest(he, 0.9, -0.5), 0);
  assert.equal(hitTest(he, 0.1, -0.5), 2);
  const centered = layout('ab', { anchorX: 'center' });
  assert.equal(hitTest(centered, -0.4, -0.5), 0);
  assert.equal(caretRect(centered, 2).x, 0.5);
});

test('layout options are validated', () => {
  assert.throws(() => layout('a', { fontSize: 0 }), RangeError);
  assert.throws(() => layout('a', { maxWidth: -1 }), RangeError);
  assert.throws(() => layout('a', { letterSpacing: NaN }), RangeError);
  assert.throws(() => layout('a', { textAlign: 'middle' }), TypeError);
  assert.throws(() => layout('a', { anchorY: 'center' }), TypeError);
  assert.throws(() => layoutText(5, {}, mock), TypeError);
});

// --- Distance transform -----------------------------------------------------------------------

function random(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
function bruteForce(grid, width, height) {
  const out = new Float64Array(width * height);
  for (let qy = 0; qy < height; qy++)
    for (let qx = 0; qx < width; qx++) {
      let best = Infinity;
      for (let py = 0; py < height; py++)
        for (let px = 0; px < width; px++)
          best = Math.min(best, (qx - px) ** 2 + (qy - py) ** 2 + grid[py * width + px]);
      out[qy * width + qx] = best;
    }
  return out;
}
function referenceSdf(alpha, width, height, { radius, cutoff }) {
  const outer = new Float64Array(width * height),
    inner = new Float64Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i] / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = 1e20;
    } else if (a <= 0) {
      outer[i] = 1e20;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  const o = bruteForce(outer, width, height),
    n = bruteForce(inner, width, height);
  return Uint8Array.from(o, (v, i) =>
    Math.max(0, Math.min(255, Math.round(255 - 255 * ((Math.sqrt(v) - Math.sqrt(n[i])) / radius + cutoff)))),
  );
}

test('squared distance transform matches brute force on binary and sampled grids', () => {
  const rand = random(7);
  for (const [width, height, density] of [
    [1, 1, 0.5],
    [7, 5, 0.1],
    [12, 9, 0.02],
    [16, 16, 0.3],
    [5, 13, 0.05],
  ]) {
    const binary = Float64Array.from({ length: width * height }, () => (rand() < density ? 0 : 1e20));
    if (binary.every((v) => v > 0)) binary[Math.floor(rand() * binary.length)] = 0;
    const expected = bruteForce(binary, width, height),
      actual = squaredDistanceTransform(binary.slice(), width, height);
    for (let i = 0; i < expected.length; i++) close(actual[i], expected[i], `binary ${width}x${height} cell ${i}`);
    const sampled = Float64Array.from({ length: width * height }, () => (rand() < 0.3 ? rand() * 4 : 1e20));
    const expectedSampled = bruteForce(sampled, width, height),
      actualSampled = squaredDistanceTransform(sampled.slice(), width, height);
    for (let i = 0; i < expectedSampled.length; i++)
      close(actualSampled[i], expectedSampled[i], `sampled cell ${i}`, 1e-6);
  }
  assert.throws(() => squaredDistanceTransform(new Float64Array(3), 2, 2), RangeError);
});

test('distance transform retains indices above 65535 in both axes', () => {
  const length = 65537;
  for (const [width, height] of [
    [length, 1],
    [1, length],
  ]) {
    const grid = new Float64Array(length).fill(1e20);
    grid[length - 1] = 0;
    assert.equal(squaredDistanceTransform(grid, width, height), grid);
    for (let i = 0; i < length; i++)
      assert.equal(grid[i], (length - 1 - i) ** 2, `distance at ${i} in ${width}x${height}`);
  }
});

test('alphaToSdf matches a brute-force TinySDF reference on antialiased bitmaps', () => {
  const rand = random(42);
  for (const [width, height] of [
    [9, 9],
    [14, 10],
    [20, 17],
  ]) {
    // An antialiased disk plus random noise pixels.
    const cx = width / 2,
      cy = height / 2,
      r = Math.min(width, height) / 3;
    const alpha = Uint8Array.from({ length: width * height }, (_, i) => {
      const x = (i % width) + 0.5,
        y = Math.floor(i / width) + 0.5,
        d = Math.hypot(x - cx, y - cy) - r;
      return rand() < 0.04 ? Math.floor(rand() * 256) : Math.round(Math.max(0, Math.min(1, 0.5 - d)) * 255);
    });
    const params = { radius: 6, cutoff: 0.25 };
    assert.deepEqual(
      alphaToSdf(alpha, width, height, params),
      referenceSdf(alpha, width, height, params),
      `${width}x${height}`,
    );
    // Interleaved RGBA input reads the alpha channel.
    const rgba = new Uint8Array(width * height * 4);
    alpha.forEach((a, i) => {
      rgba[i * 4 + 3] = a;
      rgba[i * 4] = 255 - a;
    });
    assert.deepEqual(alphaToSdf(rgba, width, height, params, 4, 3), referenceSdf(alpha, width, height, params));
  }
  // Shape sanity: inside saturates, far outside is zero, the edge lands at 255 * (1 - cutoff).
  const size = 40,
    disk = Uint8Array.from({ length: size * size }, (_, i) =>
      Math.hypot((i % size) + 0.5 - 20, Math.floor(i / size) + 0.5 - 20) < 10 ? 255 : 0,
    );
  const field = alphaToSdf(disk, size, size);
  assert.equal(field[20 * size + 20], 255);
  assert.equal(field[0], 0);
  const edge = field[20 * size + 30];
  assert.ok(
    Math.abs(sdfDistance(edge)) <= 1.01 && sdfDistance(field[20 * size + 32]) > 2,
    `edge distance ${sdfDistance(edge)}`,
  );
  close(sdfDistance(Math.round(255 * (1 - SDF_DEFAULTS.cutoff))), 0, 'edge decode', 0.05);
  assert.throws(() => alphaToSdf(new Uint8Array(4), 2, 2, { radius: 0, cutoff: 0.25 }), RangeError);
});

// --- Atlas packing -----------------------------------------------------------------------------

test('shelf packer: no overlaps, padding, new pages when full, null past the limit', () => {
  const packer = new ShelfPacker(64, 3, 1),
    rand = random(3),
    slots = [];
  for (let i = 0; i < 400; i++) {
    const slot = packer.pack(4 + Math.floor(rand() * 12), 4 + Math.floor(rand() * 12));
    if (!slot) break;
    slots.push(slot);
  }
  assert.equal(packer.pageCount, 3);
  assert.ok(slots.length > 40, `${slots.length} slots`);
  for (const s of slots) assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.width <= 64 && s.y + s.height <= 64);
  for (let i = 0; i < slots.length; i++)
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i],
        b = slots[j];
      if (a.page !== b.page) continue;
      const apart =
        a.x + a.width + 1 <= b.x || b.x + b.width + 1 <= a.x || a.y + a.height + 1 <= b.y || b.y + b.height + 1 <= a.y;
      assert.ok(apart, `slots ${i} and ${j} overlap or touch`);
    }
  assert.equal(packer.pack(64, 64), null, 'rectangles larger than a page minus padding never fit');
  assert.ok(packer.occupancy > 0.5, `occupancy ${packer.occupancy}`);
  assert.throws(() => packer.pack(0, 3), RangeError);
});

// --- SSR safety and object validation ------------------------------------------------------------

test('fonts, text and the renderer construct without a DOM or GPU', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const font = new Font({ family: 'Noto Sans', weight: 700, style: 'italic' });
  assert.equal(font.css, 'italic 700 48px "Noto Sans"');
  assert.equal(new Font({ family: 'Inter, sans-serif' }).css, 'normal normal 48px Inter, sans-serif');
  assert.equal(new Font().css, 'normal normal 48px sans-serif');
  assert.equal(font.loaded, true);
  assert.throws(() => new Font({ weight: 'heavy' }), TypeError);
  assert.throws(() => new Font({ style: 'slanted' }), TypeError);
  const face = { family: 'My Face', weight: '300', style: 'italic', status: 'unloaded', load() {} };
  const faced = new Font({ face });
  assert.equal(faced.css, 'italic 300 48px "My Face"');
  assert.equal(faced.loaded, false);
  const text = new Text({
    text: 'Hello',
    font,
    fontSize: 0.5,
    color: '#ff0000',
    outlineWidth: 0.02,
    position: [1, 2, 3],
    scale: 2,
  });
  assert.deepEqual([...text.matrix].slice(12, 15), [1, 2, 3]);
  assert.equal(text.matrix[0], 2);
  assert.deepEqual([...text.color], parseColor('#ff0000'));
  assert.equal(text.font, font);
  close(text.shadowOffset[0], 0.02, 'shadow offset scales with fontSize', 1e-7);
  assert.throws(() => new Text({ opacity: 2 }), RangeError);
  assert.throws(() => new Text({ outlineWidth: -1 }), RangeError);
  assert.throws(() => new Text({ anchorX: 'middle' }), TypeError);
  text.set({ textAlign: 'center', maxWidth: 4 });
  assert.equal(text.textAlign, 'center');
  const renderer = new TextRenderer();
  assert.equal(renderer.add(text), text);
  assert.equal(renderer.texts.size, 1);
  assert.throws(() => new TextRenderer().add(text), /another TextRenderer/);
  text.dispose();
  assert.equal(renderer.texts.size, 0);
  assert.throws(() => new TextRenderer({ atlasSize: 10 }), RangeError);
  assert.deepEqual(renderer.atlas, { sdfPages: 0, colorPages: 0, glyphs: 0, colorGlyphs: 0, pageSize: 1024 });
});

test('layout of a Text object is cached until a layout field changes', () => {
  const calls = { n: 0 };
  const measurer = Object.assign(Object.create(Font.prototype), {
    revision: 0,
    advance(c) {
      calls.n++;
      return mock.advance(c);
    },
    kerning: mock.kerning,
    metrics: mock.metrics,
  });
  const text = new Text({ text: 'ab cd', font: measurer });
  const first = text.layout,
    version = text.layoutVersion;
  assert.equal(text.layout, first);
  assert.equal(text.layoutVersion, version);
  text.color[0] = 0.5;
  text.opacity = 0.5;
  assert.equal(text.layout, first, 'style changes do not relayout');
  text.maxWidth = 1.2;
  const second = text.layout;
  assert.notEqual(second, first);
  assert.equal(second.lines.length, 2);
  assert.equal(text.layoutVersion, version + 1);
  text.text = 'ab';
  assert.equal(text.layout.lines.length, 1);
  assert.equal(text.hitTest(0.4, -0.5), 1);
  assert.equal(text.caretRect(2).x, 1);
});

test('cached Text layouts skip snapshot array construction and retain all invalidation keys', () => {
  const font = Object.assign(Object.create(Font.prototype), {
    revision: 0,
    advance: mock.advance,
    kerning: mock.kerning,
    metrics: mock.metrics,
  });
  const text = new Text({ text: 'ab cd', font });
  let layout = text.layout;
  const map = Array.prototype.map;
  let maps = 0;
  Array.prototype.map = function (...args) {
    maps++;
    return map.apply(this, args);
  };
  try {
    for (let i = 0; i < 120; i++) assert.equal(text.layout, layout);
  } finally {
    Array.prototype.map = map;
  }
  assert.equal(maps, 0, 'cached reads do not construct mapped snapshot arrays');
  const updates = {
    fontSize: 2,
    lineHeight: 1.5,
    letterSpacing: 0.1,
    maxWidth: 3,
    textAlign: 'center',
    anchorX: 'center',
    anchorY: 'middle',
    direction: 'rtl',
    whiteSpace: 'nowrap',
    overflowWrap: 'normal',
    text: 'different',
  };
  for (const [key, value] of Object.entries(updates)) {
    text[key] = value;
    const next = text.layout;
    assert.notEqual(next, layout, `${key} invalidates layout`);
    assert.equal(text.layout, next);
    layout = next;
  }
  font.revision++;
  assert.notEqual(text.layout, layout, 'font revision invalidates layout');
  layout = text.layout;
  text.font = Object.assign(Object.create(Font.prototype), {
    revision: font.revision,
    advance: mock.advance,
    kerning: mock.kerning,
    metrics: mock.metrics,
  });
  assert.notEqual(text.layout, layout, 'different font identity invalidates layout');
});
