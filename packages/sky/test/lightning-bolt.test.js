// LightningBolt: the drawn, branching channel, its timing against the flash, and the light that follows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Weather } from '@margoengine/sky/weather';
import {
  LightningBolt,
  lightningChannel,
  channelLightPoints,
  strokeLevel,
  CHANNEL_STRIDE,
} from '@margoengine/sky/lightning-bolt';
import { SKY_SETTINGS, applySkySettings } from '@margoengine/sky/settings';
import { Sky } from '@margoengine/sky';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const grow = (o = {}) => lightningChannel({ seed: 7, start: [10, 1500, -20], end: [0, 0, 0], ...o });
const point = (ch, i, end) => [0, 1, 2].map((k) => ch.segments[i * CHANNEL_STRIDE + (end ? 4 : 0) + k]);
const trunkLength = (ch) => {
  let l = 0;
  for (let i = 0; i < ch.trunk; i++) l += Math.hypot(...point(ch, i, true).map((v, k) => v - point(ch, i, false)[k]));
  return l;
};

test('a channel is the same for the same seed and settings, and another seed gives another channel', () => {
  const a = grow(),
    b = grow(),
    c = grow({ seed: 8 });
  assert.deepEqual([...a.segments], [...b.segments]);
  assert.notDeepEqual([...a.segments].slice(0, 24), [...c.segments].slice(0, 24));
});

test('the main channel runs unbroken from the start to the end and every fork stays above the ground', () => {
  const ch = grow({ branching: 0.3 });
  assert.deepEqual(point(ch, 0, false), [10, 1500, -20]);
  assert.deepEqual(point(ch, ch.trunk - 1, true), [0, 0, 0]);
  for (let i = 1; i < ch.trunk; i++) assert.deepEqual(point(ch, i, false), point(ch, i - 1, true), `joint ${i}`);
  assert.ok(ch.count > ch.trunk + 10, `forks grew (${ch.count} segments, ${ch.trunk} on the main channel)`);
  for (let i = 0; i < ch.count; i++) {
    assert.ok(
      ch.segments[i * CHANNEL_STRIDE + 1] >= 0 && ch.segments[i * CHANNEL_STRIDE + 5] >= 0,
      `segment ${i} under the ground`,
    );
    const order = ch.segments[i * CHANNEL_STRIDE + 3];
    assert.ok(i < ch.trunk ? order === 0 : order >= 1, 'order marks forks');
  }
  // It wanders: longer than the straight line, but not by a multiple.
  const straight = Math.hypot(10, 1500, 20),
    length = trunkLength(ch);
  assert.ok(length > 1.02 * straight && length < 2.5 * straight, `length ${length} against ${straight}`);
});

test('no branching grows the main channel alone, more branching more forks, and the cap holds', () => {
  const none = grow({ branching: 0 }),
    some = grow({ branching: 0.1 }),
    many = grow({ branching: 0.5 });
  assert.equal(none.count, none.trunk);
  assert.ok(some.count > none.count && many.count > some.count);
  const capped = grow({ branching: 0.5, maxSegments: 120 });
  assert.ok(capped.count <= Math.max(120, capped.trunk));
  assert.ok(grow({ detail: 40 }).trunk < grow({ detail: 160 }).trunk, 'finer growth gives more steps');
  // A narrow cone runs straighter than a wide one.
  const seeds = [1, 2, 3, 4, 5, 6],
    narrow = seeds.reduce((s, seed) => s + trunkLength(grow({ seed, spread: 10, branching: 0 })), 0),
    wide = seeds.reduce((s, seed) => s + trunkLength(grow({ seed, spread: 80, branching: 0 })), 0);
  assert.ok(narrow < wide, `narrow ${narrow} against wide ${wide}`);
});

