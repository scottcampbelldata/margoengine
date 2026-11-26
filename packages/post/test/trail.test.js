import test from 'node:test';
import assert from 'node:assert/strict';
import { TrailTexture, TRAIL_MAX_STAMPS } from '@margoengine/post/trail';
import { harness } from './support.js';

const calls = (log, name) => log.filter((e) => e[0] === name);
// One trail a frame writes its 32-byte uniform, then its stamps when it has any.
const stamps = (log) => {
  const e = calls(log, 'writeBuffer')[1];
  if (!e) return [];
  const b = Buffer.from(e[3], 'hex'),
    f = new Float32Array(b.buffer, b.byteOffset, b.length / 4),
    out = [];
  for (let i = 0; i < f.length; i += 4) out.push([f[i], f[i + 1], f[i + 2]]);
  return out;
};
const uniform = (log) => {
  const b = Buffer.from(calls(log, 'writeBuffer')[0][3], 'hex');
  return new Float32Array(b.buffer, b.byteOffset, 8);
};

test('a fast move is joined by stamps at most half a radius apart, so it leaves no gaps', async () => {
  const h = harness(),
    trail = TrailTexture.attach(h.engine, { radius: 0.05, speed: 0 });
  trail.move(0.1, 0.5);
  trail.move(0.9, 0.5);
  const drawn = stamps(h.gpu.record(() => h.frame()));
  assert.equal(drawn.length, 1 + 32, 'the first sample and 0.8 / 0.025 = 32 joining stamps');
  for (let i = 1; i < drawn.length; i++) assert.ok(drawn[i][0] - drawn[i - 1][0] <= 0.025 + 1e-6, `gap at ${i}`);
  assert.ok(Math.abs(drawn.at(-1)[0] - 0.9) < 1e-6);
  // `interpolate` caps the joining stamps; 0 stamps the samples only.
  trail.options.interpolate = 0;
  trail.lift();
  trail.move(0.1, 0.2);
  trail.move(0.9, 0.2);
  assert.equal(stamps(h.gpu.record(() => h.frame())).length, 2);
  trail.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});

test('speed weights moves, not stamps; smoothing lags the samples', () => {
  const h = harness(),
    trail = TrailTexture.attach(h.engine, { speed: 2, intensity: 0.5, radius: 1 });
  trail.move(0, 0);
  trail.move(0.5, 0); // 0.5 widths in 1 s at speed 2: a quarter of full strength
  trail.stamp(0.3, 0.3, 2);
  // The harness frames pass delta 0; this one lasts a second.
  const update = TrailTexture.prototype.onPreUpdate;
  trail.onPreUpdate = () => update.call(trail, 1);
  const log = h.gpu.record(() => h.frame());
  delete trail.onPreUpdate;
  const drawn = stamps(log);
  assert.deepEqual(
    drawn.map((s) => s[2]),
    [0.125, 0.125, 1],
    'moves: intensity x speed factor; the stamp: strength x intensity',
  );
  assert.ok(Math.abs(uniform(log)[0] - 0.95 ** 60) < 1e-6, 'one second of decay');
  trail.dispose();
  const smooth = TrailTexture.attach(h.engine, { smoothing: 0.75, interpolate: 0, speed: 0 });
  smooth.move(0, 0);
  smooth.move(1, 0);
  assert.deepEqual(
    stamps(h.gpu.record(() => h.frame())).map((s) => s[0]),
    [0, 0.25],
  );
});

test('the trail updates once a frame, keeps its texture, fades from black and refuses bad options', async () => {
  const h = harness(),
    trail = TrailTexture.attach(h.engine, { size: [64, 32] });
  const texture = trail.texture;
  assert.deepEqual([texture.width, texture.height, texture.format], [64, 32, 'rgba16float']);
  assert.equal(trail.source(h.engine.gpu), texture);
  const first = h.gpu.record(() => h.frame());
  assert.equal(uniform(first)[1], 1, 'the first frame starts from black');
  assert.equal(calls(first, 'copyTextureToTexture').length, 1);
  // A second execute in the same frame (another view) does nothing.
  const again = h.gpu.record(() => h.engine.frameGraph.execute(h.view.c));
  assert.equal(calls(again, 'copyTextureToTexture').length, 0);
  const steady = h.gpu.record(() => h.frame());
  for (const kind of ['texture', 'renderPipeline', 'group']) assert.equal(calls(steady, kind).length, 0, kind);
  assert.equal(uniform(steady)[1], 0);
  assert.equal(trail.texture, texture, 'one identity across frames');
  assert.equal(TRAIL_MAX_STAMPS, 4096);
  for (let i = 0; i < TRAIL_MAX_STAMPS + 10; i++) trail.stamp(0.5, 0.5);
  assert.equal(stamps(h.gpu.record(() => h.frame())).length, TRAIL_MAX_STAMPS);
  trail.options.blend = 'max';
  assert.equal(
    calls(
      h.gpu.record(() => h.frame()),
      'renderPipeline',
    ).length,
    1,
    'a blend change builds one pipeline',
  );
  for (const [key, value] of [
    ['decay', 0],
    ['decay', 1.5],
    ['radius', 0],
    ['smoothing', 1],
    ['interpolate', 1.5],
    ['speed', -1],
    ['intensity', Infinity],
  ]) {
    trail.options[key] = value;
    assert.throws(() => h.frame(), RangeError, `${key} ${value}`);
    delete trail.options[key];
  }
  trail.options.blend = 'multiply';
  assert.throws(() => h.frame(), TypeError);
  delete trail.options.blend;
  assert.throws(() => new TrailTexture({ size: 0 }), RangeError);
  assert.throws(() => trail.move(NaN, 0), RangeError);
  h.lose();
  assert.notEqual(trail.texture, texture, 'a device restore makes a new texture');
  trail[Symbol.dispose]();
  assert.equal(trail.texture, undefined);
  assert.throws(() => trail.setup(h.engine), { code: 'disposed' });
});
