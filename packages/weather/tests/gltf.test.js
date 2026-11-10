import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLTFWeather } from '../dist/gltf.js';

const shader = readFileSync(new URL('../../gltf-pro/src/shader.ts', import.meta.url), 'utf8');
const input = shader.slice(shader.indexOf('struct Frame'), shader.indexOf('export const extendedPBRShader'));

test('imported surfaces share wetness, puddle rings and snow functions after texture sampling', () => {
  const effect = new GLTFWeather({ puddles: { wetness: 1 }, snow: { cover: 1 } });
  const code = effect.shader(input, 2);
  assert.match(code, /@group\(2\) @binding\(160\)/);
  assert.equal(code.match(/fn weather_noise\(/g).length, 1);
  assert.ok(code.indexOf('let weatherWater=') > code.indexOf('s.base=textureSample'));
  assert.match(code, /s\.base=vec4f\(weatherWater\[0\]\.xyz,s\.base\.a\)/);
  assert.match(code, /weatherPosition\.y\+=weather_snow_depth/);
  assert.match(code, /weather_snow_normal\(i.position.xz,s.n,weatherCover,weatherGLTF.snow\)/);
  assert.throws(() => effect.shader('fn replaced() {}', 2), { code: 'unsupported' });
});

test('uniforms track weather, model attachment is reversible, and restoration releases buffers', () => {
  const written = [], destroyed = [];
  const engine = { gpu: { createBuffer: () => ({ destroy() { destroyed.push(1); } }), queue: {
    writeBuffer: (_b, _o, data) => written.push([...data]),
  } }, sceneOf() {} };
  const weather = { wetness: 0.4, state: { rain: 0.7 }, snowCover: 0.8 };
  const effect = new GLTFWeather({ puddles: { weather }, snow: { weather } });
  effect.setup(engine);
  let attached = 0;
  const model = { addLighting(e) { assert.equal(e, effect); attached++; return () => attached--; } };
  const remove = effect.add(model);
  assert.equal(effect.add(model), remove);
  assert.equal(attached, 1);
  weather.wetness = 1;
  effect.onPreUpdate(0.25);
  assert.equal(written.at(-1)[0], 1);
  assert.ok(Math.abs(written.at(-1)[8] - 0.8) < 1e-7);
  assert.equal(written.at(-1)[2], 0.25);
  effect.onDeviceRestored(engine);
  assert.equal(destroyed.length, 1);
  effect.dispose();
  assert.equal(attached, 0);
  assert.equal(destroyed.length, 2);
  assert.throws(() => effect.onPreUpdate(0), { code: 'disposed' });
  assert.throws(() => new GLTFWeather().setup({}), { code: 'unsupported' });
  assert.throws(() => new GLTFWeather({ snow: { cover: 2 } }), RangeError);
});
