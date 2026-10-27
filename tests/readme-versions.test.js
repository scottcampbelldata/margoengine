// A package README that names its own version must name the one in its package.json. Catches the README that says
// "version `0.1.0`" after the package moved to 1.0.0. Pattern: "Package name: `<name>`, version `X`" and
// "Version `X` is source-only". Peer ranges ("core peer ^0.1.0 || ^1.0.0") are not versions of the package and are not read.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('package READMEs name the version in their package.json', () => {
  const wrong = [];
  let checked = 0;
  for (const dir of readdirSync(join(root, 'packages'))) {
    const readme = join(root, 'packages', dir, 'README.md'),
      manifest = join(root, 'packages', dir, 'package.json');
    if (!existsSync(readme) || !existsSync(manifest)) continue;
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version,
      text = readFileSync(readme, 'utf8');
    for (const [, first, second] of text.matchAll(
      /Package name: `[^`]+`, version `([^`]+)`|^Version `([^`]+)` is source-only/gm,
    )) {
      const claimed = first ?? second;
      checked++;
      if (claimed !== version) wrong.push(`packages/${dir}/README.md says ${claimed}, package.json says ${version}`);
    }
  }
  assert.ok(checked >= 1, 'expected at least one README to name its version');
  assert.deepEqual(wrong, [], 'update the README text to the package.json version');
});
