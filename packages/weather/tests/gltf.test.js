import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLTFWeather } from '../dist/gltf.js';

const shader = readFileSync(new URL('../../gltf/src/shader.ts', import.meta.url), 'utf8');
const input = shader.slice(shader.indexOf('struct Frame'), shader.indexOf('export const extendedPBRShader'));

test('imported surfaces share wetness, puddle rings and snow functions after texture sampling', () => {
  const effect = new GLTFWeather({ puddles: { wetness: 1 }, snow: { cover: 1 } });
  const code = effect.shader(input, 2);
  assert.match(code, /@group\(2\) @binding\(160\)/);
  assert.equal(code.match(/fn weather_noise\(/g).length, 1);
  assert.ok(code.indexOf('let weatherWater=') > code.indexOf('s.base=textureSample'));
  assert.match(code, /s\.base=vec4f\(weatherWater\[0\]\.xyz,s\.base\.a\)/);
  // The lift is the depth on flat ground at the vertex's place, never by its normal: a hard edge's vertices share a
  // place and rise together, so its faces stay joined.
  assert.match(code, /weatherPosition\.y\+=weather_snow_depth\(p\.xz,1\.0,weatherGLTF\.snow\);/);
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

test('snow lifts an MToon outline hull with its body, and a shader without the standard projection is refused', async () => {
  const { extendedPBRShader } = await import('../../gltf/src/shader.ts');
  const { mtoonShader } = await import('../../rigging/src/mtoon-shader.ts');
  const effect = new GLTFWeather({ snow: { cover: 1 } });
  const code = effect.shader(mtoonShader(extendedPBRShader, 2, true), 2);
  const lift = code.indexOf('o.clip=f.camera*weatherPosition;o.position=weatherPosition.xyz;'),
    hull = code.indexOf('var world=vec4f(o.position,1.0);var clip=o.clip;');
  assert.ok(lift > 0 && hull > lift, 'the outline hull is built on the lifted position');
  const surface = input.replace('o.clip=f.camera*p; o.position=p.xyz;', 'o.clip=f.camera*p;o.position=p.xyz;');
  assert.throws(() => effect.shader(surface, 2), { code: 'unsupported' });
});
