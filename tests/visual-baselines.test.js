import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertBaselineIdentity,
  assertCaptureEnvironment,
  assertProfileCreationCoverage,
  renderedInputChanges,
  selectBaselineProfile,
} from '../scripts/support/visual-baselines.js';

const legacy = { gpu: 'intel xe-2lpg', browser: 'msedge 155.0.4283.45' };

test('Intel legacy baselines survive whitespace, case, and browser patch updates', () => {
  assert.deepEqual(selectBaselineProfile({ gpu: ' \tINTEL  Xe-2LPG\n', browser: ' MSEdge   155.0.4283.60 ' }, legacy), {
    id: 'legacy',
    directory: '',
  });
});

test('a different GPU gets a deterministic safe profile directory', () => {
  const environment = { gpu: ' NVIDIA / Ampere: GeForce RTX 3070 (D3D12) ', browser: 'msedge 155.0.4283.60' };
  assert.deepEqual(selectBaselineProfile(environment, legacy), {
    id: 'nvidia-ampere-geforce-rtx-3070-d3d12-msedge-155',
    directory: 'profiles/nvidia-ampere-geforce-rtx-3070-d3d12-msedge-155',
  });
  assert.deepEqual(
    selectBaselineProfile({ ...environment, gpu: 'nvidia / ampere: geforce rtx 3070 (d3d12)' }, legacy),
    {
      id: 'nvidia-ampere-geforce-rtx-3070-d3d12-msedge-155',
      directory: 'profiles/nvidia-ampere-geforce-rtx-3070-d3d12-msedge-155',
    },
  );
});

for (const [browser, id] of [
  ['msedge 156.0.0.1', 'intel-xe-2lpg-msedge-156'],
  ['chrome 155.0.4283.60', 'intel-xe-2lpg-chrome-155'],
  ['msedge-beta 155.0.4283.60', 'intel-xe-2lpg-msedge-beta-155'],
])
  test(`browser ${browser} gets a distinct profile`, () => {
    assert.deepEqual(selectBaselineProfile({ ...legacy, browser }, legacy), { id, directory: `profiles/${id}` });
  });

test('GPU punctuation cannot escape the profiles directory', () => {
  assert.deepEqual(selectBaselineProfile({ gpu: '../../NVIDIA\\RTX: 3070?*', browser: 'msedge 155.0.1' }, legacy), {
    id: 'nvidia-rtx-3070-msedge-155',
    directory: 'profiles/nvidia-rtx-3070-msedge-155',
  });
});

test('a GPU slug collision cannot select legacy baselines', () => {
  assert.deepEqual(selectBaselineProfile({ ...legacy, gpu: 'intel xe/2lpg' }, legacy), {
    id: 'intel-xe-2lpg-msedge-155',
    directory: 'profiles/intel-xe-2lpg-msedge-155',
  });
});

for (const [name, environment] of [
  ['missing environment', undefined],
  ['null environment', null],
  ['missing GPU', { browser: legacy.browser }],
  ['non-string GPU', { ...legacy, gpu: 3070 }],
  ['empty GPU', { ...legacy, gpu: ' \t ' }],
  ['unknown GPU', { ...legacy, gpu: 'Unknown' }],
  ['unavailable GPU', { ...legacy, gpu: 'n/a' }],
  ['GPU without a safe slug', { ...legacy, gpu: '../\\?*' }],
  ['missing browser', { gpu: legacy.gpu }],
  ['non-string browser', { ...legacy, browser: 155 }],
  ['unknown browser', { ...legacy, browser: 'unknown 155.0' }],
  ['missing browser version', { ...legacy, browser: 'msedge' }],
  ['invalid browser version', { ...legacy, browser: 'msedge latest' }],
  ['invalid browser family', { ...legacy, browser: '../msedge 155.0' }],
  ['zero browser major', { ...legacy, browser: 'msedge 0.0.1' }],
  ['unsafe browser major', { ...legacy, browser: 'msedge 9007199254740992.0' }],
])
  test(`profile selection rejects ${name} instead of guessing a baseline`, () => {
    assert.throws(() => selectBaselineProfile(environment, legacy), {
      name: 'TypeError',
      message: /GPU|browser|environment/i,
    });
    assert.throws(() => selectBaselineProfile(legacy, environment), TypeError);
    assert.throws(() => assertBaselineIdentity(environment, legacy), TypeError);
    assert.throws(() => assertBaselineIdentity(legacy, environment), TypeError);
  });

test('manifest identity accepts normalized GPU and matching browser major with a different patch', () => {
  assert.doesNotThrow(() =>
    assertBaselineIdentity(legacy, { gpu: ' Intel  Xe-2LPG ', browser: 'MSEDGE 155.0.4283.60' }),
  );
});

for (const [name, environment] of [
  ['different GPU', { ...legacy, gpu: 'nvidia ampere' }],
  ['colliding GPU slug', { ...legacy, gpu: 'intel xe/2lpg' }],
  ['different browser family', { ...legacy, browser: 'chrome 155.0.4283.60' }],
  ['different browser major', { ...legacy, browser: 'msedge 156.0.0.1' }],
])
  test(`manifest identity rejects a ${name} before baseline reuse`, () => {
    assert.throws(() => assertBaselineIdentity(legacy, environment), {
      name: 'TypeError',
      message: /baseline.*identity.*capture/i,
    });
  });

