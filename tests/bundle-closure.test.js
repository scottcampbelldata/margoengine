import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLES, BUNDLE_DENIED, bundleLeaks, closureOf, readPackages } from '../scripts/check-bundle-closure.mjs';
import { KIT_MEMBERS } from '../scripts/umbrella.mjs';

test('each bundle closure stays inside its allowed packages', () => {
  const problems = bundleLeaks();
  assert.deepEqual(
    problems,
    [],
    problems
      .map(({ bundle, extra, denied }) => `${bundle}: extra ${extra.join(', ')}; denied ${denied.join(', ')}`)
      .join('\n'),
  );
});

test('the shared base is the same 23 packages in every bundle', () => {
  const base = KIT_MEMBERS.cad.filter((name) => name !== 'brep' && name !== 'cad-import');
  assert.equal(base.length, 23);
  for (const bundle of BUNDLES) for (const name of base) assert.ok(KIT_MEMBERS[bundle].includes(name), `${bundle} ${name}`);
});

test('compute is in games and science, and the add-ons are in none', () => {
  assert.ok(KIT_MEMBERS.games.includes('compute'));
  assert.ok(KIT_MEMBERS.science.includes('compute'));
  assert.ok(KIT_MEMBERS.games.includes('road'));
  const packages = readPackages();
  for (const bundle of BUNDLES) {
    const closure = closureOf(`@margoengine/${bundle}`, packages);
    for (const name of BUNDLE_DENIED) assert.equal(closure.has(`@margoengine/${name}`), false, `${bundle} ${name}`);
  }
});
