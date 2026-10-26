// Behaviour of the optional sky entries, imported by their package specifiers like an app does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky } from '@margoengine/sky/base';
import { preetham } from '@margoengine/sky/preetham';
import { bruneton } from '@margoengine/sky/bruneton';
import { clouds } from '@margoengine/sky/clouds';
import { lighting } from '@margoengine/sky/lighting';
import { fog } from '@margoengine/sky/fog';
import { reflection } from '@margoengine/sky/reflection';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';
import { trace } from './traces.js';

const code = (h) => [...h.shaders.values()].join('\n');

test('sky/preetham supplies the analytic day model and only that model', () => {
  assert.match(preetham.wgsl, /fn preetham\(w:vec3f,s:vec3f\)/);
  const h = trace(Sky, 'preetham', { preetham, reflection });
  assert.match(code(h), /fn preetham\(/);
  assert.doesNotMatch(code(h), /fn lookup\(/, 'No Bruneton tables in a Preetham-only sky');
  assert.ok(!h.created.some((r) => r.startsWith('texture(128,256')));
});

test('sky/bruneton precomputes its scattering tables and adds the lookup shader', () => {
  const h = trace(Sky, 'meadow', { bruneton, clouds, lighting });
  assert.match(code(h), /fn lookup\(/);
  assert.ok(h.created.filter((r) => r.startsWith('texture(128,256')).length >= 5, 'Five ping-pong scattering textures');
  assert.throws(() => new Sky({ model: 'bruneton' }, { preetham }), /model 'bruneton' needs bruneton/);
  assert.equal(typeof bruneton.create, 'function');
});

test('sky/fog validates its options and draws only when a scene depth is given', () => {
  const depth = () => undefined;
  assert.doesNotThrow(() => fog.validate({ depth, density: 0.02, start: 10, falloff: 'exp2' }));
  for (const bad of [
    { depth, density: 2 },
    { depth, density: -1 },
    { depth, falloff: 'linear' },
    { depth, start: -1 },
    { density: 0.01 },
  ])
    assert.throws(() => fog.validate(bad), /Invalid sky fog/, JSON.stringify(bad));
  const h = trace(Sky, 'preetham-clouds-fog', { preetham, clouds, fog });
  assert.match(code(h), /fogFragment/);
});

test('sky/reflection allocates its 64x32 environment only when first read', () => {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 12, timeScale: 0 }, { preetham, reflection });
  h.engine.use(sky);
  const small = () => h.created.filter((r) => r.startsWith('texture(64,32'));
  assert.equal(small().length, 0, 'Nothing is built until the reflection is read');
  const texture = sky.reflectionTexture;
  assert.ok(texture, 'The reflection texture is handed out');
  assert.equal(small().length, 1);
  assert.match(code(h), /reflectSky/);
  sky.dispose();
});
