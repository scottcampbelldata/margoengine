// Weather: rain, snow and lightning, imported by the package specifier like an app does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Weather, lightningFlash, thunderDelay, speedOfSound } from '@margoengine/sky/weather';
import { MargoError } from '@margoengine/math/errors';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

/** Runs a Weather on the mock GPU, recording every render pass: [{ descriptor, draws: [[vertices, instances]] }]. */
function rig(options) {
  const h = optionalGPU(),
    passes = [];
  h.context.encoder.beginRenderPass = (descriptor) => {
    const record = { descriptor, draws: [] };
    passes.push(record);
    return {
      setPipeline() {},
      setBindGroup() {},
      setViewport() {},
      setScissorRect() {},
      draw: (vertices, instances = 1) => record.draws.push([vertices, instances]),
      end() {},
    };
  };
  const weather = new Weather(options);
  h.engine.use(weather);
  return { h, weather, passes };
}
const uniform = (h) => new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 176).data);

test('amount eases to the intensity over fadeSeconds and holds', () => {
  const w = new Weather({ intensity: 1, fadeSeconds: 4 });
  w.onPreUpdate(1);
  assert.equal(w.amount, 0.25);
  w.onPreUpdate(2);
  assert.equal(w.amount, 0.75);
  w.onPreUpdate(10);
  assert.equal(w.amount, 1);
  w.options.intensity = 0.2;
  w.onPreUpdate(4);
  assert.ok(Math.abs(w.amount - 0.2) < 1e-12, 'It falls back without overshooting');
  w.options.fadeSeconds = 0;
  w.options.intensity = 0.9;
  w.onPreUpdate(0.001);
  assert.equal(w.amount, 0.9, 'Zero fade jumps');
  w.options.precipitation = 'none';
  w.onPreUpdate(0.001);
  assert.equal(w.amount, 0, 'No precipitation is no amount whatever the intensity');
});

test('rain wets surfaces and dries again; snow settles and melts more slowly', () => {
  const w = new Weather({ precipitation: 'rain', intensity: 1, fadeSeconds: 0 });
  for (let i = 0; i < 100; i++) w.onPreUpdate(1);
  assert.ok(w.wetness > 0.98, `wet ${w.wetness}`);
  assert.equal(w.snowCover, 0);
  w.options.precipitation = 'none';
  for (let i = 0; i < 90; i++) w.onPreUpdate(1);
  assert.ok(w.wetness < 0.4 && w.wetness > 0.3, `drying ${w.wetness}`);
  w.options.precipitation = 'snow';
  for (let i = 0; i < 600; i++) w.onPreUpdate(1);
  assert.ok(w.snowCover > 0.99);
  assert.ok(w.wetness < 0.01, 'Snow does not wet');
  w.options.precipitation = 'none';
  for (let i = 0; i < 300; i++) w.onPreUpdate(1);
  assert.ok(w.snowCover > 0.3 && w.snowCover < 0.4, `melting ${w.snowCover}`);
});

test('the flash envelope rises in 8 ms, decays with 70 ms and is the brightest stroke', () => {
  assert.equal(lightningFlash(-0.01, [0], [1]), 0);
  assert.equal(lightningFlash(0, [0], [1]), 0);
  assert.equal(lightningFlash(0.008, [0], [1]), 1);
  assert.ok(Math.abs(lightningFlash(0.078, [0], [1]) - Math.exp(-1)) < 1e-12);
  assert.equal(
    lightningFlash(0.5, [0, 0.1], [1, 0.5]),
    Math.max(Math.exp(-0.492 / 0.07), 0.5 * Math.exp(-0.392 / 0.07)),
  );
  assert.ok(lightningFlash(0.108, [0, 0.1], [1, 0.9]) > 0.9 * 0.99, 'A return stroke relights the flash');
});

test('thunder arrives after distance over the speed of sound', () => {
  assert.equal(thunderDelay(343), 1);
  assert.equal(thunderDelay(3430), 10);
  assert.equal(thunderDelay(0), 0);
  assert.equal(thunderDelay(100, 100), 1);
  assert.equal(speedOfSound, 343);
  for (const bad of [[-1], [NaN], [Infinity], [10, 0], [10, -5], [10, NaN]])
    assert.throws(() => thunderDelay(...bad), RangeError, String(bad));
});