test('a bad channel setting is refused with its name', () => {
  assert.throws(() => grow({ start: [0, 0, 0], end: [0, 5, 0] }), RangeError);
  assert.throws(() => grow({ detail: 3 }), /detail/);
  assert.throws(() => grow({ branching: 0.9 }), /branching/);
  assert.throws(() => grow({ spread: 90 }), /spread/);
  assert.throws(() => grow({ maxSegments: 5000 }), /maxSegments/);
  assert.throws(() => grow({ end: [0, NaN, 0] }), TypeError);
  assert.throws(() => grow({ seed: NaN }), RangeError);
});

test('the lights along a channel share one light by height and sit on the channel', () => {
  const ch = grow({ branching: 0 }),
    pts = channelLightPoints(ch, 3, 700);
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts.reduce((s, p) => s + p.weight, 0) - 1) < 1e-9);
  assert.ok(pts[0].position[1] > pts[1].position[1] && pts[1].position[1] > pts[2].position[1], 'top to bottom');
  assert.ok(pts[2].weight > pts[1].weight && pts[1].weight > pts[0].weight, 'the low channel gives the most light');
  assert.ok(pts.every((p) => p.radius > 100 && p.position[1] > 0 && p.position[1] < 1500));
  assert.equal(channelLightPoints(ch, 1, 700).length, 1);
  assert.ok(Math.abs(channelLightPoints(ch, 8, 700).reduce((s, p) => s + p.weight, 0) - 1) < 1e-9);
  assert.throws(() => channelLightPoints(ch, 0, 700), RangeError);
  assert.throws(() => channelLightPoints(ch, 9, 700), RangeError);
  assert.throws(() => channelLightPoints(ch, 3, 0), RangeError);
  assert.ok(channelLightPoints(ch, 3, 5000)[0].weight > pts[0].weight, 'a longer decay length weights the top more');
});

test('strokeLevel rises in 8 ms and falls with its time constant; a second stroke makes the flicker', () => {
  assert.equal(strokeLevel(0, [0], [1], 0.03), 0);
  assert.ok(Math.abs(strokeLevel(0.008, [0], [1], 0.03) - 1) < 1e-12);
  assert.ok(Math.abs(strokeLevel(0.008 + 0.03, [0], [1], 0.03) - Math.exp(-1)) < 1e-12);
  const dip = strokeLevel(0.09, [0, 0.1], [1, 0.8], 0.03),
    second = strokeLevel(0.108, [0, 0.1], [1, 0.8], 0.03);
  assert.ok(dip < 0.1 && second > 0.75, `the channel dims between strokes (${dip}) and relights (${second})`);
});

function boltRig(options = {}, bolt = {}) {
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
      draw: (v, n = 1) => record.draws.push([v, n]),
      end() {},
    };
  };
  const weather = new Weather({ intensity: 0, lightning: { seed: 5, strength: 0, ...options } });
  h.engine.use(weather);
  const lightning = new LightningBolt({ weather, ...bolt });
  h.engine.use(lightning);
  return { h, weather, lightning, passes };
}
const bolts = (passes) => passes.filter((p) => p.draws.some(([v]) => v === 6));

test('a strike draws its channel, one instance a segment, from the first stroke to its fade, and not before or after', () => {
  const { h, weather, lightning, passes } = boltRig();
  h.context.delta = 0.0001;
  h.frame();
  assert.equal(bolts(passes).length, 0, 'no strike, no bolt');
  const strike = weather.strike({ distance: 800, azimuth: 1, strength: 1 });
  h.context.delta = 0.008;
  h.frame();
  const drawn = bolts(passes);
  assert.equal(drawn.length, 1);
  const channel = lightning.channelOf(strike);
  assert.deepEqual(drawn[0].draws, [[6, channel.count]]);
  assert.equal(drawn[0].descriptor.depthStencilAttachment.depthReadOnly, true, 'depth is tested, never written');
  const pipeline = h.pipelines.find((p) => p.fragment.targets[0].blend.color.operation === 'max');
  assert.equal(pipeline.depthStencil.depthCompare, 'greater-equal');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.ok(Math.hypot(channel.end[0] - strike.position[0], channel.end[2] - strike.position[2]) < 1e-3);
  assert.equal(channel.start[1], 1500);
  h.context.delta = 3;
  h.frame();
  const before = bolts(passes).length;
  h.context.delta = 0.1;
  h.frame();
  assert.equal(bolts(passes).length, before, 'nothing long after the last stroke');
});

