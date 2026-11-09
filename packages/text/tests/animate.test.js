import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimatedText } from '../dist/animate.js';
import { Font } from '../dist/index.js';

const close = (a, b, msg, eps = 1e-4) => {
  assert.ok(Math.abs(a - b) <= eps, `${msg}: expected ${b}, got ${a}`);
};

const mockMeasurer = {
  advance(cluster) {
    return 0.5 * cluster.length;
  },
  kerning() {
    return 0;
  },
  metrics() {
    return { ascent: 0.8, descent: 0.2 };
  },
};

const mockFont = Object.assign(Object.create(Font.prototype), {
  family: 'sans-serif',
  weight: 'normal',
  style: 'normal',
  size: 48,
  revision: 0,
  advance: mockMeasurer.advance,
  kerning: mockMeasurer.kerning,
  metrics: mockMeasurer.metrics,
});

test('AnimatedText constructs with initial layout and glyphs', () => {
  const anim = new AnimatedText({
    text: 'ABC',
    font: mockFont,
    fontSize: 2,
  });

  assert.equal(anim.length, 3);
  assert.equal(anim.texts.length, 3);
  assert.equal(anim.glyphs[0].cluster, 'A');
  assert.equal(anim.glyphs[1].cluster, 'B');
  assert.equal(anim.glyphs[2].cluster, 'C');

  // Each glyph starts visible with opacity 1, scale 1, zero offset
  for (const g of anim.glyphs) {
    assert.equal(g.visible, true);
    assert.equal(g.opacity, 1);
    assert.equal(g.scale, 1);
    assert.deepEqual(g.offset, [0, 0, 0]);
    assert.deepEqual(g.rotation, [0, 0, 0]);
  }

  // Bounds should match layout bounds
  assert.ok(anim.bounds.right > anim.bounds.left);
  assert.ok(anim.bounds.top > anim.bounds.bottom);
});

test('AnimatedText skips whitespace for glyph instances while preserving layout spacing', () => {
  const anim = new AnimatedText({
    text: 'A B C',
    font: mockFont,
    fontSize: 1,
  });

  // 'A B C' has 3 non-whitespace glyphs
  assert.equal(anim.length, 3);
  assert.equal(anim.glyphs[0].cluster, 'A');
  assert.equal(anim.glyphs[1].cluster, 'B');
  assert.equal(anim.glyphs[2].cluster, 'C');

  // Spacing between A and B includes the space advance (0.5 * 1 = 0.5 em)
  // A is at x = 0, space is at x = 0.5, B is at x = 1.0
  close(anim.glyphs[0].origin[0], 0, 'A position');
  close(anim.glyphs[1].origin[0], 1.0, 'B position');
  close(anim.glyphs[2].origin[0], 2.0, 'C position');
});

test('typewriter reveals glyphs by progress or count', () => {
  const anim = new AnimatedText({
    text: 'HELLO',
    font: mockFont,
    fontSize: 1,
  });

  // Progress 0: all hidden
  anim.typewriter(0);
  for (const g of anim.glyphs) {
    assert.equal(g.visible, false);
    assert.equal(g.opacity, 0);
  }

  // Count 2: first 2 visible, rest hidden
  anim.typewriter({ count: 2 });
  assert.equal(anim.glyphs[0].visible, true);
  assert.equal(anim.glyphs[0].opacity, 1);
  assert.equal(anim.glyphs[1].visible, true);
  assert.equal(anim.glyphs[1].opacity, 1);
  assert.equal(anim.glyphs[2].visible, false);
  assert.equal(anim.glyphs[3].visible, false);
  assert.equal(anim.glyphs[4].visible, false);

  // Progress 0.5 (2.5 of 5): with fade and pop on active glyph
  anim.typewriter({ progress: 0.5, fade: true, pop: true, popScale: 2.0 });
  assert.equal(anim.glyphs[0].visible, true);
  assert.equal(anim.glyphs[1].visible, true);
  assert.equal(anim.glyphs[2].visible, true);
  close(anim.glyphs[2].opacity, 0.5, 'fractional fade');
  close(anim.glyphs[2].scale, 1.5, 'fractional pop scale');
  assert.equal(anim.glyphs[3].visible, false);
  assert.equal(anim.glyphs[4].visible, false);

  // Progress 1: all visible
  anim.typewriter(1);
  for (const g of anim.glyphs) {
    assert.equal(g.visible, true);
    assert.equal(g.opacity, 1);
    assert.equal(g.scale, 1);
  }
});