test('new profile creation accepts the complete view set in any order', () => {
  assert.doesNotThrow(() =>
    assertProfileCreationCoverage(['earth-phone', 'earth-high'], ['earth-high', 'earth-phone']),
  );
});

test('new profile creation rejects dirty packages even with the complete view set', () => {
  assert.throws(() => assertProfileCreationCoverage(['earth-high'], ['earth-high'], true), {
    name: 'MargoError',
    code: 'state',
    message: /rendered inputs.*uncommitted.*commit or restore/i,
  });
});

for (const [name, selected, all] of [
  ['a subset', ['earth-high'], ['earth-high', 'earth-phone']],
  ['an extra view', ['earth-high', 'dof-high'], ['earth-high']],
  ['duplicate selected views', ['earth-high', 'earth-high'], ['earth-high', 'earth-phone']],
  ['duplicate catalog views', ['earth-high'], ['earth-high', 'earth-high']],
  ['no selected views', [], ['earth-high']],
  ['an empty catalog', [], []],
  ['an empty selected ID', [''], ['earth-high']],
  ['an empty catalog ID', ['earth-high'], ['']],
  ['a whitespace ID', [' '], [' ']],
  ['a non-string ID', [42], [42]],
  ['a missing selection', undefined, ['earth-high']],
  ['a missing catalog', ['earth-high'], undefined],
])
  test(`new profile creation rejects ${name} with full-capture guidance`, () => {
    assert.throws(() => assertProfileCreationCoverage(selected, all), {
      name: 'TypeError',
      message: /new profile requires.*full view capture/i,
    });
  });

test('repeated captures accept the same GPU and exact browser version', () => {
  assert.doesNotThrow(() =>
    assertCaptureEnvironment(legacy, { gpu: ' INTEL  Xe-2LPG ', browser: 'MSEDGE 155.0.4283.45' }),
  );
});

for (const [name, environment] of [
  ['GPU switch', { ...legacy, gpu: 'nvidia ampere' }],
  ['browser patch switch', { ...legacy, browser: 'msedge 155.0.4283.60' }],
  ['browser channel switch', { ...legacy, browser: 'chrome 155.0.4283.45' }],
])
  test(`capture noise refuses a ${name} within one run`, () => {
    assert.throws(() => assertCaptureEnvironment(legacy, environment), { name: 'MargoError', code: 'state' });
  });

test('rendered input changes include tracked and untracked sources in every rendered root', () => {
  assert.deepEqual(
    renderedInputChanges('packages/core/src/shaders.ts\0examples/demo.ts\0site/index.html\0', 'apps/demo/index.ts\0'),
    ['packages/core/src/shaders.ts', 'examples/demo.ts', 'site/index.html', 'apps/demo/index.ts'],
  );
});

test('rendered input guard permits only the exact power harness and generated measurements', () => {
  assert.deepEqual(
    renderedInputChanges(
      'examples/package-benchmarks/cad/power.mjs\0examples/package-benchmarks/results/basic-scene-network.json\0',
      'examples/package-benchmarks/results/entry-sizes.json\0',
    ),
    [],
  );
  assert.deepEqual(
    renderedInputChanges('examples/package-benchmarks/results/scene.json\0examples/demos/power.mjs\0', ''),
    ['examples/package-benchmarks/results/scene.json', 'examples/demos/power.mjs'],
  );
});

test('rendered input paths retain whitespace and do not confuse root prefixes or case variants', () => {
  assert.deepEqual(renderedInputChanges('examples/a\nb.js\0examples-old/demo.js\0Packages/Core.ts\0', ''), [
    'examples/a\nb.js',
    'Packages/Core.ts',
  ]);
  assert.deepEqual(renderedInputChanges('Examples/package-benchmarks/cad/power.mjs\0', ''), [
    'Examples/package-benchmarks/cad/power.mjs',
  ]);
});

test('rendered input changes deduplicate paths across tracked and untracked records', () => {
  assert.deepEqual(renderedInputChanges('examples/demo.ts\0', 'examples/demo.ts\0'), ['examples/demo.ts']);
});

test('empty semantic source diffs stay clean despite unrelated stat metadata', () => {
  assert.deepEqual(renderedInputChanges('', ''), []);
});

for (const paths of ['examples/demo.ts', undefined])
  test(`rendered input guard rejects malformed path records ${JSON.stringify(paths)}`, () => {
    assert.throws(() => renderedInputChanges(paths, ''), TypeError);
  });

test('an example-only change blocks creation even when packages are clean', () => {
  const changes = renderedInputChanges('examples/demo.ts\0', '');
  assert.throws(() => assertProfileCreationCoverage(['view'], ['view'], changes.length > 0), {
    name: 'MargoError',
    code: 'state',
  });
});
