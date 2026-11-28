// LightningGlow: the channel's light scattered once in fog or rain, its CPU twin against a fine integral, and the pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Weather } from '@margoengine/sky/weather';
import { LightningBolt, lightningChannel, CHANNEL_STRIDE } from '@margoengine/sky/lightning-bolt';
import {
  LightningGlow,
  MAX_GLOW_PIECES,
  lightningGlowPieces,
  lightningGlowRadiance,
  visibilityExtinction,
} from '@margoengine/sky/lightning-glow';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const hg = (c, g) => (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * c) ** 1.5);
const piece = (a, b) => Float32Array.of(...a, 1, ...b, 0);

// The single scattering double integral by brute force: fine steps along the ray where it is near the piece, and 96
// equal angles along the piece.
function fine(o, v, distance, a, b, sigma, g, radius) {
  const ab = sub(b, a),
    L = Math.hypot(...ab),
    u = ab.map((x) => x / L),
    end = Math.min(distance, Math.hypot(...sub(a, o)) + 200 + 14 / sigma),
    on = (s) => [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s],
    ray = (t) => [o[0] + v[0] * t, o[1] + v[1] * t, o[2] + v[2] * t];
  let sum = 0,
    t = 0;
  while (t < end) {
    const here = ray(t),
      closest = Math.min(L, Math.max(0, dot(sub(here, a), u))),
      near = Math.hypot(...sub(here, on(closest))),
      dt = Math.min(end - t, Math.max(0.05, near * 0.04)),
      X = ray(t + dt / 2),
      r = sub(X, a),
      s = dot(r, u),
      d = Math.max(radius, Math.hypot(...sub(X, on(s)))),
      low = Math.atan(-s / d),
      high = Math.atan((L - s) / d),
      N = 96;
    let inner = 0;
    for (let i = 0; i < N; i++) {
      const to = sub(on(s + d * Math.tan(low + ((high - low) * (i + 0.5)) / N)), X),
        far = Math.max(radius, Math.hypot(...to));
      inner += Math.exp(-sigma * far) * hg(dot(to, v) / far, g);
    }
    sum += dt * Math.exp(-sigma * (t + dt / 2)) * ((high - low) / d) * (inner / N);
    t += dt;
  }
  return sum * sigma;
}

test('the glow of 60 seeded rays and pieces matches a fine integral: median error under 1 percent', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647,
    errors = [];
  for (let i = 0; i < 60; i++) {
    const a = [(random() - 0.5) * 600, random() * 1500, -200 - random() * 1500],
      length = 10 + random() * 120,
      dir = [random() - 0.5, -random(), random() - 0.5],
      n = Math.hypot(...dir),
      b = a.map((x, k) => x + (dir[k] / n) * length),
      s = random() * 1.4 - 0.2,
      off = 10 ** (random() * 4 - 1.3),
      aim = a.map((x, k) => x + (b[k] - x) * s + (random() - 0.5) * off),
      o = [0, 3, 0],
      to = sub(aim, o),
      reach = Math.hypot(...to),
      v = to.map((x) => x / reach),
      distance = random() < 0.3 ? reach * (0.5 + random()) : Infinity,
      visibility = 10 ** (2.3 + random() * 2.2),
      anisotropy = random() * 0.7,
      want = fine(o, v, distance, a, b, 3.912 / visibility, anisotropy, 0.75),
      got = lightningGlowRadiance({ origin: o, direction: v, distance }, piece(a, b), 1, { visibility, anisotropy });
    errors.push(Math.abs(got / want - 1));
  }
  errors.sort((x, y) => x - y);
  const at = (p) => errors[Math.floor(p * (errors.length - 1))],
    report = `median ${at(0.5).toFixed(4)}, p95 ${at(0.95).toFixed(4)}, max ${at(1).toFixed(4)}`;
  console.log(`glow quadrature error: ${report}`);
  assert.ok(at(0.5) < 0.01, report);
  assert.ok(at(0.95) < 0.08, report);
  assert.ok(at(1) < 0.2, report);
});

const bar = piece([-50, 100, -500], [50, 100, -500]);
const look = (target, medium, extra = {}) =>
  lightningGlowRadiance({ origin: [0, 100, 0], direction: sub(target, [0, 100, 0]), ...extra }, bar, 120, medium);

test('the glow falls off away from the channel, is cut by a surface, and is gone in clear or opaque air', () => {
  const near = look([0, 110, -500]),
    wide = look([0, 300, -500]);
  assert.ok(near > 3 * wide && wide > 0, `near ${near}, wide ${wide}`);
  const half = look([0, 110, -500], {}, { distance: 250 });
  assert.ok(half > 0 && half < 0.3 * near, `a wall half way leaves only the air in front: ${half} of ${near}`);
  assert.equal(look([0, 110, -500], {}, { distance: 0 }), 0);
  assert.equal(look([0, 110, -500], { albedo: 0 }), 0, 'air that only absorbs scatters nothing');
  const clear = look([0, 110, -500], { visibility: 100000 });
  assert.ok(clear < 0.1 * near, `clearer air scatters less: ${clear} of ${near}`);
  const opaque = look([0, 110, -500], { visibility: 30 });
  assert.ok(opaque < 1e-12, `air of 30 m visibility hides a channel 500 m off: ${opaque}`);
});

