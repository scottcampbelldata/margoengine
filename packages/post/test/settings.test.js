// The settings table of @margoengine/post/settings: rows are well formed, the defaults written leave every effect's options
// meaning what they mean with none, ranges are enforced, the named looks are only row values that the effects accept, a null
// row removes its option, and the shutter row is the angle over 360. The real-GPU check (frame exact, counted objects, native
// and the WebGL2 layer) is test/settings-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bloom } from '../dist/bloom.js';
import { Lens } from '../dist/lens.js';
import { LensFlare } from '../dist/lens-flare.js';
import { Anamorphic } from '../dist/anamorphic.js';
import { MotionBlur } from '../dist/motion-blur.js';
import { GTAO } from '../dist/gtao.js';
import { SSAO } from '../dist/ssao.js';
import { SSGI } from '../dist/ssgi.js';
import { SSR } from '../dist/ssr.js';
import { ContactShadows } from '../dist/contact-shadows.js';
import { HeatHaze } from '../dist/heat-haze.js';
import { SMAA } from '../dist/smaa.js';
import { DOF } from '../../dof/dist/index.js';
import {
  POST_LIVE_SETTINGS,
  POST_LOOKS,
  POST_SETTINGS,
  applyPostSettings,
  postSettingDefaults,
} from '../dist/settings.js';

const rig = () => ({
  bloom: new Bloom(),
  lens: new Lens(),
  lensFlare: new LensFlare(),
  anamorphic: new Anamorphic(),
  motionBlur: new MotionBlur({ velocity: () => undefined }),
  dof: new DOF(),
  gtao: new GTAO(),
  ssao: new SSAO(),
  ssgi: new SSGI(),
  ssr: new SSR(),
  contactShadows: new ContactShadows(),
  heatHaze: new HeatHaze(),
  smaa: new SMAA(),
});
// A new effect built over the options an effect holds runs the effect's own range check (each frame checks the same).
const revalidate = (targets) => {
  const classes = { bloom: Bloom, lens: Lens, lensFlare: LensFlare, anamorphic: Anamorphic, gtao: GTAO, ssao: SSAO };
  for (const [key, C] of Object.entries({
    ...classes,
    ssgi: SSGI,
    ssr: SSR,
    contactShadows: ContactShadows,
    heatHaze: HeatHaze,
    smaa: SMAA,
    dof: DOF,
  }))
    new C({ ...targets[key].options });
  new MotionBlur({ ...targets.motionBlur.options });
};
const groupOf = (name) => name.slice(0, name.indexOf('.'));

test('every row is well formed: a unique name in its group, a default in range, live a boolean', () => {
  assert.ok(POST_SETTINGS.length >= 60, `${POST_SETTINGS.length} rows`);
  const names = new Set();
  for (const row of POST_SETTINGS) {
    assert.ok(!names.has(row.name), `${row.name} is listed once`);
    names.add(row.name);
    assert.equal(groupOf(row.name), row.group, `${row.name} sits in its group`);
    assert.equal(typeof row.live, 'boolean', `${row.name} has live`);
    assert.ok(row.about.length > 20, `${row.name} says what it does`);
    if (row.nullable) assert.equal(row.default, null, `${row.name} is null by default`);
    else if (row.kind === 'number')
      assert.ok(row.default >= row.min && row.default <= row.max, `${row.name} default in range`);
    else if (row.kind === 'choice') assert.ok(row.choices.includes(row.default), `${row.name} default is a choice`);
    if (row.kind === 'number') assert.ok(row.min < row.max && row.step > 0, `${row.name} has a range and a step`);
  }
  assert.deepEqual(
    POST_SETTINGS.filter((row) => !row.live).map((row) => row.name),
    ['bloom.radius', 'motionBlur.maxBlur', 'dof.temporal', 'ssgi.multiBounce', 'ssr.stochastic'],
  );
  assert.equal(POST_LIVE_SETTINGS.length, POST_SETTINGS.length - 5);
  for (const g of [
    'bloom',
    'lens',
    'lensFlare',
    'anamorphic',
    'motionBlur',
    'dof',
    'gtao',
    'ssao',
    'ssgi',
    'ssr',
    'contactShadows',
    'heatHaze',
    'smaa',
  ])
    assert.ok(
      POST_SETTINGS.some((row) => row.group === g),
      `${g} has rows`,
    );
});

test('the defaults written leave every effect valid and meaning what it means with no options', () => {
  const targets = rig();
  applyPostSettings(targets, postSettingDefaults());
  revalidate(targets);
  const o = (key) => targets[key].options;
  // The effects' own documented defaults, as options.
  assert.deepEqual(o('bloom'), { strength: 0.8, threshold: 1, exposure: 0, radius: 0.5, fireflies: 'temporal' });
  assert.equal(o('motionBlur').shutter, 0.5, '180 degrees is half a frame');
  assert.equal('enabled' in o('gtao'), false, 'on is the absence of enabled: false');
  assert.equal('intensity' in o('lensFlare'), false, 'a null intensity removes the option');
  assert.equal('threshold' in o('smaa'), false, 'a null SMAA threshold keeps the quality preset');
  assert.equal(o('dof').aperture, 2.8);
  assert.equal(o('dof').temporal, false);
  assert.equal(o('ssgi').multiBounce, false);
  assert.deepEqual(o('anamorphic').tint, [0.4, 0.6, 1]);
  assert.equal(applyPostSettings({}, {}), undefined, 'defaults need no target');
});

