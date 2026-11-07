// @margoengine/sky/weather-fx: options, the cover map's frame, the occluder draws and the weather's culling variant on
// the tracing mock. That rain stops under roofs, splashes land and the lens wets is proved on a real GPU by
// features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherFX } from '@margoengine/sky/weather-fx';
import { Weather } from '@margoengine/sky/weather';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

test('weather effects need a weather and check their options', () => {
  assert.throws(() => new WeatherFX(), /needs a Weather/);
  assert.throws(() => new WeatherFX({ weather: {} }), /needs a Weather/);
  const weather = new Weather();
  assert.doesNotThrow(() => new WeatherFX({ weather, resolution: 2048, splashes: 0, lensDrops: 500 }));
  for (const bad of [
    { resolution: 16 },
    { resolution: 100.5 },
    { splashes: -1 },
    { splashSize: 0 },
    { lensDrops: 501 },
    { dropSize: 1 },
    { ground: Infinity },
  ])
    assert.throws(() => new WeatherFX({ weather, ...bad }), /Invalid WeatherFX options/, JSON.stringify(bad));
  assert.throws(() => new WeatherFX({ weather, occluders: {} }), /occluders must be an array/);
});

test('the weather culls its particles under cover only while weather effects are attached', () => {
  const h = tracedGPU(),
    weather = new Weather({ intensity: 1, fadeSeconds: 0 });
  h.engine.use(weather);
  const frame = () => {
    weather.onPreUpdate(0.1);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  const plain = [...h.shaders.values()].join('\n');
  assert.doesNotMatch(plain, /rainCovered/, 'no effects, the weather shader is the one it always was');
  const fx = new WeatherFX({ weather });
  assert.ok(weather.occlusion, 'attaching hands the weather its cover');
  h.engine.use(fx);
  frame();
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /if\(rainCovered\(q\)\)\{return culled;\}/, 'the weather culls under cover');
  assert.match(code, /@compute @workgroup_size\(1\) fn main\(\)/, 'the lens wetness step');
  fx.dispose();
  assert.equal(weather.occlusion, undefined, 'disposing takes the cover back');
  weather.dispose();
});

test('the cover map follows the camera on its texel grid and draws each occluder with its own matrix', () => {
  const h = tracedGPU(),
    device = h.engine.gpu,
    weather = new Weather({ intensity: 1, fadeSeconds: 0, radius: 10, height: 12 }),
    vertex = device.createBuffer({ size: 800, usage: 0 }),
    index = device.createBuffer({ size: 24, usage: 0 }),
    matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1]),
    model = { shadowPrimitives: [{ node: { matrix }, vertex, index, count: 6, stride: 80 }] },
    fx = new WeatherFX({ weather, occluders: [model, model], resolution: 64 }),
    writes = [],
    write = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data, ...rest) => {
    writes.push(Float32Array.from(data));
    return write(buffer, offset, data, ...rest);
  };
  h.engine.use(weather);
  h.engine.use(fx);
  h.context.camera.position = [1.2, 7, -3.33];
  weather.onPreUpdate(0.1);
  fx.onPreUpdate(0.1);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  // The box is 20 m wide over 64 texels (0.3125 m): x0 = floor(1.2 / 0.3125) * 0.3125 - 10, z0 likewise; depth 0 is
  // 1,000 m over the camera and the range reaches the box's 12 m and a metre below it.
  const frame = writes.find((v) => v.length === 8);
  assert.deepEqual([...frame], [3 * 0.3125 - 10, -11 * 0.3125 - 10, 1 / 20, 1007, 1013, 64, 0, 0].map(Math.fround));
  assert.ok(h.created.some((r) => r.startsWith('texture(64,64,depth32float')), 'the cover map');
  const commands = h.commands();
  assert.equal(commands.filter((c) => c.startsWith('drawIndexed 6 1 0 0')).length, 2, 'both occluders, one draw each');
  assert.ok(commands.some((c) => c === 'drawIndexed 6 1 0 0 1'), "the second reads the second matrix");
  const models = writes.find((v) => v.length >= 32 && v[12] === 3 && v[28] === 3);
  assert.ok(models, 'both world matrices uploaded');
  fx.dispose();
  weather.dispose();
});
