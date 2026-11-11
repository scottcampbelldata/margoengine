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
  GlyphAtlas,
  Font,
  Text,
  TextRenderer,
  parseColor,
} from '../dist/index.js';
import { buildColorFont, COLOR_FONT_PALETTE } from './color-font.js';

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

test('alphaToSdf disk shape sanity', () => {
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

test('shelf packer page clearing: clearPage frees page for new slots, validates page index', () => {
  const packer = new ShelfPacker(32, 2, 1);
  for (let i = 0; i < 8; i++) {
    const slot = packer.pack(15, 15);
    assert.ok(slot, `slot ${i} packed`);
  }
  assert.equal(packer.pack(15, 15), null);
  assert.equal(packer.pageCount, 2);

  assert.throws(() => packer.clearPage(-1), RangeError);
  assert.throws(() => packer.clearPage(2), RangeError);

  packer.clearPage(0);
  assert.equal(packer.isPageEmpty(0), true);
  assert.equal(packer.isPageEmpty(1), false);

  const slot = packer.pack(15, 15);
  assert.ok(slot);
  assert.equal(slot.page, 0);
  assert.equal(slot.x, 0);
  assert.equal(slot.y, 0);
});

test('glyph atlas eviction: frees unused pages on demand or LRU when full, reuses freed pages', () => {
  const fakeTexture = { createView: () => ({}), destroy() {} };
  const mockDevice = {
    createTexture: () => fakeTexture,
    createCommandEncoder: () => ({ copyTextureToTexture() {}, finish: () => ({}) }),
    queue: { writeTexture() {}, submit() {} },
    limits: { maxTextureDimension2D: 8192 },
  };

  const atlas = new GlyphAtlas(mockDevice, 'r8unorm', 32, 2);
  const glyphs = [];
  for (let i = 0; i < 8; i++) {
    glyphs.push({
      cluster: `g${i}`,
      width: 15,
      height: 15,
      left: 0,
      top: 0,
      color: false,
      data: new Uint8Array(225),
    });
  }

  for (let i = 0; i < 8; i++) {
    const slot = atlas.place(glyphs[i]);
    assert.equal(slot.page, Math.floor(i / 4));
  }
  assert.equal(atlas.pages, 2);
  assert.equal(atlas.slots.size, 8);

  const extraGlyph = {
    cluster: 'extra',
    width: 15,
    height: 15,
    left: 0,
    top: 0,
    color: false,
    data: new Uint8Array(225),
  };

  atlas.canEvict = () => false;
  assert.throws(() => atlas.place(extraGlyph), RangeError);

  atlas.canEvict = (p) => p === 0;
  const initialGen = atlas.generation;
  const slot = atlas.place(extraGlyph);
  assert.ok(slot);
  assert.equal(slot.page, 0);
  assert.ok(atlas.generation > initialGen);
  for (let i = 0; i < 4; i++) {
    assert.equal(atlas.slots.has(glyphs[i]), false);
  }
  for (let i = 4; i < 8; i++) {
    assert.equal(atlas.slots.has(glyphs[i]), true);
  }

  assert.equal(atlas.evictPage(1), true);
  assert.equal(atlas.evictPage(5), false);
  for (let i = 4; i < 8; i++) {
    assert.equal(atlas.slots.has(glyphs[i]), false);
  }
});

test('TextRenderer evictUnused and canEvictPage: identifies unused pages and frees them', () => {
  const fakeTexture = { createView: () => ({}), destroy() {} };
  const mockDevice = {
    createTexture: () => fakeTexture,
    createCommandEncoder: () => ({ copyTextureToTexture() {}, finish: () => ({}) }),
    queue: { writeTexture() {}, submit() {}, writeBuffer() {} },
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy() {} }),
  };
  const mockEngine = {
    backend: 'webgpu',
    gpu: mockDevice,
    store: { matrices: new Float32Array(100) },
  };

  const renderer = new TextRenderer({ atlasSize: 64, maxPages: 4 });
  renderer.setup(mockEngine);

  const glyphA = { cluster: 'A', width: 10, height: 10, left: 0, top: 0, color: false, data: new Uint8Array(100) };
  const glyphB = { cluster: 'B', width: 10, height: 10, left: 0, top: 0, color: false, data: new Uint8Array(100) };
  const font = Object.assign(Object.create(Font.prototype), {
    revision: 0,
    size: 48,
    radius: 8,
    cutoff: 0.25,
    advance: (c) => mock.advance(c),
    kerning: mock.kerning,
    metrics: mock.metrics,
    glyph: (c) => (c === 'A' ? glyphA : c === 'B' ? glyphB : null),
  });
  const text1 = new Text({ text: 'A', font });
  const text2 = new Text({ text: 'B', font });
  renderer.add(text1);
  renderer.add(text2);

  const atlas = renderer.sdfAtlas;
  assert.equal(renderer.canEvictPage(0, atlas), true);

  atlas.place(glyphA);
  atlas.place(glyphB);
  assert.equal(renderer.canEvictPage(0, atlas), false);

  renderer.remove(text1);
  renderer.remove(text2);
  assert.equal(renderer.canEvictPage(0, atlas), true);

  const freed = renderer.evictUnused();
  assert.equal(freed, 1);
  assert.equal(atlas.slots.size, 0);
});