test('forward scattering brightens the air between the camera and the channel', () => {
  // A surface 400 m off, the channel 500 m: every scattering point is on the camera's side, where the light has to
  // carry on nearly the way it was going.
  const [forward, even, back] = [0.7, 0, -0.7].map((anisotropy) =>
    look([0, 110, -500], { anisotropy }, { distance: 400 }),
  );
  assert.ok(forward > even && even > back, `forward ${forward}, even ${even}, back ${back}`);
});

test('pieces follow the main channel from end to end and carry its crooked length', () => {
  const channel = lightningChannel({ seed: 7, start: [10, 1500, -20], end: [0, 0, 0] }),
    s = channel.segments;
  let path = 0;
  for (let i = 0; i < channel.trunk; i++) {
    const o = i * CHANNEL_STRIDE;
    path += Math.hypot(s[o + 4] - s[o], s[o + 5] - s[o + 1], s[o + 6] - s[o + 2]);
  }
  for (const count of [1, 16, MAX_GLOW_PIECES]) {
    const p = lightningGlowPieces(channel, count),
      last = (count - 1) * CHANNEL_STRIDE;
    assert.equal(p.length, count * CHANNEL_STRIDE);
    assert.deepEqual([...p.slice(0, 3)], [10, 1500, -20]);
    assert.deepEqual([...p.slice(last + 4, last + 7)], [0, 0, 0]);
    let carried = 0;
    for (let i = 0; i < count; i++) {
      const o = i * CHANNEL_STRIDE;
      if (i) assert.deepEqual([...p.slice(o, o + 3)], [...p.slice(o - 4, o - 1)], `piece ${i} follows ${i - 1}`);
      carried += p[o + 3] * Math.hypot(p[o + 4] - p[o], p[o + 5] - p[o + 1], p[o + 6] - p[o + 2]);
    }
    assert.ok(Math.abs(carried / path - 1) < 1e-4, `${count} pieces carry ${carried} of ${path} m`);
  }
});

function rig(options = {}, weatherOptions = {}) {
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
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
  const weather = new Weather({ intensity: 0, lightning: { seed: 5, strength: 0, ...weatherOptions } });
  h.engine.use(weather);
  const bolt = new LightningBolt({ weather });
  h.engine.use(bolt);
  // A sampleable scene depth of the frame's size, as sceneDepth() checks it.
  const depth = {
    format: 'depth24plus',
    dimension: '2d',
    depthOrArrayLayers: 1,
    sampleCount: 1,
    width: h.context.width,
    height: h.context.height,
    usage: GPUTextureUsage.TEXTURE_BINDING,
    createView: () => ({}),
  };
  const glow = new LightningGlow({ bolt, depth: () => depth, ...options });
  h.engine.use(glow);
  // The glow is the only pass that draws one fullscreen triangle.
  const drawn = () => passes.filter((p) => p.draws.some(([v]) => v === 3));
  return { h, weather, bolt, glow, drawn };
}

test('the pass draws one triangle while a strike is alight, and nothing before, after or at strength 0', () => {
  const { h, weather, glow, drawn } = rig();
  h.context.delta = 0.0001;
  h.frame();
  assert.equal(drawn().length, 0, 'no strike, no pass');
  weather.strike({ distance: 800, azimuth: 1, strength: 1 });
  h.context.delta = 0.008;
  h.frame();
  assert.equal(drawn().length, 1);
  assert.equal(drawn()[0].descriptor.depthStencilAttachment, undefined, 'the depth is read as a texture');
  glow.options.strength = 0;
  h.frame();
  assert.equal(drawn().length, 1, 'strength 0');
  glow.options.strength = 1;
  h.context.delta = 3;
  h.frame();
  const before = drawn().length;
  h.context.delta = 0.1;
  h.frame();
  assert.equal(drawn().length, before, 'nothing long after the last stroke');
  glow.dispose();
});

test('a held flash draws the last strike, and a bad option is a coded error', () => {
  const { h, weather, bolt, glow, drawn } = rig({}, { hold: 0.5 });
  h.context.delta = 0.0001;
  h.frame();
  weather.strike({ distance: 800, azimuth: 0 });
  h.context.delta = 5;
  h.frame();
  assert.equal(drawn().length, 1, 'held at 0.5, long after the strike');
  const depth = () => undefined;
  for (const bad of [
    undefined,
    { depth },
    { bolt, depth: 3 },
    { bolt, depth, visibility: 10 },
    { bolt, depth, albedo: 2 },
    { bolt, depth, anisotropy: 0.9 },
    { bolt, depth, strength: -1 },
    { bolt, depth, pieces: 0 },
    { bolt: new LightningBolt({ weather, field: () => undefined }), depth },
  ])
    assert.throws(() => new LightningGlow(bad), { name: 'MargoError', code: 'state' });
  assert.throws(() => visibilityExtinction(0), { code: 'state' });
  assert.throws(() => lightningGlowPieces(bolt.channelOf(weather.lastStrike), 65), { code: 'state' });
  assert.throws(() => lightningGlowRadiance({ origin: [0, 0, 0], direction: [0, 0, 0] }, bar, 1), { code: 'state' });
  glow.options.pieces = 99;
  assert.throws(() => h.frame(), /pieces/);
  glow.dispose();
  assert.throws(() => glow.setup(h.engine), { code: 'disposed' });
});
