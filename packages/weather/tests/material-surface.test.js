// KB-WEATHER-MATERIALSWET1: the Material-mesh side of Puddles, Snow and PrecipitationCover (`materialSurface`), the
// gltf/pbr lighting effect every @margoengine/materials mesh of the scene joins. The GPU proof that a wet Material
// matches a wet core surface is tests/material-wet-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Puddles } from '../dist/puddles.js';
import { Snow } from '../dist/snow.js';
import { PrecipitationCover } from '../dist/cover.js';

const shader = readFileSync(new URL('../../gltf/src/shader.ts', import.meta.url), 'utf8');
const input = shader.slice(shader.indexOf('struct Frame'), shader.indexOf('export const extendedPBRShader'));
const count = (text, part) => text.split(part).length - 1;

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
function fakeEngine() {
  const written = [];
  const gpu = {
    createBuffer: (d) => ({ size: d.size, destroy() {} }),
    createTexture: (d) => ({ width: d.size[0], height: d.size[1], destroy() {}, createView: () => ({}) }),
    queue: { writeBuffer: (buffer, _o, data) => written.push([buffer, [...data]]), writeTexture() {} },
  };
  return { engine: { gpu, sceneOf() {} }, written };
}

test('the surface hook wraps the whole gltf/pbr surface and chains a second entry ahead of the first, as on core', () => {
  const once = new Puddles({ wetness: 1 }).materialSurface.shader(input, 2);
  assert.equal(count(once, 'fn surface(i:Out,front:bool)->Surface {'), 1);
  assert.equal(count(once, 'fn weather_dry_surface(i:Out,front:bool)->Surface {'), 1);
  // The new surface reads the dry one (every map and feature read the material made) and then runs the code.
  const wrapper = once.slice(once.indexOf('fn surface(i:Out,front:bool)->Surface {'));
  assert.ok(wrapper.startsWith('fn surface(i:Out,front:bool)->Surface {var s=weather_dry_surface(i,front);{let weatherWater='));
  assert.ok(wrapper.trimEnd().endsWith('return s;}'));
  const twice = new Snow({ cover: 1 }).materialSurface.shader(once, 2);
  assert.ok(twice.includes('var s=weather_dry_surface(i,front);{let weatherCover='));
  assert.equal(count(twice, 'fn weather_dry_surface('), 1);
  assert.equal(count(twice, 'fn surface('), 1);
  // No single gltf/pbr surface: unchanged, so the effect leaves a replaced shader alone.
  const two = input + input.slice(input.indexOf('fn surface('), input.indexOf('return s;') + 12);
  assert.equal(new Puddles().materialSurface.shader(two, 2), two);
});

test('Puddles wets a Material surface with its core WGSL bound in group 2, with the noise once', () => {
  const puddles = new Puddles({ wetness: 1, coverage: 0.5 });
  const effect = puddles.materialSurface;
  assert.equal(puddles.materialSurface, effect, 'one effect object, so meshes compare it by identity');
  assert.equal(effect.order, -1);
  assert.equal(effect.owner, undefined);
  const code = effect.shader(input, 2);
  assert.match(code, /@group\(2\) @binding\(166\) var<uniform> weatherPuddles:WeatherPuddles;/);
  assert.doesNotMatch(code, /@group\(0\) @binding\(160\)/);
  assert.equal(count(code, 'fn weather_noise('), 1);
  assert.match(code, /weather_puddle_surface\(i\.position,s\.n,s\.base\.rgb,s\.roughness,s\.metal,true,weatherPuddles\)/);
  assert.ok(code.indexOf('let weatherWater=') > code.indexOf('fn weather_dry_surface('));
  assert.equal(effect.shader(input, 2), code, 'cached');
  puddles.options.wetSurfaces = false;
  assert.match(effect.shader(input, 2), /s\.metal,false,weatherPuddles\)/);
  assert.equal(effect.shader('fn replaced() {}', 2), 'fn replaced() {}');
  assert.deepEqual(effect.bindings(), [], 'no uniform before setup');
  puddles.dispose();
  assert.equal(effect.shader(input, 2), input);
});