// --- SSR safety and object validation ------------------------------------------------------------

test('preloaded faces become render-ready only after joining the canvas font set', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'),
    faces = new Set();
  let calls = 0,
    additions = 0;
  const face = {
    family: 'Preloaded',
    weight: '400',
    style: 'normal',
    status: 'loaded',
    async load() {
      calls++;
      return this;
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      fonts: {
        has: (value) => faces.has(value),
        add(value) {
          additions++;
          faces.add(value);
        },
      },
    },
  });
  try {
    const font = new Font({ face });
    assert.equal(font.loaded, false, 'TextRenderer must wait for registration before rasterizing');
    await font.load();
    assert.equal(font.loaded, true);
    assert.equal(faces.has(face), true);
    await font.load();
    assert.equal(calls, 1);
    assert.equal(additions, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
});

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

test('the in-memory colour test font is a well-formed sfnt with COLR/CPAL and both emoji mapped', () => {
  const bytes = new Uint8Array(buildColorFont()),
    view = new DataView(bytes.buffer);
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  assert.equal(bytes.length % 4, 0);
  assert.equal(sum, 0xb1b0afba, 'whole-font checksum matches head.checkSumAdjustment');
  const count = view.getUint16(4),
    tables = {};
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i,
      tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    tables[tag] = { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
  }
  const tags = Object.keys(tables);
  assert.deepEqual(tags, [...tags].sort(), 'table records sorted by tag');
  for (const tag of ['COLR', 'CPAL', 'OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'])
    assert.ok(tables[tag], `${tag} present`);
  // cmap format 12 subtable maps U+1F600 to glyph 1 and U+1F680 to glyph 2.
  const cmap = tables.cmap.offset,
    sub = cmap + view.getUint32(cmap + 4 + 8 + 4);
  assert.equal(view.getUint16(sub), 12);
  assert.deepEqual(
    [0, 1].map((g) => [view.getUint32(sub + 16 + 12 * g), view.getUint32(sub + 24 + 12 * g)]),
    [
      [0x1f600, 1],
      [0x1f680, 2],
    ],
  );
  // CPAL colour records are BGRA and match the exported palette.
  const cpal = tables.CPAL.offset,
    records = cpal + view.getUint32(cpal + 8);
  assert.deepEqual(
    COLOR_FONT_PALETTE.map((_, i) => [bytes[records + 4 * i + 2], bytes[records + 4 * i + 1], bytes[records + 4 * i]]),
    COLOR_FONT_PALETTE,
  );
});

test('Arabic and Indic words lay out as one shaped run with carets by grapheme', () => {
  const arabic = '\u0633\u0644\u0627\u0645',
    byLength = { ...mock, advance: (cluster) => 0.5 * cluster.length },
    l = layoutText(arabic, {}, byLength);
  assert.equal(l.glyphs.length, 1);
  assert.equal(l.glyphs[0].cluster, arabic);
  assert.equal(l.glyphs[0].rtl, true);
  assert.deepEqual(
    l.glyphs[0].carets.map((c) => c[0]),
    [1, 2, 3],
  );
  const g = l.glyphs[0];
  close(caretRect(l, 1).x, g.x + g.advance - g.carets[0][1], 'rtl caret');
  assert.equal(hitTest(l, g.x + g.advance - g.carets[1][1], -0.5), 2);
  const words = layout(arabic + ' ' + arabic);
  assert.equal(words.glyphs.length, 3, 'a space ends a run');
  const devanagari = '\u0915\u094d\u0937\u093f \u0928';
  const d = layout(devanagari);
  assert.equal(d.glyphs.filter((x) => !x.whitespace).length, 2);
  assert.equal(d.glyphs[0].rtl, false);
  assert.equal(layout(arabic + '\u0928').glyphs.length, 2, 'scripts do not join');
});

