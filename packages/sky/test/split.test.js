import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Sky } from '../dist/index.js';
import { Sky as Base } from '../dist/base.js';
import { trace, configs } from './traces.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const entries = Object.fromEntries(
  await Promise.all(
    ['preetham', 'bruneton', 'clouds', 'night', 'fog', 'reflection', 'lighting'].map(async (name) => [
      name,
      (await import(`../dist/${name}.js`))[name],
    ]),
  ),
);
const fixtures = JSON.parse(await readFile(new URL('./fixtures/traces.json', import.meta.url), 'utf8'));
const pick = (names) => Object.fromEntries(names.map((name) => [name, entries[name]]));

test('the full Sky records exactly the GPU work, WGSL and uploads of the pre-split build', () => {
  for (const name of Object.keys(configs)) {
    const h = trace(Sky, name);
    assert.equal(h.digest(), fixtures[name].digest, name);
    assert.equal(h.commands().length, fixtures[name].commands, name);
  }
});

test('a sky built from only the features a scene uses uploads and encodes the same commands', () => {
  for (const [name, config] of Object.entries(configs)) {
    const full = trace(Sky, name),
      narrow = trace(Base, name, pick(config.features)),
      code = [...narrow.shaders.values()].join('\n');
    // Without Bruneton its scattering table is neither allocated nor bound; everything else is identical.
    const strip = (line) =>
      config.features.includes('bruneton') ? line : line.replace(/1=texture\(128,256,rgba16float,1,12\)#\d+,/, '');
    assert.deepEqual(narrow.commands('short'), full.commands('short').map(strip), name);
    assert.ok(narrow.created.length <= full.created.length, name);
    for (const [feature, marker] of [
      ['preetham', 'fn preetham('],
      ['bruneton', 'fn lookup('],
      ['clouds', 'fn cloudNoise('],
      ['night', 'fn stylizedNight('],
      ['fog', 'fogFragment'],
      ['reflection', 'reflectSky'],
    ])
      assert.equal(code.includes(marker), config.features.includes(feature), `${name}: ${feature}`);
    if (!config.features.includes('bruneton'))
      assert.ok(!narrow.created.some((r) => r.startsWith('texture(128,256')), 'No Bruneton tables without Bruneton');
  }
});

test('options and models that need a missing feature throw instead of rendering something else', () => {
  for (const key of ['clouds', 'fog', 'night', 'lighting'])
    assert.throws(
      () => new Base({ hours: 0, timeScale: 0, [key]: { depth: () => undefined } }),
      new RegExp(`Sky ${key} needs ${key} from @margoengine/sky/${key}`),
    );
  assert.throws(() => new Base({ model: 'bruneton' }, pick(['preetham'])), /model 'bruneton' needs bruneton/);
  assert.throws(
    () => new Base({}, pick(['bruneton'])),
    /model 'preetham' needs preetham/,
    'Preetham stays the default model',
  );
  assert.throws(() => new Base({ model: 'preetham' }), /needs preetham/);
  assert.throws(
    () => new Base({ clouds: null }, pick(['clouds'])),
    /Invalid sky clouds/,
    'Feature validation still runs',
  );
  const night = new Base({ hours: 0, timeScale: 0, night: {} }, pick(['night']));
  night.onPreUpdate(0);
  assert.equal(night.nightFactor, 1);
  night.options.hours = 12;
  assert.throws(() => night.onPreUpdate(0), /Daylight needs a day model/);
  const h = optionalGPU(),
    plain = new Base({ hours: 0, timeScale: 0 });
  h.engine.use(plain);
  h.frame();
  assert.equal(plain.reflectionTexture, undefined, 'Reflection needs its feature');
  h.frame();
  assert.ok(h.pipelines.every((p) => (p.compute?.entryPoint ?? p.fragment.entryPoint) !== 'reflectSky'));
  plain.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});