test('Snow and Puddles compose on a Material as on core: snow code first, one lift, distinct slots', () => {
  const puddles = new Puddles({ wetness: 1 }),
    snow = new Snow({ cover: 0.8 });
  const code = snow.materialSurface.shader(puddles.materialSurface.shader(input, 2), 2);
  assert.equal(count(code, 'fn weather_noise('), 1);
  assert.match(code, /@group\(2\) @binding\(167\) var<uniform> weatherSnow:WeatherSnow;/);
  assert.ok(code.indexOf('let weatherCover=') < code.indexOf('let weatherWater='));
  assert.match(code, /weatherPosition\.y\+=weather_snow_depth\(p\.xz,1\.0,weatherSnow\);/);
  assert.equal(count(code, 'weatherPosition.y+='), 1);
  // A field reads its map in group 2 at the field slots.
  const field = { width: 2, depth: 2, origin: [0, 0], cellSize: 1, version: 1, fieldData: () => new Float32Array(8) };
  const drifted = new Snow({ cover: 0.8, field });
  const fieldCode = drifted.materialSurface.shader(input, 2);
  assert.match(fieldCode, /@group\(2\) @binding\(168\) var<uniform> weatherSnowField/);
  assert.match(fieldCode, /@group\(2\) @binding\(169\) var weatherSnowMap/);
  assert.match(fieldCode, /weather_snow_field_cover\(i\.position,weatherSnow\.a\.x\)/);
  assert.match(fieldCode, /weather_snow_field_uniform\(p\.xyz,weatherSnow\)/);
  // A vertex stage another package replaced keeps its shape; the snow is then colour and grain.
  const replaced = input.replace('o.clip=f.camera*p; o.position=p.xyz;', 'o.clip=f.camera*p;o.position=p.xyz;');
  const flat = snow.materialSurface.shader(replaced, 2);
  assert.ok(flat.includes('let weatherCover=') && !flat.includes('weatherPosition'));
});

test('Material bindings: the entry uniform at its slot, written once per change, the field once a frame', () => {
  const { engine, written } = fakeEngine();
  const puddles = new Puddles({ wetness: 0.5 });
  puddles.setup(engine);
  const effect = puddles.materialSurface;
  assert.equal(effect.owner, engine);
  puddles.onPreUpdate(0);
  const entries = effect.bindings();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].binding, 166);
  assert.equal(written.length, 1);
  assert.equal(written[0][1][0], 0.5);
  // A thousand meshes draw with the same values: one write, one entry list.
  for (let k = 0; k < 1000; k++) assert.equal(effect.bindings(), entries);
  assert.equal(written.length, 1);
  puddles.options.wetness = 0.9;
  effect.bindings();
  assert.equal(written.length, 2);
  assert.ok(Math.abs(written[1][1][0] - 0.9) < 1e-6);
  // A restored device starts with a new uniform, written again.
  puddles.onDeviceRestored(engine);
  puddles.onPreUpdate(0);
  assert.notEqual(effect.bindings()[0].resource.buffer, entries[0].resource.buffer);
  assert.equal(written.length, 3);
  puddles.dispose();
  assert.deepEqual(effect.bindings(), []);

  const field = { width: 2, depth: 2, origin: [0, 0], cellSize: 1, version: 1, fieldData: () => new Float32Array(8) };
  const snow = new Snow({ cover: 1, field });
  snow.setup(engine);
  snow.onPreUpdate(0);
  const snowEntries = snow.materialSurface.bindings();
  assert.deepEqual(
    snowEntries.map((e) => e.binding),
    [167, 168, 169],
  );
  const before = written.length;
  for (let k = 0; k < 100; k++) snow.materialSurface.bindings();
  assert.equal(written.length, before, 'the field uniform is written once a frame, not once a mesh');
  snow.onPreUpdate(0);
  snow.materialSurface.bindings();
  assert.equal(written.length, before + 1);
  snow.dispose();
});

test('the cover shelters Material surfaces after the entries, once its map exists', () => {
  const weather = { occlusion: {} };
  const capture = {
    name: 'capture',
    options: { weather },
    setup() {},
    registerPasses(g) {
      g.add({ name: 'sky:weather-fx:cover', order: 5.9, execute() {} });
    },
    dispose() {},
  };
  const cover = new PrecipitationCover(capture);
  const engine = { sceneOf() {}, gpu: {} };
  cover.setup(engine);
  const effect = cover.materialSurface;
  assert.equal(effect.order, -0.5);
  assert.equal(effect.owner, engine);
  const wet = new Puddles({ wetness: 1 }).materialSurface.shader(input, 2);
  assert.equal(effect.shader(wet, 2), wet, 'no map yet: unchanged, as the core pass');
  weather.occlusion = { buffer: {}, view: {} };
  const sheltered = effect.shader(wet, 2);
  assert.match(sheltered, /@group\(2\) @binding\(162\) var<uniform> weatherCoverFrame/);
  assert.match(sheltered, /weather_cover_water\(i\.position,s\.n,/);
  assert.deepEqual(
    effect.bindings().map((e) => e.binding),
    [162, 163],
  );
  cover.dispose();
});
