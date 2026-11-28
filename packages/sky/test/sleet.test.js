// Weather sleet: rain and snow at once, each with its share of the particles, the wetness and the snow cover. That the
// two draws are exactly the rain and the snow drawn alone is proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Weather } from '@margoengine/sky/weather';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

test('sleet takes snowShare from 0 to 1 and reports the share that is rain', () => {
  assert.equal(new Weather().rainShare, 1);
  assert.equal(new Weather({ precipitation: 'snow' }).rainShare, 0);
  assert.equal(new Weather({ precipitation: 'none' }).rainShare, 0);
  assert.equal(new Weather({ precipitation: 'sleet' }).rainShare, 0.5);
  assert.equal(new Weather({ precipitation: 'sleet', snowShare: 0.25 }).rainShare, 0.75);
  assert.throws(() => new Weather({ precipitation: 'sleet', snowShare: 1.5 }), /snowShare/);
  assert.throws(() => new Weather({ precipitation: 'hail' }), /"rain", "snow", "sleet" or "none"/);
});

test('sleet wets and settles by share', () => {
  const sleet = new Weather({ precipitation: 'sleet', snowShare: 0.25, intensity: 0.6, fadeSeconds: 0 });
  // 4,000 s is 33 of snow's 120 s time constants: what is left of the approach is under 1e-15.
  for (let i = 0; i < 4000; i++) sleet.onPreUpdate(1);
  // Rain's goal is min(1, 1.5 amount) times its share, snow's the amount times its share.
  assert.ok(Math.abs(sleet.wetness - 0.9 * 0.75) < 1e-9, `wet ${sleet.wetness}`);
  assert.ok(Math.abs(sleet.snowCover - 0.6 * 0.25) < 1e-9, `snow ${sleet.snowCover}`);
});

test('sleet draws the rain and the snow, each with its share of the particles and its own uniform', () => {
  const h = tracedGPU(),
    weather = new Weather({ precipitation: 'sleet', snowShare: 0.25, intensity: 0.8, fadeSeconds: 0 }),
    writes = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === 56) writes.push([buffer, Float32Array.from(data)]);
    return write(buffer, offset, data);
  };
  h.engine.use(weather);
  const frame = () => {
    weather.onPreUpdate(0.5);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  // 24,000 rain streaks and 500,000 flakes at intensity 1 (flakes at their real size since KB-SNOW-NEARCAM2):
  // ceil(24000 x 0.8 x 0.75) and ceil(500000 x 0.8 x 0.25).
  const draws = h.commands().filter((c) => c.startsWith('draw 6 '));
  assert.deepEqual(draws, ['draw 6 14400', 'draw 6 100000']);
  const [rain, snow] = writes.slice(-2);
  assert.notEqual(rain[0], snow[0], 'two uniforms: one buffer holds one draw');
  assert.deepEqual([rain[1][36], snow[1][36]], [0, 1], 'the snow flag');
  // Rain keeps its 9 m/s; the snow carries its fall law's coefficient, each flake falling at 0.8 D^0.16 m/s for its own
  // size (KB-SNOW-FALLSPEED1).
  assert.deepEqual([rain[1][41], snow[1][41]], [9, Math.fround(0.8)], 'fall speeds (float32)');
  const seeds = [rain[1], snow[1]].map((v) => new Uint32Array(v.buffer)[38]);
  assert.notEqual(seeds[0], seeds[1], 'the snow on its own hash seed');
  // Plain rain is drawn once, as it always was.
  weather.options.precipitation = 'rain';
  frame();
  assert.deepEqual(
    h
      .commands()
      .filter((c) => c.startsWith('draw 6 '))
      .slice(2),
    ['draw 6 19200'],
  );
  weather.dispose();
});

// KB-SKY-SLEETLAW1: the rain's drop-size law (Marshall and Palmer) was read at the whole precipitation's intensity, so
// sleet at 0.6 with half snow drew the bigger, faster drops of rain at 0.6 where its rain is rain at 0.3.
test("sleet's rain takes the drop sizes of the rain drawn alone at its share of the intensity", () => {
  const uniformOf = (options) => {
    const h = tracedGPU(),
      weather = new Weather({ fadeSeconds: 0, ...options }),
      writes = [],
      queue = h.engine.gpu.queue,
      write = queue.writeBuffer.bind(queue);
    queue.writeBuffer = (buffer, offset, data) => {
      if (data.length === 56) writes.push(Float32Array.from(data));
      return write(buffer, offset, data);
    };
    h.engine.use(weather);
    weather.onPreUpdate(0);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
    return writes.find((v) => v[36] === 0);
  };
  const sleet = uniformOf({ precipitation: 'sleet', snowShare: 0.5, intensity: 0.6 }),
    rain = uniformOf({ precipitation: 'rain', intensity: 0.3 }),
    whole = uniformOf({ precipitation: 'rain', intensity: 0.6 });
  // The law's slope, span and smallest diameter, the fall's scale and the inverse mean streak light.
  const law = (v) => [48, 49, 50, 51, 54].map((i) => v[i]);
  assert.deepEqual(law(sleet), law(rain));
  assert.notDeepEqual(law(rain), law(whole), 'the law depends on the intensity, so the test can tell them apart');
});
