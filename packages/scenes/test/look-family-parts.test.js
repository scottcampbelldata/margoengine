// applyLookFamily reaches every package (KB-SCENES-LOOKFAMILY-PARTS1): for each part alone, the family by name leaves
// the part in exactly the state that package's own apply function gives it for that family's LOOKS entry, moved off
// the defaults, and `natural` afterwards puts it back byte for byte. Each test gives the call one part only, so a part
// the call does not wire stays at its defaults and its test fails. No GPU: Water and TerrainColors draw into the
// recording device of tests/support.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Sky } from '@margoengine/sky';
import { SKY_LOOKS, applySkySettings } from '@margoengine/sky/settings';
import { Water } from '@margoengine/water';
import { WATER_LOOKS, applyWaterSettings } from '@margoengine/water/settings';
import { TerrainColors, heightfield } from '@margoengine/terrain';
import { TERRAIN_LOOKS, applyTerrainSettings } from '@margoengine/terrain/settings';
import { WEATHER_LOOKS, applyWeatherSettings, weatherStateOf } from '@margoengine/weather/settings';
import { Fog } from '@margoengine/environment';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { ENVIRONMENT_LOOKS, applyEnvironmentSettings } from '@margoengine/environment/settings';
import {
  FLAME_LOOKS,
  SAND_LOOKS,
  SMOKE_LOOKS,
  applyFlameSettings,
  applySandSettings,
  applySmokeSettings,
  sandSettingValues,
  smokeSettingValues,
} from '@margoengine/vfx/settings';
import { Tonemap } from '@margoengine/tonemap';
import { Grade } from '@margoengine/tonemap/grade';
import { TONEMAP_LOOKS, applyTonemapSettings } from '@margoengine/tonemap/settings';
import { Bloom, GTAO, SSGI } from '@margoengine/post';
import { POST_LOOKS, applyPostSettings } from '@margoengine/post/settings';
import { BIOME_LOOKS, MATERIALS, biomeMaterials } from '@margoengine/biomes/view';
import { LOOK_FAMILIES, applyLookFamily } from '@margoengine/scenes/look-family';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// Every table names both families, so the call needs no special case for either.
const TABLES = {
  sky: SKY_LOOKS,
  water: WATER_LOOKS,
  terrain: TERRAIN_LOOKS,
  weather: WEATHER_LOOKS,
  environment: ENVIRONMENT_LOOKS,
  sand: SAND_LOOKS,
  smoke: SMOKE_LOOKS,
  fire: FLAME_LOOKS,
  tonemap: TONEMAP_LOOKS,
  post: POST_LOOKS,
  biomes: BIOME_LOOKS,
};
const json = (x) => JSON.stringify(x);

test('every package LOOKS table holds natural (no rows: the defaults) and a full animatedFeature', () => {
  for (const [part, table] of Object.entries(TABLES)) {
    for (const family of LOOK_FAMILIES) assert.ok(family in table, `${part} has ${family}`);
    if (part !== 'biomes') assert.deepEqual(table.natural, {}, `${part}.natural is the defaults`);
    assert.ok(Object.keys(table.animatedFeature).length >= 3, `${part}.animatedFeature has values`);
  }
});

/**
 * One part through the family call: `make()` gives a fresh target, `state(target)` its full state as a string,
 * `direct(target, values)` the package's own apply function, `part` the key of applyLookFamily's targets.
 */
const reaches = ({ part, make, state, direct, wrap = (t) => t }) => {
  const fresh = make(),
    plain = state(fresh),
    expected = make(),
    target = make();
  direct(wrap(expected), TABLES[part].animatedFeature);
  applyLookFamily('animatedFeature', { [part]: wrap(target) });
  const feature = state(target);
  assert.equal(feature, state(expected), `${part}: the family writes the table's animatedFeature values`);
  assert.notEqual(feature, plain, `${part}: the family moves the part off its defaults`);
  applyLookFamily('natural', { [part]: wrap(target) });
  const defaults = make();
  direct(wrap(defaults), TABLES[part].natural);
  assert.equal(state(target), state(defaults), `${part}: natural writes every row at its default`);
  return { natural: state(target), plain };
};

test('sky: the family reaches the Sky and natural gives back a sky that never had a look', () => {
  const r = reaches({
    part: 'sky',
    make: () => ({ sky: new Sky() }),
    state: (t) => json(t.sky.options),
    direct: applySkySettings,
  });
  assert.equal(r.natural, r.plain, 'byte-identical to a fresh Sky');
});

