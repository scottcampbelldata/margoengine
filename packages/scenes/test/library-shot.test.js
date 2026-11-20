// @margoengine/scenes/library and /shot-settings, with no GPU: the asset index is read and checked, unsafe paths and
// repeated ids are refused, the tool writes an index the module accepts; a shot's settings are checked with each
// package's own rules and evaluate between keys by row kind, deterministically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetUrl, fetchLibrary, findAssets, parseLibrary } from '@margoengine/scenes/library';
import { checkShotSettings, shotHeldRebuilds, shotSettingsAt } from '@margoengine/scenes/shot-settings';
import { sceneInfo } from '@margoengine/scenes';
import { indexLibrary } from '../../../tools/library-index.mjs';
import { WEATHER_SETTINGS } from '@margoengine/weather/settings';
import { SKY_SETTINGS } from '@margoengine/sky/settings';
import { TONEMAP_SETTINGS } from '@margoengine/tonemap/settings';

const model = (id, extra = {}) => ({ id, subject: 'film', kind: 'boats', type: 'model', file: `film/boats/${id}/${id}_2k.gltf`, bytes: 10, ...extra });

test('the catalogue types allow the new optional fields and the existing scene needs none', () => {
  const info = sceneInfo('dune-coast');
  assert.equal(info.looks, undefined);
  assert.equal(info.shots, undefined);
  assert.equal(info.targets, undefined);
});

test('a library index is checked and looked up by id', () => {
  const library = parseLibrary({ version: 1, assets: [model('a'), model('b', { kind: 'houses' }), { id: 'sky', subject: 'film', kind: 'hdri', type: 'sky', file: 'film/hdri/sky_2k.hdr' }] }, 'https://x.test/lib');
  assert.equal(library.assets.length, 3);
  assert.equal(assetUrl(library, 'a'), 'https://x.test/lib/film/boats/a/a_2k.gltf');
  assert.deepEqual(findAssets(library, { kind: 'houses' }).map((a) => a.id), ['b']);
  assert.deepEqual(findAssets(library, { type: 'sky' }).map((a) => a.id), ['sky']);
  assert.equal(library.byId.get('sky').bytes, 0);
  assert.throws(() => assetUrl(library, 'nope'), { name: 'RangeError', message: /nope/ });
});

test('a bad index is refused with the asset named', () => {
  for (const [data, pattern] of [
    [null, /\{ version: 1/],
    [{ version: 2, assets: [] }, /\{ version: 1/],
    [{ version: 1, assets: [model('a'), model('a')] }, /a is listed twice/],
    [{ version: 1, assets: [{ ...model('a'), type: 'mesh' }] }, /a has type mesh/],
    [{ version: 1, assets: [model('a', { file: '../secret.gltf' })] }, /a has file/],
    [{ version: 1, assets: [model('a', { file: '/abs/a.gltf' })] }, /a has file/],
    [{ version: 1, assets: [model('a', { file: 'x/./a.gltf' })] }, /a has file/],
    [{ version: 1, assets: [{ ...model('a'), id: '' }] }, /has no id/],
  ])
    assert.throws(() => parseLibrary(data), pattern);
});

test('fetchLibrary reads library.json under the root, aborts and reports a failed request', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push([url, init.signal]);
    return { ok: true, status: 200, json: async () => ({ version: 1, assets: [model('a')] }) };
  };
  const controller = new AbortController();
  const library = await fetchLibrary('/asset-library/', { fetch: fetcher, signal: controller.signal });
  assert.deepEqual(seen, [['/asset-library/library.json', controller.signal]]);
  assert.equal(assetUrl(library, 'a'), '/asset-library/film/boats/a/a_2k.gltf');
  await assert.rejects(() => fetchLibrary('/lib', { fetch: async () => ({ ok: false, status: 404 }) }), { name: 'RangeError', message: /\/lib\/library.json \(status 404\)/ });
});