test('rows write the option they name, the angle becomes the share, off becomes enabled false, null removes', () => {
  const targets = rig();
  applyPostSettings(targets, {
    'motionBlur.shutterAngle': 90,
    'bloom.strength': 1.5,
    'gtao.enabled': 'off',
    'lensFlare.intensity': 2,
    'lensFlare.color': [1, 0.5, 0.25],
    'smaa.quality': 'ultra',
    'smaa.threshold': 0.05,
    'ssr.stochastic': 'on',
    'dof.filmGauge': 36,
    'dof.sensorFit': 'horizontal',
  });
  assert.equal(targets.motionBlur.options.shutter, 0.25);
  assert.equal(targets.bloom.options.strength, 1.5);
  assert.equal(targets.gtao.options.enabled, false);
  assert.equal(targets.lensFlare.options.intensity, 2);
  assert.deepEqual(targets.lensFlare.options.color, [1, 0.5, 0.25]);
  assert.equal(targets.smaa.options.quality, 'ultra');
  assert.equal(targets.smaa.options.threshold, 0.05);
  assert.equal(targets.ssr.options.stochastic, true);
  assert.equal(targets.dof.options.filmGauge, 36);
  revalidate(targets);
  // Back to the defaults: enabled is gone, nullable options are removed.
  applyPostSettings(targets, {});
  assert.equal('enabled' in targets.gtao.options, false);
  assert.equal('intensity' in targets.lensFlare.options, false);
  assert.equal('threshold' in targets.smaa.options, false);
  assert.equal('filmGauge' in targets.dof.options, false);
});

test('a value outside its row throws RangeError, an unknown name TypeError, a missing effect TypeError', () => {
  const targets = rig();
  for (const row of POST_SETTINGS.filter((r) => r.kind === 'number')) {
    assert.throws(
      () => applyPostSettings(targets, { [row.name]: row.max + row.step }),
      RangeError,
      `${row.name} above its max`,
    );
    assert.throws(
      () => applyPostSettings(targets, { [row.name]: row.min - row.step }),
      RangeError,
      `${row.name} below its min`,
    );
    assert.throws(() => applyPostSettings(targets, { [row.name]: NaN }), RangeError, `${row.name} NaN`);
    if (!row.nullable)
      assert.throws(() => applyPostSettings(targets, { [row.name]: null }), RangeError, `${row.name} is not nullable`);
  }
  for (const row of POST_SETTINGS.filter((r) => r.kind === 'choice'))
    assert.throws(() => applyPostSettings(targets, { [row.name]: 'sideways' }), RangeError, `${row.name} choice`);
  assert.throws(() => applyPostSettings(targets, { 'bloom.nope': 1 }), TypeError);
  assert.throws(() => applyPostSettings(targets, { 'anamorphic.tint': [2, 0, 0] }), RangeError);
  for (const name of ['gtao.slices', 'ssgi.rays', 'motionBlur.samples', 'dof.maxRadius', 'smaa.maxSearchSteps'])
    assert.throws(() => applyPostSettings(targets, { [name]: 2.5 }), RangeError, `${name} whole`);
  assert.throws(
    () => applyPostSettings(targets, { 'ssao.radius': 0.2, 'ssao.bias': 0.3 }),
    RangeError,
    'bias above radius',
  );
  assert.throws(
    () => applyPostSettings(targets, { 'dof.focalDistance': 0.04 }),
    RangeError,
    'focus inside the focal length',
  );
  assert.throws(() => applyPostSettings({}, { 'bloom.strength': 1 }), /needs targets.bloom/);
  assert.throws(() => applyPostSettings({ bloom: targets.bloom }, { 'lens.distortion': 0.2 }), /needs targets.lens/);
  assert.doesNotThrow(
    () => applyPostSettings({ bloom: targets.bloom }, { 'bloom.strength': 0.8 }),
    'a default needs no target',
  );
});

test('a refused call writes nothing', () => {
  const targets = rig(),
    before = JSON.stringify(targets.bloom.options);
  assert.throws(() => applyPostSettings(targets, { 'bloom.strength': 1.2, 'gtao.slices': 9 }), RangeError);
  assert.equal(JSON.stringify(targets.bloom.options), before);
});

test('named looks are only row values, in range, and the effects accept them', () => {
  const index = new Map(POST_SETTINGS.map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(POST_LOOKS), [
    'natural',
    'cinematic',
    'dream',
    'animatedFeature',
    'documentary',
    'nightGlow',
  ]);
  assert.deepEqual(POST_LOOKS.natural, {});
  for (const [name, look] of Object.entries(POST_LOOKS)) {
    for (const key of Object.keys(look)) assert.ok(index.has(key), `${name} names the row ${key}`);
    const targets = rig();
    applyPostSettings(targets, look);
    revalidate(targets);
  }
  const targets = rig();
  applyPostSettings(targets, POST_LOOKS.documentary);
  assert.equal(targets.motionBlur.options.shutter, 0.25);
  assert.equal(targets.dof.options.aperture, 8);
  // The animatedFeature family turns sky occlusion on over 8 m (KB-LOOK-POST-SKYOCC1).
  const feature = rig();
  applyPostSettings(feature, POST_LOOKS.animatedFeature);
  assert.equal(feature.gtao.options.skyRadius, 8);
  assert.equal(feature.gtao.options.skySteps, 16);
  assert.equal(index.get('gtao.skyRadius').default, 0, 'off unless a look or a value sets it');
});