test('water: the family reaches the Water and natural gives back the uniform bytes of a fresh Water', () => {
  const harnesses = new Map();
  const make = () => {
    const h = optionalGPU(),
      water = new Water({ segments: 4 });
    h.engine.use(water);
    h.frame();
    harnesses.set(water, h);
    return water;
  };
  // The frame's 864 B uniform; index 20 is the wave clock, which every frame advances.
  const state = (water) => {
    const h = harnesses.get(water);
    h.frame();
    const v = new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 864).data).slice();
    v[20] = 0;
    return Buffer.from(v.buffer).toString('hex');
  };
  const r = reaches({ part: 'water', make, state, direct: applyWaterSettings });
  assert.equal(r.natural, r.plain, 'byte-identical to a fresh Water');
});

test('terrain: the family reaches the TerrainColors and natural gives back the colours of fresh ones', async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    mesh = engine.createMesh();
  mesh.setGeometry(heightfield((x, z) => x + z, { size: [10, 10], origin: [-1, -1], resolution: 2 }));
  const r = reaches({
    part: 'terrain',
    make: () => new TerrainColors(mesh),
    state: (colors) => Buffer.from(new Float32Array(colors.look).buffer).toString('hex'),
    direct: applyTerrainSettings,
  });
  assert.equal(r.natural, r.plain, 'byte-identical to fresh TerrainColors');
  engine.dispose();
});

test('weather: the family reaches the weather target and natural gives back the default state', () => {
  const make = () => {
    const t = { set: (s) => (t.state = s) };
    return t;
  };
  const r = reaches({ part: 'weather', make, state: (t) => json(t.state), direct: applyWeatherSettings });
  assert.equal(r.natural, json(weatherStateOf({})), 'the state of no settings');
});

test('environment: the family reaches the air and the scene fog, and natural gives back fresh ones', () => {
  const r = reaches({
    part: 'environment',
    make: () => ({ air: new VolumetricFog({}), fog: new Fog() }),
    state: (t) =>
      json([
        t.air.options,
        t.fog.enabled,
        t.fog.color,
        t.fog.near,
        t.fog.far,
        t.fog.density,
        t.fog.heightFalloff,
        t.fog.height,
      ]),
    direct: applyEnvironmentSettings,
  });
  assert.deepEqual(JSON.parse(r.natural)[0], {}, 'the air holds no option again, as a fresh VolumetricFog');
});

test('vfx: the family reaches blown sand, smoke and flames, and natural gives back their defaults', () => {
  const sand = reaches({
    part: 'sand',
    make: () => ({ options: {} }),
    state: (t) => json(sandSettingValues(t)),
    direct: applySandSettings,
  });
  assert.equal(sand.natural, sand.plain, 'byte-identical sand rows');
  const smoke = reaches({
    part: 'smoke',
    make: () => ({ options: {} }),
    state: (t) => json(smokeSettingValues(t)),
    direct: applySmokeSettings,
  });
  assert.equal(smoke.natural, smoke.plain, 'byte-identical smoke rows');
  const kit = () => ({
    particles: {
      flames: {
        options: {
          size: 0.2,
          intensity: 40,
          curves: {
            color: [
              { at: 0, color: [1, 0.8, 0.3] },
              { at: 1, color: [0.8, 0.2, 0.05] },
            ],
          },
        },
      },
    },
  });
  const fire = reaches({ part: 'fire', make: kit, state: (t) => json(t.particles), direct: applyFlameSettings });
  assert.equal(fire.natural, fire.plain, 'byte-identical flames');
});

test('tonemap: the family reaches the Tonemap and its Grade, and natural writes every row at its default', () => {
  reaches({
    part: 'tonemap',
    make: () => ({ tonemap: new Tonemap(), grade: new Grade() }),
    state: (t) => json([t.tonemap.options, t.grade.options]),
    direct: applyTonemapSettings,
  });
});

test('post: the family reaches every effect it names, and natural writes every row at its default', () => {
  reaches({
    part: 'post',
    make: () => ({
      bloom: new Bloom(),
      gtao: new GTAO(),
      ssgi: new SSGI(),
      dof: { options: {} },
      lens: { options: {} },
      motionBlur: { options: {} },
    }),
    state: (t) => json(Object.fromEntries(Object.entries(t).map(([k, e]) => [k, e.options]))),
    direct: applyPostSettings,
  });
});

test('biomes: the family writes the ground materials of a BiomeView, natural the built-in materials as they are', () => {
  const r = reaches({
    part: 'biomes',
    make: () => ({}),
    state: (t) => json(t.materials),
    direct: (t, values) => (t.materials = biomeMaterials(values)),
  });
  assert.equal(r.natural, json(MATERIALS), 'natural is MATERIALS, colour for colour');
});
