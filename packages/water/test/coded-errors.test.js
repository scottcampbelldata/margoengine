// KB-WATER-CODED1: every `Water` refusal is a coded error with a help link, never a bare RangeError or TypeError.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Water } from '../dist/index.js';
import { seaState } from '../dist/sea-state.js';

const refused = (error) => {
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'unsupported');
  assert.match(error.message, /^[^;]+(;[^;]+)*; see https:\/\/margoengine\.com\/errors#ocean$/);
  assert.doesNotMatch(error.message, /\.; see/);
  return true;
};
const wave = { direction: [1, 0], amplitude: 0.1, wavelength: 5 };
const flat = () => ({ heightmap: () => undefined, origin: [0, 0], size: [10, 10] });

test('every refused Water option is a coded error that links to the errors page', () => {
  const bad = {
    size: { size: [0, 1] },
    color: { color: [2, 0, 0] },
    sea: { sea: {} },
    reflection: { reflection: 3 },
    spray: { spray: true },
    shadows: { shadows: {} },
    fill: { fill: () => 0 },
    lights: { lights: [{}, {}, {}] },
    light: { lights: [{ direction: [0, 1, 0, 1] }] },
    zeroLight: { lights: [{ direction: [0, 0, 0, 1], radiance: [1, 1, 1] }] },
    negativeLight: { lights: [{ direction: [0, 1, 0, 1], radiance: [-1, 1, 1] }] },
    terrain: { terrain: { ...flat(), size: [0, 10] } },
    wave: { waves: [{ ...wave, wavelength: 0 }] },
    whitecaps: { whitecaps: 2 },
    chop: { chop: -1 },
    wind: { wind: 101 },
    fetch: { wind: { speed: 5, fetch: 0 } },
    direction: { wind: { speed: 5, direction: [0, 0] } },
  };
  for (const [name, options] of Object.entries(bad)) assert.throws(() => new Water(options), refused, name);
});

test('every refused Water setter is a coded error that links to the errors page', () => {
  const water = new Water({ segments: 4 }),
    own = new Water({ segments: 4, waves: [wave] });
  const calls = {
    setColor: () => water.setColor([2, 0, 0]),
    setSeaLevel: () => water.setSeaLevel(Number.NaN),
    farField: () => water.setFarField({ profile: [0], range: 1 }),
    farProfile: () => water.setFarField({ profile: [0, Number.NaN], range: 1 }),
    farRange: () => water.setFarField({ profile: [0, 0], range: 0 }),
    glitter: () => water.setGlitterRoughness(0),
    softness: () => water.setFoamSoftness(2),
    shallow: () => water.setShallow([0, 0, 0], 101),
    foamDistance: () => water.setFoamDistance(0),
    chop: () => water.setChop(2),
    whitecaps: () => water.setWhitecaps(2),
    setWind: () => water.setWind(101),
    ownWaves: () => own.setWind(5),
    waveHeight: () => water.setWaveHeight(-1),
    setTime: () => water.setTime(-1),
    capture: () => water.setCapture({}),
    onDispose: () => water.onDispose(3),
    seaState: () => seaState(-1),
  };
  for (const [name, call] of Object.entries(calls)) assert.throws(call, refused, name);
});

test('a setter on a disposed Water says disposed', () => {
  const water = new Water({ segments: 4 });
  water.dispose();
  for (const call of [() => water.setSeaLevel(0), () => water.setWind(5), () => water.setWaveHeight(0)])
    assert.throws(call, { name: 'MargoError', code: 'disposed' });
});

test('the Water class and its wind sea throw no bare RangeError or TypeError', () => {
  for (const file of ['index.ts', 'sea-state.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /new (RangeError|TypeError)\(/, file);
  }
});
