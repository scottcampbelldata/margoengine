import assert from 'node:assert/strict';
import test from 'node:test';
import { VolumetricClouds, Weather, WeatherFX, thunderDelay } from '@margoengine/sky/compat-clouds';
import { VolumetricClouds as Clouds } from '@margoengine/sky/volumetric-clouds';
import { Weather as Precipitation } from '@margoengine/sky/weather';
import { WeatherFX as Effects } from '@margoengine/sky/weather-fx';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

test('compat clouds entry retains plugin identities and weather timing', () => {
  assert.equal(VolumetricClouds, Clouds);
  assert.equal(Weather, Precipitation);
  assert.equal(WeatherFX, Effects);
  assert.equal(thunderDelay(343), 1);
});

test('compat clouds entry composes the original cloud and weather passes', () => {
  const h = tracedGPU();
  const clouds = new VolumetricClouds();
  const weather = new Weather({ precipitation: 'sleet', intensity: 1, fadeSeconds: 0 });
  h.engine.use(clouds);
  h.engine.use(weather);
  clouds.onPreUpdate(1);
  weather.onPreUpdate(1);
  h.engine.frameGraph.execute(h.context);
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /texture_storage_3d/);
  assert.match(code, /cloudDensityAt/);
  assert.deepEqual([...clouds.drift], [10, 3, 3]);
  assert.equal(weather.amount, 1);
  clouds.dispose();
  weather.dispose();
  assert.throws(() => clouds.setup(h.engine), { code: 'disposed' });
  assert.throws(() => weather.setup(h.engine), { code: 'disposed' });
});
