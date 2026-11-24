import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KIT_MEMBERS, umbrellaFiles } from '../scripts/umbrella.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url)));

test('core is standalone and stage requires only core, with every other peer optional', () => {
  const core = read('core'), stage = read('stage');
  for (const [name, manifest] of [['core', core], ['stage', stage]]) {
    const required = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
    for (const peer of Object.keys(manifest.peerDependencies ?? {}))
      if (!manifest.peerDependenciesMeta?.[peer]?.optional) required.push(peer);
    assert.deepEqual([...new Set(required)].sort(), name === 'core' ? [] : ['@margoengine/core']);
  }
});

test('install profiles are generated in step with the umbrella, with only their exported members required', () => {
  const generated = umbrellaFiles();
  for (const name of Object.keys(KIT_MEMBERS)) {
    const path = `packages/${name}/package.json`;
    assert.deepEqual(read(name), JSON.parse(generated[path]));
    assert.ok(!read(name).dependencies.margoengine, 'a kit must never install the umbrella');
    for (const target of Object.values(read(name).exports)) {
      const file = `packages/${name}/src/${target.import.slice('./dist/'.length).replace(/\.js$/, '.ts')}`;
      assert.equal(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'), generated[file]);
    }
  }
});
