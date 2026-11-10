// Regressions for the batch 132 audit of @margoengine/sky. Each test fails on the code before the audit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sky } from '@margoengine/sky';
import { Sky as SkyBase } from '@margoengine/sky/base';
import { AerialPerspective } from '@margoengine/sky/aerial';
import { AstroSky } from '@margoengine/sky/astro';
import { HillaireSky } from '@margoengine/sky/hillaire';
import { LightShafts } from '@margoengine/sky/shafts';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Weather } from '@margoengine/sky/weather';
import { WeatherFX } from '@margoengine/sky/weather-fx';
import { degrees } from '@margoengine/sky/sun';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};

const plugins = [
  ['Sky', () => new Sky()],
  ['base Sky', () => new SkyBase()],
  ['AerialPerspective', () => new AerialPerspective({ depth: () => undefined })],
  ['AstroSky', () => new AstroSky({ latitude: degrees(0), longitude: degrees(0) })],
  ['HillaireSky', () => new HillaireSky()],
  ['LightShafts', () => new LightShafts({ depth: () => undefined })],
  ['VolumetricClouds', () => new VolumetricClouds()],
  ['Weather', () => new Weather()],
  ['WeatherFX', () => new WeatherFX({ weather: new Weather() })],
];

for (const [label, make] of plugins)
  test(`${label}.dispose leaves the scene it was attached to, not the active scene`, async () => {
    const h = optionalGPU();
    h.engine.gpu.createPipelineLayout ??= (descriptor) => descriptor;
    const engine = new Engine(
      { width: 16, height: 16 },
      await TransformStore.create(4),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, dispose() {} },
      {},
      null,
    );
    try {
      const other = engine.createScene('other'),
        plugin = make();
      other.use(plugin);
      assert.equal(engine.sceneOf(plugin), other);
      plugin.dispose();
      assert.equal(other.plugins.size, 0, 'the disposed plugin stayed registered in its scene');
      assert.equal(engine.sceneOf(plugin), undefined);
    } finally {
      engine.dispose();
    }
  });
