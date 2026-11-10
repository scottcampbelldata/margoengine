import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the package GPU gate runs every parity case on both native and compatibility backends', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))),
    commands = Object.entries(manifest.scripts)
      .filter(([name]) => name.startsWith('test:') && name.includes('gpu'))
      .flatMap(([, script]) => script.split(' && '))
      .filter((command) => command.includes('test/parity.mjs'));
  assert.equal(commands.length, 2, 'standalone parity checks must be part of the recurring package GPU gate');
  assert.ok(
    commands.every((command) => command.includes('--all')),
    'every parity case runs in CI',
  );
  assert.equal(
    commands.filter((command) => command.includes('--compat')).length,
    1,
    'one native and one compatibility run',
  );
});
