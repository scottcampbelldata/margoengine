import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { bundleBytes } from '../../../scripts/measure-size.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// Public budgets can become stale when a shared size ratchet shrinks them, even without a source edit here.
test('mixer public current entry bytes and budgets match built entries and the shared size baseline', async () => {
  const limits = readFileSync(join(root, 'docs/limits.md'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'packages/mixer/package.json'), 'utf8'));
  const budgets = JSON.parse(readFileSync(join(root, 'scripts/quality/baselines/sizes.json'), 'utf8')).items;
  const labels = { '.': 'Mixer root', './sidechain': 'Sidechain', './snapshots': 'Snapshots',
    './worklet': 'Worklet', './reflections': 'Reflections', './loudness': 'Loudness' };
  for (const [entry, label] of Object.entries(labels)) {
    const match = limits.match(new RegExp(`${label} entry: ([\\d,]+) B gzip, budget ([\\d,]+) B[.;]`));
    assert.ok(match, `Document the current ${label} entry bytes and budget`);
    const specifier = '@margoengine/mixer' + (entry === '.' ? '' : entry.slice(1));
    const bytes = gzipSync(await bundleBytes(join(root, 'packages/mixer', manifest.exports[entry].import))).length;
    assert.equal(Number(match[1].replaceAll(',', '')), bytes, `${specifier} public bytes`);
    assert.equal(Number(match[2].replaceAll(',', '')), budgets[specifier], `${specifier} public budget`);
  }
});
