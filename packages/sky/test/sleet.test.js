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
    if (data.length === 44) writes.push([buffer, Float32Array.from(data)]);
    return write(buffer, offset, data);
  };
  h.engine.use(weather);
  const frame = () => {
    weather.onPreUpdate(0.5);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  // 24,000 rain streaks and 16,000 flakes at intensity 1: ceil(24000 x 0.8 x 0.75) and ceil(16000 x 0.8 x 0.25).
  const draws = h.commands().filter((c) => c.startsWith('draw 6 '));
  assert.deepEqual(draws, ['draw 6 14400', 'draw 6 3200']);
  const [rain, snow] = writes.slice(-2);
  assert.notEqual(rain[0], snow[0], 'two uniforms: one buffer holds one draw');
  assert.deepEqual([rain[1][36], snow[1][36]], [0, 1], 'the snow flag');
  assert.deepEqual([rain[1][41], snow[1][41]], [9, Math.fround(1.2)], 'fall speeds (float32)');
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
