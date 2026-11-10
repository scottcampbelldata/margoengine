import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KITS } from '../../../scripts/umbrella.mjs';

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