test('tools/library-index.mjs writes an index the module accepts, models and skies, ids once', () => {
  const root = mkdtempSync(join(tmpdir(), 'lib-'));
  try {
    for (const dir of ['one/boats/boat_a', 'one/hdri', 'two/boats/boat_a', 'two/props/lamp'])
      mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'one/boats/boat_a/boat_a_2k.gltf'), '{}');
    writeFileSync(join(root, 'one/hdri/dusk_2k.hdr'), 'x');
    writeFileSync(join(root, 'two/boats/boat_a/boat_a_2k.gltf'), '{}');
    writeFileSync(join(root, 'two/props/lamp/lamp_2k.gltf'), '{}');
    const { index, repeats } = indexLibrary(root);
    assert.deepEqual(repeats, ['boat_a']);
    assert.deepEqual(index.assets.map((a) => [a.id, a.type, a.file]), [
      ['boat_a', 'model', 'one/boats/boat_a/boat_a_2k.gltf'],
      ['dusk', 'sky', 'one/hdri/dusk_2k.hdr'],
      ['lamp', 'model', 'two/props/lamp/lamp_2k.gltf'],
    ]);
    assert.equal(parseLibrary(index).assets.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const tables = { weather: WEATHER_SETTINGS, sky: SKY_SETTINGS, tonemap: TONEMAP_SETTINGS };
const live = (list, kind) => list.find((r) => r.live && r.kind === kind && !r.nullable);

test('a shot block is checked against each package\'s own rows and rules', () => {
  const num = live(TONEMAP_SETTINGS, 'number'),
    rebuild = TONEMAP_SETTINGS.find((r) => !r.live);
  const key = (time, value) => ({ time, value });
  checkShotSettings({ tonemap: { [num.name]: { keys: [key(0, num.min), key(4, num.max)] } } }, tables, 4);
  assert.throws(() => checkShotSettings({ nope: {} }, tables), { name: 'TypeError', message: /Unknown shot target nope/ });
  assert.throws(() => checkShotSettings({ tonemap: { nope: 1 } }, tables), { name: 'TypeError', message: /target tonemap row nope/ });
  assert.throws(() => checkShotSettings({ tonemap: { [num.name]: num.max + 1 } }, tables), { name: 'RangeError', message: new RegExp(num.name) });
  assert.throws(() => checkShotSettings({ tonemap: { [rebuild.name]: { keys: [key(0, rebuild.default)] } } }, tables), { name: 'RangeError', message: /not live/ });
  checkShotSettings({ tonemap: { [rebuild.name]: rebuild.default } }, tables, 4);
  for (const keys of [[], [key(2, num.min), key(2, num.max)], [key(3, num.min), key(1, num.max)], [key(0, num.min), key(5, num.max)], [key(-1, num.min)]])
    assert.throws(() => checkShotSettings({ tonemap: { [num.name]: { keys } } }, tables, 4), RangeError, JSON.stringify(keys));
  assert.throws(() => checkShotSettings({ tonemap: { [num.name]: { keys: [{ time: 0, value: num.min, ease: 'bounce' }] } } }, tables, 4), /ease is one of/);
  const nullable = WEATHER_SETTINGS.find((r) => r.nullable);
  assert.throws(() => checkShotSettings({ tonemap: { [num.name]: null } }, tables), RangeError);
  if (nullable) checkShotSettings({ weather: { [nullable.name]: null } }, tables);
});

test('keyed rows evaluate by kind: numbers through the ease, colours per channel, choices and nulls step, ends hold', () => {
  const num = live(TONEMAP_SETTINGS, 'number'),
    color = live(TONEMAP_SETTINGS, 'color'),
    choice = TONEMAP_SETTINGS.find((r) => r.live && r.kind === 'choice');
  const lo = num.min,
    hi = num.max;
  const block = {
    tonemap: {
      [num.name]: { keys: [{ time: 1, value: lo }, { time: 3, value: hi, ease: 'in' }, { time: 5, value: lo }] },
      [color.name]: { keys: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [0.2, 0.4, 0.6] }] },
      [choice.name]: { keys: [{ time: 0, value: choice.choices[0] }, { time: 2, value: choice.choices[1] }] },
    },
  };
  checkShotSettings(block, tables, 5);
  const at = (s) => shotSettingsAt(block, tables, s).tonemap;
  assert.equal(at(0)[num.name], lo, 'before the first key it holds the first value');
  assert.equal(at(1)[num.name], lo);
  assert.equal(at(2)[num.name], lo + (hi - lo) * 0.5, 'linear between the first and second keys (the first key eases linearly)');
  assert.equal(at(9)[num.name], lo, 'after the last key it holds the last value');
  const eased = shotSettingsAt({ tonemap: { [num.name]: { keys: [{ time: 0, value: lo, ease: 'in' }, { time: 2, value: hi }] } } }, tables, 1).tonemap[num.name];
  assert.equal(eased, lo + (hi - lo) * 0.25, 'ease in: a quarter at the half way');
  assert.deepEqual(at(1)[color.name], [0.1, 0.2, 0.3].map((x) => x));
  assert.equal(at(1)[choice.name], choice.choices[0]);
  assert.equal(at(2)[choice.name], choice.choices[1]);
  assert.deepEqual(JSON.stringify(shotSettingsAt(block, tables, 1.7)), JSON.stringify(shotSettingsAt(block, tables, 1.7)));
  const values = at(1);
  values[color.name][0] = 9;
  assert.deepEqual(at(1)[color.name], [0.1, 0.2, 0.3], 'the evaluated values are copies');
});

test('gradients blend stop by stop only when both keys have the same stops, else step', () => {
  const row = [...WEATHER_SETTINGS, ...SKY_SETTINGS].find((r) => r.kind === 'gradient' && r.live);
  if (!row) return;
  const a = row.default,
    b = a.map((s) => ({ ...s, color: s.color.map((x) => Math.min(1, x + 0.2)) })),
    fewer = a.slice(0, 2);
  const target = SKY_SETTINGS.includes(row) ? 'sky' : 'weather';
  const same = (keys) => shotSettingsAt({ [target]: { [row.name]: { keys } } }, tables, 1)[target][row.name];
  const mid = same([{ time: 0, value: a }, { time: 2, value: b }]);
  assert.ok(mid[0].color.every((x, i) => Math.abs(x - (a[0].color[i] + b[0].color[i]) / 2) < 1e-12));
  assert.deepEqual(same([{ time: 0, value: a }, { time: 2, value: fewer }]), a, 'other stops step at the key');
});

test('held non-live rows are listed for one write before the warm-up', () => {
  const rebuild = TONEMAP_SETTINGS.find((r) => !r.live && r.kind === 'number'),
    num = live(TONEMAP_SETTINGS, 'number');
  const block = { tonemap: { [rebuild.name]: rebuild.default, [num.name]: num.default } };
  assert.deepEqual(shotHeldRebuilds(block, tables), { tonemap: { [rebuild.name]: rebuild.default } });
  assert.deepEqual(shotHeldRebuilds({ tonemap: { [num.name]: num.default } }, tables), {});
});
