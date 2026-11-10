import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('workspace manifests and quality baselines remain valid JSON after concurrent landings', () => {
  const root = new URL('../', import.meta.url);
  const files = [
    'package.json',
    ...JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
      .workspaces.filter((name) => name.startsWith('packages/'))
      .map((name) => `${name}/package.json`),
    ...readdirSync(new URL('scripts/quality/baselines/', root))
      .filter((name) => name.endsWith('.json'))
      .map((name) => `scripts/quality/baselines/${name}`),
  ];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(new URL(file, root), 'utf8'));
    if (file.startsWith('scripts/quality/baselines/') && parsed.total !== undefined)
      assert.equal(
        parsed.total,
        Object.values(parsed.items).reduce((a, b) => a + b, 0),
        file,
      );
  }
});