test('a manual strike flashes, reports once and thunders after its delay', () => {
  const w = new Weather({ intensity: 0, lightning: {} });
  const lightning = [],
    thunder = [];
  w.onLightning((s) => lightning.push(s));
  w.onThunder((s) => thunder.push([s, w.elapsed]));
  w.listener.set([10, 2, -5]);
  const s = w.strike({ distance: 686, azimuth: Math.PI / 2, strength: 0.8 });
  assert.equal(lightning.length, 1);
  assert.equal(lightning[0], s);
  assert.equal(s.id, 1);
  assert.equal(s.thunderDelay, 2);
  assert.ok(Math.abs(s.position[0] - (10 + 686)) < 1e-3 && Math.abs(s.position[2] + 5) < 1e-3);
  assert.equal(s.position[1], 0);
  assert.ok(s.strokes >= 1 && s.strokes <= 4);
  assert.ok(s.loudness > 0 && s.loudness < 1 && s.rumble >= 1);
  let peak = 0;
  for (let i = 0; i < 250; i++) {
    w.onPreUpdate(0.004);
    peak = Math.max(peak, w.flash);
  }
  assert.ok(peak > 0.7 && peak <= 0.8 + 1e-9, `peak ${peak}`);
  assert.ok(w.flash < 0.001, 'The flash has died away');
  assert.equal(thunder.length, 0, 'One second in, the thunder has not arrived');
  for (let i = 0; i < 300; i++) w.onPreUpdate(0.01);
  assert.equal(thunder.length, 1, 'Thunder is heard once');
  assert.ok(thunder[0][1] >= 2 && thunder[0][1] < 2.05, `heard at ${thunder[0][1]}`);
  assert.equal(thunder[0][0], s);
  assert.equal(lightning.length, 1);
});

test('listeners can be removed, a throwing one does not hide the others, and re-entry is refused', () => {
  const w = new Weather({ lightning: {} });
  const seen = [];
  const off = w.onLightning((s) => seen.push(['a', s.id]));
  w.onLightning(() => {
    throw new Error('listener failed');
  });
  w.onLightning((s) => seen.push(['c', s.id]));
  assert.throws(() => w.strike({ distance: 100 }), /listener failed/);
  assert.deepEqual(seen, [
    ['a', 1],
    ['c', 1],
  ]);
  off();
  assert.throws(() => w.strike({ distance: 100 }), /listener failed/);
  assert.deepEqual(seen.at(-1), ['c', 2]);
  assert.equal(seen.filter(([k]) => k === 'a').length, 1);
  const again = new Weather({});
  again.onLightning(() => again.strike());
  assert.throws(
    () => again.strike(),
    (e) => e instanceof MargoError && e.code === 'state' && /next frame/.test(e.message),
  );
  assert.throws(() => again.onLightning(1), TypeError);
  assert.throws(() => again.onThunder('x'), TypeError);
});

test('storms are deterministic by seed, need intensity above the threshold and scale with the rate', () => {
  const run = (options, seconds, intensity = 1) => {
    const w = new Weather({ intensity, fadeSeconds: 0, lightning: options });
    const strikes = [];
    w.onLightning((s) => strikes.push({ time: s.time, distance: s.distance, azimuth: s.azimuth, strokes: s.strokes }));
    for (let i = 0; i < seconds * 30; i++) w.onPreUpdate(1 / 30);
    return strikes;
  };
  const a = run({ seed: 7, rate: 12 }, 600),
    b = run({ seed: 7, rate: 12 }, 600),
    c = run({ seed: 8, rate: 12 }, 600);
  assert.deepEqual(a, b, 'Same seed, same storm');
  assert.notDeepEqual(a, c);
  // 12 strikes a minute for 10 minutes: 120 expected; a Poisson count stays within five sigma (about 55).
  assert.ok(a.length > 120 - 55 && a.length < 120 + 55, `count ${a.length}`);
  for (const s of a) assert.ok(s.distance >= 300 && s.distance <= 6000);
  assert.equal(run({ seed: 1 }, 300, 0.6).length, 0, 'At the threshold there is no rate');
  assert.equal(run({ seed: 1, rate: 0 }, 300).length, 0);
  assert.ok(run({ seed: 1, threshold: 0.2, rate: 30 }, 120, 0.6).length > 0);
  const half = run({ seed: 3, rate: 24 }, 600, 0.8).length, // (0.8 - 0.6) / 0.4 = half the rate: 120 expected
    full = run({ seed: 3, rate: 24 }, 600, 1).length; // 240 expected
  assert.ok(full > half * 1.4, `${half} vs ${full}`);
  const far = run({ seed: 5, rate: 30, minDistance: 1000, maxDistance: 1000 }, 60);
  assert.ok(far.length > 0 && far.every((s) => s.distance === 1000));
});

