// applyLookFamily: one call applies a family by name through each package's own apply function (no GPU).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky } from '@margoengine/sky';
import { SKY_LOOKS } from '@margoengine/sky/settings';
import { WEATHER_LOOKS, weatherStateOf } from '@margoengine/weather/settings';
import { FLAME_LOOKS, SAND_LOOKS, SMOKE_LOOKS } from '@margoengine/vfx/settings';
import { TONEMAP_LOOKS } from '@margoengine/tonemap/settings';
import { TERRAIN_LOOKS } from '@margoengine/terrain/settings';
import { WATER_LOOKS } from '@margoengine/water/settings';
import { ENVIRONMENT_LOOKS } from '@margoengine/environment/settings';
import { POST_LOOKS } from '@margoengine/post/settings';
import { LOOK_FAMILIES, applyLookFamily } from '@margoengine/scenes/look-family';

test('every package keeps the animatedFeature family in its own LOOKS table', () => {
  for (const [name, table] of Object.entries({
    SKY_LOOKS,
    WATER_LOOKS,
    TERRAIN_LOOKS,
    WEATHER_LOOKS,
    ENVIRONMENT_LOOKS,
    SAND_LOOKS,
    SMOKE_LOOKS,
    FLAME_LOOKS,
    TONEMAP_LOOKS,
    POST_LOOKS,
  }))
    assert.ok(Object.keys(table.animatedFeature).length >= 3, `${name}.animatedFeature has values`);
  assert.deepEqual(LOOK_FAMILIES, ['natural', 'animatedFeature']);
});

test('a family is applied by name through each package apply function, to the parts given', () => {
  const sky = new Sky(),
    weather = { set: (state) => (weather.state = state) },
    sand = { options: {} },
    smoke = { options: {} },
    fire = {
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
    },
    tonemap = { options: {} },
    grade = { options: {} };
  applyLookFamily('animatedFeature', { sky: { sky }, weather, sand, smoke, fire, tonemap: { tonemap, grade } });
  assert.equal(fire.particles.flames.options.size, 0.2 * 1.5, 'the flame rows');
  assert.equal(sky.options.look.sunDiscSoftness, 0.6, 'the sun edge');
  assert.equal(sky.options.look.zenithStrength, 0.35, 'sky look rows');
  assert.equal(sky.options.look.sunDiscSize, 2.2);
  assert.deepEqual(weather.state, weatherStateOf(WEATHER_LOOKS.animatedFeature), 'the weather state');
  assert.equal(sand.options.opacity, 0.45);
  assert.equal(smoke.options.radius, 1.5);
  assert.equal(tonemap.options.temperature, 5800, 'the tonemap warm key');
  assert.equal(grade.options.saturation, 1.12);
  // natural writes every row at its default again: the sky is as one that never had the look.
  applyLookFamily('natural', { sky: { sky }, weather, sand, smoke, fire, tonemap: { tonemap, grade } });
  assert.equal(fire.particles.flames.options.size, 0.2, 'the flames return to the kit');
  assert.equal('look' in sky.options, false);
  assert.deepEqual(weather.state, weatherStateOf({}));
  assert.equal(sand.options.opacity, 0.6, 'sand rows return to their defaults');
  assert.equal(tonemap.options.temperature, 6500);
  assert.equal(grade.options.saturation, 1);
});

test('KB-VFX-FRONTSMOKE-LOOK1: a fire front as the smoke part gets the look on its columns, their heat and radius kept', () => {
  const column = {
      options: {
        heat: 3e8,
        radius: 22,
        lifetime: 300,
        rate: 16,
        stability: 1.5e-4,
        color: [0.24, 0.22, 0.2],
        opacity: 0.6,
      },
    },
    front = {
      options: { wind: [12, 0] },
      smokeColumns: [column],
      setSmokeLook(write) {
        for (const c of this.smokeColumns) write(c);
      },
    };
  applyLookFamily('animatedFeature', { smoke: front });
  assert.deepEqual(column.options.color, [...SMOKE_LOOKS.animatedFeature.color]);
  assert.equal(column.options.opacity, SMOKE_LOOKS.animatedFeature.opacity);
  assert.equal(column.options.heat, 3e8, 'the front owns the heat');
  assert.equal(column.options.radius, 22, 'the front owns the radius');
  assert.deepEqual(front.options, { wind: [12, 0] }, 'nothing written onto the front');
  applyLookFamily('natural', { smoke: front });
  assert.deepEqual(column.options.color, [0.24, 0.22, 0.2], 'natural gives back the column as the front built it');
  assert.equal(column.options.rate, 16);
});

test('an unknown family throws before anything is written, and a part left out is left alone', () => {
  const sky = new Sky();
  assert.throws(() => applyLookFamily('claymation', { sky: { sky } }), /Unknown look family claymation/);
  assert.equal('look' in sky.options, false);
  applyLookFamily('animatedFeature', {});
  assert.equal('look' in sky.options, false);
});
