// The row shape every package's /settings entry shares (packages/shared/settings.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettings,
  checkSettings,
  choiceSetting,
  colorSetting,
  followsWeather,
  liveSettings,
  numberSetting,
  settingDefaults,
} from '../packages/shared/settings.js';

const ramp = [
  { height: 0, color: [0, 0, 0] },
  { height: 1, color: [1, 1, 1] },
];
const rows = [
  numberSetting('a', 'g', 1, 0, 10, 0.1, 'm', 'a row'),
  numberSetting('size', 'g', 64, 8, 512, 8, 'px', 'rebuilds', false),
  colorSetting('tint', 'g', [1, 1, 1], 0, 2, 'a colour'),
  choiceSetting('mode', 'g', ['x', 'y'], 'a list'),
  followsWeather(numberSetting('wind', 'g', 0, 0, 40, 0.5, 'm/s', 'wind'), 'windSpeed'),
  {
    name: 'ramp',
    group: 'g',
    kind: 'gradient',
    default: ramp,
    min: 0,
    max: 1,
    stopKey: 'height',
    unit: '',
    about: 'stops',
    live: true,
  },
];

test('defaults are fresh copies of every row', () => {
  const d = settingDefaults(rows);
  assert.deepEqual(
    Object.keys(d),
    rows.map((r) => r.name),
  );
  assert.equal(d.wind, null);
  d.tint[0] = 9;
  d.ramp[0].color[0] = 9;
  assert.equal(rows[2].default[0], 1);
  assert.equal(ramp[0].color[0], 0);
});
test('an unknown name is a TypeError that names the package', () => {
  assert.throws(
    () => checkSettings(rows, { nope: 1 }, 'thing'),
    (e) => e instanceof TypeError && /thing setting nope/.test(e.message),
  );
});
test('a value outside its range or kind is a RangeError, per kind', () => {
  const bads = [
    { a: -1 },
    { a: 11 },
    { a: 'x' },
    { a: Number.NaN },
    { tint: [1, 1] },
    { tint: [3, 0, 0] },
    { mode: 'z' },
    { size: 7 },
  ];
  for (const bad of bads) assert.throws(() => checkSettings(rows, bad, 'thing'), RangeError, JSON.stringify(bad));
  assert.throws(() => checkSettings(rows, { ramp: [ramp[0]] }, 'thing'), RangeError);
  assert.throws(() => checkSettings(rows, { ramp: [ramp[1], { height: 0.5, color: [0, 0, 0] }] }, 'thing'), RangeError);
  checkSettings(rows, { a: 0, tint: [2, 0, 1], mode: 'y', size: 512, ramp }, 'thing');
});
test('null is allowed only on a nullable row, and the error names the weather slider it follows', () => {
  checkSettings(rows, { wind: null }, 'thing');
  for (const name of ['a', 'tint', 'mode', 'ramp'])
    assert.throws(() => checkSettings(rows, { [name]: null }, 'thing'), RangeError, name);
  assert.throws(() => checkSettings(rows, { wind: 41 }, 'thing'), /follow the weather's windSpeed/);
});
test('live rows list only what can change every frame', () => {
  assert.deepEqual(
    liveSettings(rows).map((r) => r.name),
    ['a', 'tint', 'mode', 'wind', 'ramp'],
  );
  assert.equal(
    rows.every((r) => typeof r.live === 'boolean'),
    true,
  );
});
test('apply writes each row once in order, defaults for what is left out, and refuses before writing anything', () => {
  const seen = [];
  applySettings(rows, { a: 3, wind: 12 }, 'thing', (r, v) => seen.push([r.name, v]));
  assert.deepEqual(
    seen.map((s) => s[0]),
    rows.map((r) => r.name),
  );
  assert.equal(seen[0][1], 3);
  assert.equal(seen[1][1], 64);
  assert.equal(seen[4][1], 12);
  const live = [];
  applySettings(
    rows,
    {},
    'thing',
    (r) => live.push(r.name),
    (r) => r.live,
  );
  assert.equal(live.includes('size'), false);
  const none = [];
  assert.throws(() => applySettings(rows, { a: 1, bad: 2 }, 'thing', (r) => none.push(r.name)), TypeError);
  assert.deepEqual(none, []);
});

test('holdFromWeather marks a key as set by hand and releases it; marks are invisible to enumeration and copies', async () => {
  const { holdFromWeather, heldFromWeather } = await import('../packages/shared/settings.js');
  const target = { density: 1 };
  assert.equal(heldFromWeather(target, 'density'), false);
  holdFromWeather(target, 'density');
  assert.equal(heldFromWeather(target, 'density'), true);
  assert.equal(heldFromWeather(target, 'other'), false);
  assert.deepEqual(Object.keys(target), ['density']);
  assert.deepEqual({ ...target }, { density: 1 });
  holdFromWeather(target, 'density', false);
  assert.equal(heldFromWeather(target, 'density'), false);
  assert.equal(heldFromWeather(null, 'x'), false);
});