test('a long step makes at most one strike and a zero step none', () => {
  const w = new Weather({ intensity: 1, fadeSeconds: 0, lightning: { rate: 600, seed: 2 } });
  let n = 0;
  w.onLightning(() => n++);
  w.onPreUpdate(0);
  assert.equal(n, 0);
  w.onPreUpdate(3600);
  assert.ok(n <= 1);
});

test('invalid options name the problem and the fix', () => {
  const rejects = (options, type, text) =>
    assert.throws(
      () => new Weather(options),
      (e) => e instanceof type && text.test(e.message),
      JSON.stringify(options),
    );
  rejects({ precipitation: 'hail' }, TypeError, /"rain", "snow", "sleet" or "none"/);
  rejects({ intensity: 2 }, RangeError, /intensity must be a number from 0 to 1/);
  rejects({ intensity: NaN }, RangeError, /finite/);
  rejects({ intensity: '1' }, RangeError, /intensity/);
  rejects({ fadeSeconds: -1 }, RangeError, /fadeSeconds/);
  rejects({ radius: 1 }, RangeError, /radius/);
  rejects({ height: 500 }, RangeError, /height/);
  rejects({ particles: -1 }, RangeError, /particles/);
  rejects({ particles: 1e7 }, RangeError, /particles/);
  rejects({ opacity: 2 }, RangeError, /opacity/);
  rejects({ brightness: -1 }, RangeError, /brightness/);
  rejects({ wind: [1] }, TypeError, /\[x, z\]/);
  rejects({ wind: [1, 200] }, RangeError, /wind\[1\]/);
  rejects({ color: [-1, 0, 0] }, RangeError, /non-negative/);
  rejects({ lightning: 3 }, TypeError, /options object/);
  rejects({ lightning: { rate: -1 } }, RangeError, /lightning.rate/);
  rejects({ lightning: { threshold: 2 } }, RangeError, /threshold/);
  rejects({ lightning: { minDistance: 500, maxDistance: 100 } }, RangeError, /swap them/);
  rejects({ lightning: { color: [0, -1, 0] } }, RangeError, /non-negative/);
  assert.throws(() => new Weather({ color: [1, 1] }));
  const w = new Weather();
  w.options.intensity = 5;
  assert.throws(() => w.onPreUpdate(0.1), RangeError, 'Options are checked again each frame');
  w.options.intensity = 0.5;
  assert.throws(() => w.onPreUpdate(-1), RangeError);
  assert.throws(() => w.onPreUpdate(NaN), RangeError);
  assert.throws(() => w.strike({ distance: -1 }), RangeError);
  assert.throws(() => w.strike({ strength: 2 }), RangeError);
  assert.throws(() => w.strike({ azimuth: NaN }), RangeError);
});

test('it needs WebGPU, draws only while it rains and draws the share of particles the amount gives', () => {
  assert.throws(
    () => new Weather().setup({ gpu: undefined }),
    (e) => e instanceof MargoError && e.code === 'unsupported' && /WebGPU/.test(e.message),
  );
  const { h, weather, passes } = rig({ intensity: 1, fadeSeconds: 0, particles: 1000 });
  h.frame();
  const first = passes.at(-1);
  assert.deepEqual(first.draws, [[6, 1000]]);
  assert.equal(first.descriptor.depthStencilAttachment.depthReadOnly, true, 'Depth is tested, never written');
  const pipeline = h.pipelines.find((p) => p.fragment.targets[0].blend.color.srcFactor === 'src-alpha');
  assert.equal(pipeline.depthStencil.depthCompare, 'greater-equal');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.equal(pipeline.multisample.count, 4);
  weather.options.intensity = 0.25;
  h.frame();
  assert.deepEqual(passes.at(-1).draws, [[6, 250]]);
  weather.options.precipitation = 'none';
  const before = passes.length;
  h.frame();
  assert.equal(passes.length, before, 'Nothing is drawn without precipitation');
  weather.options.precipitation = 'snow';
  weather.options.particles = undefined;
  weather.options.intensity = 1;
  h.frame();
  assert.deepEqual(passes.at(-1).draws, [[6, 16000]], 'Snow defaults to 16,000 flakes');
  weather.options.precipitation = 'rain';
  h.frame();
  assert.deepEqual(passes.at(-1).draws, [[6, 24000]], 'Rain defaults to 24,000 streaks');
  weather.dispose();
});