test('the same seed and film times give the same bolt, and each strike has its own channel', () => {
  const channels = [0, 1].map(() => {
    const { h, weather, lightning } = boltRig();
    h.context.delta = 0.0001;
    h.frame();
    return lightning.channelOf(weather.strike({ distance: 900, azimuth: 2, strength: 1 }));
  });
  assert.deepEqual([...channels[0].segments], [...channels[1].segments]);
  const { weather, lightning } = boltRig();
  const a = lightning.channelOf(weather.strike({ distance: 900, azimuth: 2 })),
    b = lightning.channelOf(weather.strike({ distance: 900, azimuth: 2 }));
  assert.notDeepEqual([...a.segments].slice(0, 16), [...b.segments].slice(0, 16));
});

test('the bolt options act: scale 0 draws nothing, shape options grow the channel again, a held flash draws the last strike', () => {
  const { h, weather, lightning, passes } = boltRig({ bolt: { scale: 0 } });
  h.context.delta = 0.0001;
  h.frame();
  const strike = weather.strike({ distance: 800, azimuth: 0 });
  h.context.delta = 0.008;
  h.frame();
  assert.equal(bolts(passes).length, 0, 'scale 0');
  weather.options.lightning.bolt.scale = 1;
  weather.options.lightning.bolt.branching = 0;
  const plain = lightning.channelOf(strike);
  assert.equal(plain.count, plain.trunk);
  weather.options.lightning.bolt.branching = 0.4;
  assert.ok(lightning.channelOf(strike).count > plain.count, 'the same strike grows its forks when branching rises');
  weather.options.lightning.bolt.top = 900;
  assert.equal(lightning.channelOf(strike).start[1], 900);
  weather.options.lightning.hold = 0.5;
  h.context.delta = 5;
  h.frame();
  assert.equal(bolts(passes).length, 1, 'held at 0.5, long after the strike');
  weather.options.lightning.hold = 0;
  const n = bolts(passes).length;
  h.frame();
  assert.equal(bolts(passes).length, n, 'held at 0 draws no bolt');
});

test('bolt options are checked', () => {
  assert.throws(() => new Weather({ lightning: { bolt: { scale: -1 } } }), RangeError);
  assert.throws(() => new Weather({ lightning: { bolt: { width: 0 } } }), RangeError);
  assert.throws(() => new Weather({ lightning: { bolt: { branching: 1 } } }), RangeError);
  assert.throws(() => new Weather({ lightning: { bolt: 3 } }), TypeError);
  assert.throws(() => new Weather({ lightning: { light: { segments: 2.5 } } }), RangeError);
  assert.throws(() => new Weather({ lightning: { light: { segments: 9 } } }), RangeError);
  assert.throws(() => new Weather({ lightning: { light: { line: 'yes' } } }), TypeError);
  assert.throws(() => new LightningBolt({}), TypeError);
  assert.throws(() => new LightningBolt({ weather: new Weather(), coreRadiance: -1 }), RangeError);
  assert.doesNotThrow(() => new Weather({ lightning: { bolt: {}, light: { line: true, segments: 8 } } }));
});

// The light along the channel (lightning.light.line), through a light group like stormScene's in weather.test.js.
function groupScene(options, bolt = true) {
  const r = boltRig(options);
  if (!bolt) r.lightning.dispose();
  const sets = [];
  let lights = [];
  r.h.engine.use({
    name: 'clustered-groups',
    setup() {},
    isDisposed: false,
    clustered: { isDisposed: false, shadowSlots: 4 },
    get list() {
      return lights;
    },
    group: () => ({
      isDisposed: false,
      setLights(l) {
        lights = [...l];
        sets.push(l.map((x) => ({ ...x, position: [...x.position], shadow: x.shadow && { ...x.shadow } })));
      },
      dispose() {},
    }),
  });
  return { ...r, sets };
}
const flash = (r) => {
  const s = r.weather.strike({ distance: 1000, azimuth: 0, strength: 1 });
  r.h.context.delta = 0.008;
  r.h.frame();
  return s;
};

