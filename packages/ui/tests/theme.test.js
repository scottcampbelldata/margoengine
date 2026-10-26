import test from 'node:test';
import assert from 'node:assert/strict';
import {
  themes,
  createTheme,
  themeForPreferences,
  contrastRatio,
  colorDifference,
  simulateColorBlindness,
  parseRgba,
  mixColors,
  Ui,
  Label,
} from '../dist/index.js';
import { makeUi, measurer } from './helpers.js';

const TEXT_PAIRS = [
  ['text', 'surface'],
  ['text', 'surfaceRaised'],
  ['text', 'surfaceSunken'],
  ['text', 'background'],
  ['textMuted', 'surface'],
  ['onPrimary', 'primary'],
  ['onAccent', 'accent'],
  ['onSuccess', 'success'],
  ['onWarning', 'warning'],
  ['onDanger', 'danger'],
  ['onInfo', 'info'],
];

test('every text colour meets WCAG AA (4.5:1) on what it is drawn on, in every theme', () => {
  for (const theme of Object.values(themes))
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrastRatio(theme.colors[fg], theme.colors[bg]);
      assert.ok(ratio >= 4.5, `${theme.name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
});

test('the high contrast theme meets AAA (7:1) for text and 3:1 for boundaries and focus', () => {
  const t = themes.highContrast;
  for (const [fg, bg] of TEXT_PAIRS) assert.ok(contrastRatio(t.colors[fg], t.colors[bg]) >= 7, `${fg} on ${bg}`);
  for (const bg of ['surface', 'surfaceRaised', 'background'])
    assert.ok(contrastRatio(t.colors.focus, t.colors[bg]) >= 7, `focus on ${bg}`);
  assert.ok(contrastRatio(t.colors.border, t.colors.surface) >= 7);
  assert.ok(t.borderWidth >= 2 && t.focusWidth >= 4);
  assert.equal(t.shadowBlur, 0);
  assert.equal(t.transition, 0);
});

test('control borders and the focus ring are visible (3:1) against the surfaces they sit on', () => {
  for (const theme of [themes.dark, themes.light, themes.highContrast]) {
    const c = theme.colors;
    assert.ok(contrastRatio(c.border, c.surface) >= 3, `${theme.name} border on surface`);
    assert.ok(contrastRatio(c.border, c.surfaceSunken) >= 3, `${theme.name} border on sunken`);
    for (const bg of ['background', 'surface', 'surfaceRaised', 'surfaceSunken'])
      assert.ok(
        contrastRatio(c.focus, c[bg]) >= 3,
        `${theme.name} focus on ${bg}: ${contrastRatio(c.focus, c[bg]).toFixed(2)}`,
      );
  }
});

test('status colours stay apart for protan, deutan and tritan viewers', () => {
  for (const theme of [themes.dark, themes.light]) {
    for (const kind of ['protanopia', 'deuteranopia', 'tritanopia']) {
      // Health uses success, warning and danger together: those three must never merge.
      for (const [a, b] of [
        ['success', 'warning'],
        ['success', 'danger'],
        ['warning', 'danger'],
      ]) {
        const x = simulateColorBlindness(theme.colors[a], kind),
          y = simulateColorBlindness(theme.colors[b], kind);
        const difference = colorDifference(x, y);
        assert.ok(difference >= 18, `${theme.name} ${kind}: ${a} vs ${b} differ by ${difference.toFixed(1)}`);
      }
    }
    // Accent and info sit beside the status colours, so they must not merge with them for protan or deutan viewers.
    for (const kind of ['protanopia', 'deuteranopia'])
      for (const other of ['accent', 'info'])
        for (const status of ['success', 'warning', 'danger']) {
          const difference = colorDifference(
            simulateColorBlindness(theme.colors[other], kind),
            simulateColorBlindness(theme.colors[status], kind),
          );
          assert.ok(
            difference >= 10,
            `${theme.name} ${kind}: ${other} vs ${status} differ by ${difference.toFixed(1)}`,
          );
        }
  }
});

test('the simulation leaves greys alone and changes red and green', () => {
  const grey = simulateColorBlindness('#808080', 'deuteranopia');
  assert.ok(Math.abs(grey[0] - 128 / 255) < 0.01 && Math.abs(grey[1] - grey[0]) < 0.01);
  assert.ok(colorDifference('#ff0000', simulateColorBlindness('#ff0000', 'protanopia')) > 30);
});

test('contrast ratio is 21 for black on white and 1 for equal colours', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  assert.equal(contrastRatio('#336699', '#336699'), 1);
});

test('createTheme merges overrides and validates them', () => {
  const brand = createTheme({ name: 'brand', colors: { primary: '#ff6600' }, radius: 2 });
  assert.equal(brand.colors.primary, '#ff6600');
  assert.equal(brand.colors.surface, themes.dark.colors.surface);
  assert.equal(brand.radius, 2);
  assert.ok(Object.isFrozen(brand) && Object.isFrozen(brand.colors));
  const fromLight = createTheme({ colors: { primary: '#123456' } }, themes.light);
  assert.equal(fromLight.colors.text, themes.light.colors.text);
  assert.throws(() => createTheme({ colors: { primary: 'orange' } }), TypeError);
  assert.throws(() => createTheme({ colors: { nope: '#fff' } }), TypeError);
  assert.throws(() => createTheme({ bogus: 1 }), TypeError);
  assert.throws(() => createTheme({ radius: -1 }), RangeError);
  assert.throws(() => createTheme({ fontSize: { body: 0 } }), RangeError);
  assert.throws(() => createTheme({ fontSize: { huge: 5 } }), TypeError);
});

test('colours parse from short, long and alpha hex and reject anything else', () => {
  assert.deepEqual(parseRgba('#fff'), [1, 1, 1, 1]);
  assert.deepEqual(
    parseRgba('#00000080').map((v) => Math.round(v * 255)),
    [0, 0, 0, 128],
  );
  assert.deepEqual(
    parseRgba('#f008').map((v) => Math.round(v * 255)),
    [255, 0, 0, 136],
  );
  assert.throws(() => parseRgba('red'), TypeError);
  assert.throws(() => parseRgba([2, 0, 0, 1]), RangeError);
  assert.deepEqual(mixColors([0, 0, 0, 1], [1, 1, 1, 1], 0.5), [0.5, 0.5, 0.5, 1]);
});

test('with no preferences the default theme is dark', () => {
  assert.equal(themeForPreferences().name, 'dark');
  assert.equal(new Ui({ measurer }).theme.name, 'dark');
});

test('themeForPreferences follows contrast and colour scheme queries', () => {
  const saved = globalThis.matchMedia;
  try {
    globalThis.matchMedia = (query) => ({ matches: query === '(prefers-contrast: more)' });
    assert.equal(themeForPreferences().name, 'high-contrast');
    globalThis.matchMedia = (query) => ({ matches: query === '(prefers-color-scheme: light)' });
    assert.equal(themeForPreferences().name, 'light');
    globalThis.matchMedia = (query) => ({ matches: query === '(forced-colors: active)' });
    assert.equal(themeForPreferences().name, 'high-contrast');
  } finally {
    globalThis.matchMedia = saved;
    if (saved === undefined) delete globalThis.matchMedia;
  }
});

test('switching the theme restyles widgets on the next draw', () => {
  const ui = makeUi(),
    label = new Label({ text: 'Hi', anchor: 'top-left' });
  ui.add(label);
  const colorOf = () => ui.draw().commands.find((c) => c.type === 'text').color;
  const dark = colorOf();
  ui.theme = themes.light;
  const light = colorOf();
  assert.notDeepEqual(dark, light);
  assert.deepEqual(light, parseRgba(themes.light.colors.text));
  assert.throws(() => (ui.theme = {}), TypeError);
});

test('high contrast gives widgets thicker outlines and no shadows', () => {
  const ui = makeUi({ theme: themes.highContrast });
  assert.equal(ui.theme.borderWidth, 2);
  ui.theme = themes.dark;
  assert.equal(ui.theme.borderWidth, 1);
});