test('shaped runs apply letterSpacing between clusters', () => {
  const arabic = '\u0633\u0644\u0627\u0645',
    byLength = { ...mock, advance: (cluster) => 0.5 * cluster.length },
    l = layoutText(arabic, { letterSpacing: 2 }, byLength);
  assert.equal(l.glyphs.length, 1);
  const g = l.glyphs[0];
  // 4 clusters * 0.5 em + 3 internal letter gaps * 2 = 2.0 + 6 = 8.0
  close(g.advance, 8.0, 'advance with letterSpacing: 2');
  assert.equal(g.carets.length, 3);
  close(g.carets[0][1], 0.5 * 1 + 1 * 2, 'caret 1');
  close(g.carets[1][1], 0.5 * 2 + 2 * 2, 'caret 2');
  close(g.carets[2][1], 0.5 * 3 + 3 * 2, 'caret 3');
  close(caretRect(l, 1).x, g.x + g.advance - g.carets[0][1], 'rtl caret 1');
  close(caretRect(l, 2).x, g.x + g.advance - g.carets[1][1], 'rtl caret 2');
  close(caretRect(l, 3).x, g.x + g.advance - g.carets[2][1], 'rtl caret 3');
  assert.equal(hitTest(l, g.x + g.advance - g.carets[1][1], -0.5), 2);
});

test('long shaped run lays out without advance truncation', () => {
  const longArabic = '\u0633'.repeat(60),
    byLength = { ...mock, advance: (cluster) => 0.5 * cluster.length },
    l = layoutText(longArabic, {}, byLength);
  assert.equal(l.glyphs.length, 1);
  const g = l.glyphs[0];
  close(g.advance, 30.0, '60-character run advance');
  assert.equal(g.carets.length, 59);
});

test('a shaped run stays whole across a line break', () => {
  const l = layout('\u0633\u0644\u0627\u0645\u0633\u0644\u0627\u0645', { maxWidth: 1 });
  assert.equal(l.lines.length, 1);
  assert.equal(l.glyphs.length, 1);
});

test('ligatures joins Latin words only when asked', () => {
  assert.equal(layout('office').glyphs.length, 6);
  const l = layout('office hi', { ligatures: true });
  assert.deepEqual(
    l.glyphs.map((g) => g.cluster),
    ['office', ' ', 'hi'],
  );
  close(caretRect(l, 3).x, l.glyphs[0].x + l.glyphs[0].carets[2][1], 'latin caret');
  assert.throws(() => layout('a', { ligatures: 1 }), TypeError);
});

// UAX #9 (revision 52) weak types: rules W2 to W7, N1 with numbers acting as R, I1 and I2, and P2 skipping numbers.
test('bidi numbers follow UAX #9: they attach to right-to-left text, keep Arabic-Indic order and do not set direction', () => {
  const cl = (text) =>
    layout(text)
      .glyphs.map((g) => g.cluster)
      .join('');
  // N1: the space between Hebrew and a European number takes R, so the number sits on the Hebrew's left.
  assert.equal(cl('abc שלום 123'), 'abc 123 םולש');
  // Arabic-Indic digits are AN: they read left to right inside Arabic text.
  assert.equal(cl('سلام ١٢٣'), '١٢٣ سلام');
  // P2: numbers are not strong, so the first strong character (Hebrew) makes the paragraph right to left.
  const lead = layout('123 שלום');
  assert.equal(lead.lines[0].rtl, true);
  assert.equal(lead.glyphs.map((g) => g.cluster).join(''), 'םולש 123');
  // The annex's list example: a comma and space between numbers take the run's direction (N1).
  assert.equal(cl('א 123, 456'), '456 ,123 א');
  // W4 and W5: a single separator inside a number and a terminator next to it join the number.
  assert.equal(cl('א 1,000.5 ב'), 'ב 1,000.5 א');
  assert.equal(cl('א $100'), '$100 א');
});

test('KB4990b: release drops one bitmap slot and frees its page once the page holds no other slot', () => {
  const fakeTexture = { createView: () => ({}), destroy() {} };
  const device = {
    createTexture: () => fakeTexture,
    createCommandEncoder: () => ({ copyTextureToTexture() {}, finish: () => ({}) }),
    queue: { writeTexture() {}, submit() {} },
    limits: { maxTextureDimension2D: 8192 },
  };
  const atlas = new GlyphAtlas(device, 'rgba8unorm', 32, 1),
    bitmap = (i) => ({ cluster: `i${i}`, width: 15, height: 15, left: 0, top: 0, color: true, data: new Uint8Array(900) }),
    a = bitmap(0),
    b = bitmap(1);
  atlas.place(a);
  atlas.place(b);
  assert.equal(atlas.release(a), true);
  assert.equal(atlas.slots.has(a), false, 'the bitmap is no longer held');
  assert.equal(atlas.packer.isPageEmpty(0), false, 'b still uses page 0');
  assert.equal(atlas.release(b), true);
  assert.equal(atlas.packer.isPageEmpty(0), true, 'the empty page is free for new bitmaps');
  assert.equal(atlas.release(b), false);
  const c = atlas.place(bitmap(2));
  assert.deepEqual([c.page, c.x, c.y], [0, 0, 0]);
});
