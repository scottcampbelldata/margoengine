// The flame settings table (KB-LOOK-VFX-FIRE1): the rows, every default giving the kit's own numbers back, the animatedFeature
// look moving size, radiance, the core-to-edge colour ramp and the embers, ranges refused, and a Fire's real particles taking it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { snowNight } from '../../sky/dist/scene-kits.js';
import {
  FLAME_LIVE_SETTINGS,
  FLAME_LOOKS,
  FLAME_SETTINGS,
  applyFlameSettings,
  flameSettingDefaults,
} from '../dist/settings.js';
import { Fire } from '../dist/fire.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const hearth = snowNight().hearth;
// A target built the way a Fire builds its parts: the kit's data as the effect's options.
const part = (data) => ({ options: { ...structuredClone(data), intensity: data.intensity } });
const target = () => ({ particles: { flames: part(hearth.fire), embers: part(hearth.embers) } });
const snapshot = (t) => JSON.stringify([t.particles.flames.options, t.particles.embers.options]);

test('every flame row is live, well formed and named once', () => {
  assert.equal(FLAME_SETTINGS.length, 15);
  assert.deepEqual(FLAME_LIVE_SETTINGS, FLAME_SETTINGS);
  assert.equal(new Set(FLAME_SETTINGS.map((s) => s.name)).size, FLAME_SETTINGS.length);
  for (const s of FLAME_SETTINGS) {
    assert.ok(s.about.length > 20, s.name);
    assert.ok(['flames', 'embers'].includes(s.group), s.name);
  }
  assert.notEqual(flameSettingDefaults()['flames.edgeColor'], flameSettingDefaults()['flames.edgeColor']);
});

test('the defaults give the kit its own numbers back, after any look', () => {
  const t = target(),
    before = snapshot(t);
  applyFlameSettings(t, {});
  assert.equal(snapshot(t), before, 'the defaults change nothing');
  applyFlameSettings(t, FLAME_LOOKS.animatedFeature);
  assert.notEqual(snapshot(t), before);
  applyFlameSettings(t, FLAME_LOOKS.natural);
  assert.equal(snapshot(t), before, 'the natural look restores the kit');
});

test('the animatedFeature look makes larger softer flames with a ramp, and fewer larger embers', () => {
  const t = target(),
    f = hearth.fire,
    e = hearth.embers;
  applyFlameSettings(t, FLAME_LOOKS.animatedFeature);
  const fo = t.particles.flames.options,
    eo = t.particles.embers.options;
  assert.ok(Math.abs(fo.size - f.size * 1.5) < 1e-9, 'larger flames');
  assert.ok(Math.abs(fo.intensity - f.intensity * 0.75) < 1e-9, 'a lower peak radiance, no blowout');
  assert.ok(Math.abs(fo.color[3] - f.color[3] * 0.85) < 1e-9, 'softer opacity');
  const stops = fo.curves.color;
  assert.deepEqual(
    stops[0].color,
    [...f.curves.color[0].color].map(
      (v, i) => v + (FLAME_LOOKS.animatedFeature['flames.edgeColor'][i] - v) * 0.6 * f.curves.color[0].at,
    ),
  );
  const last = stops.length - 1,
    from = f.curves.color[last];
  from.color.forEach((v, i) =>
    assert.ok(
      Math.abs(stops[last].color[i] - (v + (FLAME_LOOKS.animatedFeature['flames.edgeColor'][i] - v) * 0.6 * from.at)) <
        1e-9,
      `edge channel ${i}`,
    ),
  );
  assert.ok(eo.size > e.size * 2 && eo.rate < e.rate * 0.6, 'fewer, larger embers');
  assert.ok(Math.abs(eo.intensity - e.intensity * 0.8) < 1e-9);
});

test('values are checked against their rows', () => {
  const t = target();
  assert.throws(() => applyFlameSettings(t, { nope: 1 }), TypeError);
  assert.throws(() => applyFlameSettings(t, { 'flames.size': 0 }), RangeError);
  assert.throws(() => applyFlameSettings(t, { 'flames.ramp': 1.5 }), RangeError);
  assert.throws(() => applyFlameSettings(t, { 'embers.count': 5 }), RangeError);
  assert.throws(() => applyFlameSettings(t, { 'flames.edgeColor': [2, 0, 0] }), RangeError);
  const bare = { particles: { flames: { options: { size: 0.2 } } } };
  assert.throws(() => applyFlameSettings(bare, { 'flames.ramp': 0.5 }), TypeError, 'a ramp needs a colour curve');
});

test('a real Fire takes the look and keeps drawing', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  const fire = Fire.attach(h.engine, { position: [0, 0, 0] }),
    size = fire.particles.flames.options.size;
  applyFlameSettings(fire, FLAME_LOOKS.animatedFeature);
  assert.ok(Math.abs(fire.particles.flames.options.size - size * 1.5) < 1e-9);
  applyFlameSettings(fire, {});
  assert.equal(fire.particles.flames.options.size, size);
  fire.dispose();
  h.cleanup();
});

test('core, edge and peak give hearth flames the blackbody ramp after attach; flicker and tongues scale their turbulence; defaults give the kit back', async () => {
  const { flameRamp } = await import('../dist/flame.js'),
    t = target(),
    before = snapshot(t),
    f = hearth.fire;
  applyFlameSettings(t, {
    'flames.core': 2800,
    'flames.edge': 900,
    'flames.peak': 0.8,
    'flames.flicker': 2,
    'flames.tongues': 0.5,
  });
  const fo = t.particles.flames.options,
    ramp = flameRamp({ core: 2800, edge: 900, peak: 0.8 });
  fo.curves.color.forEach((s, k) => {
    const want = ramp[Math.min(k, ramp.length - 1)];
    assert.equal(s.at, want.at);
    s.color.forEach((v, c) => assert.ok(Math.abs(v - want.color[c]) < 1e-12, `stop ${k} channel ${c}`));
    assert.ok(Math.max(...s.color) <= 0.8 + 1e-12, 'no stop over the peak');
  });
  assert.ok(Math.abs(fo.turbulence - (f.turbulence ?? 0) * 2) < 1e-12, 'flicker scales the turbulence');
  assert.ok(Math.abs(fo.frequency - (f.frequency ?? 1) * 2) < 1e-12, 'smaller tongues are a finer noise');
  applyFlameSettings(t, {});
  assert.equal(snapshot(t), before, 'the defaults give the kit back');
});