test('wave oscillates glyphs along specified axis', () => {
  const anim = new AnimatedText({
    text: 'WAVE',
    font: mockFont,
    fontSize: 1,
  });

  anim.wave(0, { speed: 4, frequency: 1, amplitude: 0.5, axis: 'y' });
  // At time 0: y offset = sin(0 + i * 1) * 0.5
  close(anim.glyphs[0].offset[1], 0, 'glyph 0 offset');
  close(anim.glyphs[1].offset[1], Math.sin(1) * 0.5, 'glyph 1 offset');
  close(anim.glyphs[2].offset[1], Math.sin(2) * 0.5, 'glyph 2 offset');

  // Wave on x axis
  anim.wave(1, { speed: 2, frequency: 0.5, amplitude: 0.2, axis: 'x' });
  close(anim.glyphs[0].offset[0], Math.sin(2) * 0.2, 'x wave glyph 0');
});

test('bounce shifts glyphs upward with non-negative displacements', () => {
  const anim = new AnimatedText({
    text: 'BOUNCE',
    font: mockFont,
    fontSize: 1,
  });

  anim.bounce(0.5, { speed: 3, frequency: 0.5, height: 1.0 });
  for (const g of anim.glyphs) {
    assert.ok(g.offset[1] >= 0, 'bounce offset is non-negative');
  }
});

test('fade performs staggered reveals', () => {
  const anim = new AnimatedText({
    text: 'FADE',
    font: mockFont,
    fontSize: 1,
  });

  anim.fade(0);
  for (const g of anim.glyphs) assert.equal(g.visible, false);

  anim.fade(1);
  for (const g of anim.glyphs) {
    assert.equal(g.visible, true);
    assert.equal(g.opacity, 1);
  }
});

test('colorWave sets RGB overrides across glyphs', () => {
  const anim = new AnimatedText({
    text: 'RAINBOW',
    font: mockFont,
    fontSize: 1,
  });

  anim.colorWave(0);
  for (const g of anim.glyphs) {
    assert.ok(Array.isArray(g.color));
    assert.equal(g.color.length, 3);
    for (const c of g.color) assert.ok(c >= 0 && c <= 1);
  }
});

test('each allows custom per-glyph procedural manipulation', () => {
  const anim = new AnimatedText({
    text: 'CUSTOM',
    font: mockFont,
    fontSize: 1,
  });

  anim.each((g, i, total) => {
    g.offset[0] = i * 0.1;
    g.scale = 1 + i * 0.2;
    g.opacity = (i + 1) / total;
  });

  for (let i = 0; i < anim.length; i++) {
    const g = anim.glyphs[i];
    close(g.offset[0], i * 0.1, 'offset');
    close(g.scale, 1 + i * 0.2, 'scale');
    close(g.opacity, (i + 1) / anim.length, 'opacity');
  }
});

test('reset restores initial glyph properties', () => {
  const anim = new AnimatedText({
    text: 'RESET',
    font: mockFont,
    fontSize: 1,
  });

  anim.wave(1);
  anim.colorWave(2);
  anim.typewriter(0.3);

  anim.reset();
  for (const g of anim.glyphs) {
    assert.equal(g.visible, true);
    assert.equal(g.opacity, 1);
    assert.equal(g.scale, 1);
    assert.deepEqual(g.offset, [0, 0, 0]);
    assert.deepEqual(g.rotation, [0, 0, 0]);
    assert.equal(g.color, undefined);
  }
});

test('dynamic text update rebuilds glyph instances', () => {
  const anim = new AnimatedText({
    text: 'OLD',
    font: mockFont,
    fontSize: 1,
  });
  assert.equal(anim.length, 3);

  anim.text = 'LONGER STRING';
  assert.equal(anim.length, 12); // 13 chars minus 1 space
});

test('renderer registration and disposal', () => {
  const added = [];
  const removed = [];
  const fakeRenderer = {
    add(t) {
      added.push(t);
    },
    remove(t) {
      removed.push(t);
    },
  };

  const anim = new AnimatedText({
    text: 'TEST',
    font: mockFont,
    fontSize: 1,
    renderer: fakeRenderer,
  });

  assert.equal(added.length, 4);

  anim.removeFrom(fakeRenderer);
  assert.equal(removed.length, 4);

  anim.addTo(fakeRenderer);
  assert.equal(added.length, 8);

  anim.dispose();
  assert.equal(anim.length, 0);
  assert.equal(anim.texts.length, 0);
});

test('AnimatedText validates input arguments and numbers', () => {
  const anim = new AnimatedText({ text: 'VALID', font: mockFont });

  assert.throws(() => {
    anim.text = 123;
  }, TypeError);
  assert.throws(() => anim.wave(NaN), RangeError);
  assert.throws(() => anim.bounce(Infinity), RangeError);
  assert.throws(() => anim.fade('not a number'), RangeError);
  assert.throws(() => anim.colorWave(0, { colors: [[1, 0, 0]] }), RangeError);
});