test('with a bolt the stroke lights the scene from lights along its channel, sharing the point light candela', () => {
  const r = groupScene({}),
    s = flash(r),
    list = r.sets.at(-1);
  assert.equal(list.length, 3);
  assert.ok(
    Math.abs(list.reduce((t, l) => t + l.intensity, 0) / r.weather.lightningLight.intensity - 1) < 1e-9,
    'the same total light',
  );
  const ch = r.lightning.channelOf(s);
  assert.ok(list.every((l) => l.position[1] > 0 && l.position[1] < ch.start[1] && l.radius > 50));
  assert.equal(new Set(list.map((l) => l.position[1])).size, 3);
  assert.equal(list.filter((l) => l.shadow).length, 1, 'one shadow map, on the brightest');
  assert.equal(list.find((l) => l.shadow).intensity, Math.max(...list.map((l) => l.intensity)));
  r.weather.options.lightning.rate = 0;
  for (let i = 0; i < 100; i++) {
    r.h.context.delta = 0.05;
    r.h.frame();
  }
  assert.equal(r.sets.at(-1).length, 0);
});

test('segments sets the count, line false or no bolt keeps the one point light', () => {
  const four = groupScene({ light: { segments: 4 } });
  flash(four);
  assert.equal(four.sets.at(-1).length, 4);
  const off = groupScene({ light: { line: false } });
  flash(off);
  assert.equal(off.sets.at(-1).length, 1);
  assert.equal(off.sets.at(-1)[0].position[1], 700);
  const none = groupScene({}, false);
  flash(none);
  assert.equal(none.sets.at(-1).length, 1, 'no LightningBolt, no channel');
  assert.equal(none.weather.channelSource, undefined);
  const on = groupScene({ light: { line: true } });
  flash(on);
  assert.equal(on.sets.at(-1).length, 3);
  on.lightning.dispose();
  assert.equal(on.weather.channelSource, undefined, 'disposing the bolt takes the channel back');
});

test('the lightning.bolt and lightning.light.line rows write the weather and hand back at their defaults', () => {
  const names = SKY_SETTINGS.filter((s) => /^lightning\.(bolt\.|light\.(line|segments))/.test(s.name)).map(
    (s) => s.name,
  );
  assert.deepEqual(names.sort(), [
    'lightning.bolt.branching',
    'lightning.bolt.detail',
    'lightning.bolt.fade',
    'lightning.bolt.glow',
    'lightning.bolt.scale',
    'lightning.bolt.spread',
    'lightning.bolt.top',
    'lightning.bolt.width',
    'lightning.light.line',
    'lightning.light.segments',
  ]);
  const sky = new Sky({}),
    weather = new Weather({ lightning: {} });
  applySkySettings(
    { sky, weather },
    {
      'lightning.bolt.glow': 100,
      'lightning.bolt.detail': 120,
      'lightning.light.segments': 5.4,
      'lightning.light.line': 'off',
      'lightning.bolt.scale': 2,
    },
  );
  const o = weather.options.lightning;
  assert.deepEqual(o.bolt, { scale: 2, glow: 100, detail: 120 });
  assert.equal(o.light.segments, 5);
  assert.equal(o.light.line, false);
  weather.onPreUpdate(0.01);
  applySkySettings({ sky, weather }, {});
  assert.equal(o.bolt.glow, undefined);
  assert.equal(o.light?.line, undefined);
  assert.equal(o.light?.segments, undefined);
  assert.throws(() => applySkySettings({ sky, weather }, { 'lightning.bolt.width': 0 }), RangeError);
  assert.throws(() => applySkySettings({ sky, weather }, { 'lightning.light.line': 'maybe' }), RangeError);
});
