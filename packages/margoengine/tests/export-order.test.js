import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KITS } from '../../../scripts/umbrella.mjs';

test('every published umbrella alias source is in the Git index, including newly generated files', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z', '--', 'packages/margoengine/src'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    }).split('\0'),
  );
  for (const [entry, target] of Object.entries(manifest.exports)) {
    const source = target.import.replace('./dist/', 'packages/margoengine/src/').replace(/\.js$/, '.ts');
    assert.ok(
      tracked.has(source),
      `${entry}: ${source} is not in the Git index; stage every generated alias before pushing`,
    );
  }
});

test('umbrella groups follow package order and materials entries follow their owning manifest', () => {
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const materials = JSON.parse(readFileSync(new URL('../../materials/package.json', import.meta.url)));
  const aliases = Object.keys(root.exports).filter((key) => key !== '.' && !(key.slice(2) in KITS));
  const groups = [...new Set(aliases.map((key) => key.split('/')[1]))];
  assert.deepEqual(groups, [...groups].sort(), 'package groups use the generator order');
  const expected = Object.keys(materials.exports).map((key) => './materials' + key.slice(1));
  assert.deepEqual(
    aliases.filter((key) => key === './materials' || key.startsWith('./materials/')),
    expected,
    'an optional entry is inserted into its owning package group, not a locale-sorted export map',
  );
});