test('the uniform carries the camera, the box, the wrapped drift, the colour and the viewport', () => {
  const { h, weather } = rig({
    intensity: 1,
    fadeSeconds: 0,
    radius: 10,
    height: 8,
    wind: [3, -2],
    color: [0.5, 0.25, 1],
    brightness: 2,
    opacity: 0.4,
  });
  h.context.delta = 1000.3;
  h.frame();
  const u = uniform(h);
  assert.deepEqual([...u.subarray(0, 16)], [...h.context.camera.matrix]);
  assert.deepEqual([...u.subarray(16, 19)], [0, 1, 4]);
  assert.deepEqual([...u.subarray(20, 23)], [20, 8, 20]);
  const wrap = (v, size) => ((v % size) + size) % size;
  assert.ok(Math.abs(u[24] - wrap(3 * 1000.3, 20)) < 1e-3, 'Wind drifts the box contents, wrapped in double precision');
  assert.ok(Math.abs(u[25] - wrap(-9 * 1000.3, 8)) < 1e-3);
  assert.ok(Math.abs(u[26] - wrap(-2 * 1000.3, 20)) < 1e-3);
  assert.deepEqual([...u.subarray(28, 32)], [1, 0.5, 2, Math.fround(0.4)]);
  assert.equal(u[32], 128);
  assert.equal(u[33], 96);
  assert.ok(Math.abs(u[34] - 96 / (2 * Math.tan(Math.PI / 6))) < 1e-3, 'Focal length in pixels from the 60 degree fov');
  assert.equal(u[36], 0, 'Rain');
  assert.deepEqual([u[40], u[41], u[42]], [3, 9, -2]);
  weather.options.precipitation = 'snow';
  h.frame();
  assert.equal(uniform(h)[36], 1);
  assert.equal(uniform(h)[41], Math.fround(1.2), 'Flakes fall at 1.2 m/s');
});

test('the listener follows the camera and a flash adds its colour to the frame', () => {
  const { h, weather, passes } = rig({ intensity: 0, lightning: { strength: 0.5, color: [1, 0.5, 0] } });
  h.context.camera.position = [7, 1, 9];
  h.context.delta = 0.0001;
  h.frame();
  assert.deepEqual([...weather.listener], [7, 1, 9]);
  assert.equal(passes.length, 0, 'No flash, no rain: no passes');
  weather.strike({ distance: 500, strength: 1 });
  h.context.delta = 0.008;
  h.frame();
  assert.equal(passes.length, 1);
  assert.deepEqual(passes[0].draws, [[3, 1]]);
  assert.equal(passes[0].descriptor.colorAttachments[0].loadOp, 'load');
  const flash = new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 16).data);
  assert.ok(
    Math.abs(flash[0] - 0.5) < 1e-6 && Math.abs(flash[1] - 0.25) < 1e-6 && flash[2] === 0,
    JSON.stringify([...flash]),
  );
  const pipeline = h.pipelines.find((p) => p.fragment.targets[0].blend.color.dstFactor === 'one');
  assert.ok(pipeline, 'Additive blend');
  assert.equal(pipeline.depthStencil, undefined);
  h.context.delta = 3;
  h.frame();
  assert.equal(passes.length, 1, 'The flash is over');
  const quiet = new Weather({ intensity: 0, lightning: { strength: 0 } });
  quiet.strike({ distance: 100 });
  quiet.onPreUpdate(0.008);
  assert.ok(quiet.flash > 0, 'The state still reports it, for lights that follow it');
});

test('precipitation is brightened by the flash through the uniform', () => {
  const { h, weather } = rig({ intensity: 1, fadeSeconds: 0, lightning: {} });
  weather.strike({ distance: 800 });
  h.context.delta = 0.008;
  h.frame();
  assert.ok(uniform(h)[39] > 0 && uniform(h)[39] <= 1);
});

test('dispose frees the GPU, is idempotent and blocks later use', () => {
  const { h, weather } = rig({ intensity: 1 });
  h.frame();
  const buffers = h.resources.filter((r) => r.size === 176 || r.size === 16);
  assert.ok(buffers.length >= 1);
  weather.dispose();
  weather.dispose();
  assert.ok(buffers.every((b) => b.destroyed));
  assert.throws(
    () => weather.onPreUpdate(0.1),
    (e) => e instanceof MargoError && e.code === 'disposed' && /new Weather/.test(e.message),
  );
  assert.throws(
    () => weather.strike(),
    (e) => e.code === 'disposed',
  );
  weather[Symbol.dispose]();
});

test('device restoration rebuilds the buffers and pipelines', () => {
  const { h, weather, passes } = rig({ intensity: 1, fadeSeconds: 0, particles: 10 });
  h.frame();
  const old = h.resources.filter((r) => r.size === 176);
  weather.onDeviceRestored(h.engine);
  assert.ok(old.every((b) => b.destroyed));
  h.frame();
  assert.deepEqual(passes.at(-1).draws, [[6, 10]]);
  assert.ok(h.resources.some((r) => r.size === 176 && !r.destroyed));
});
