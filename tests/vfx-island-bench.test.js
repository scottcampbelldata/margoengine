// benchmark-vfx-island.js measures the Afterlight island at 1,000,000 particles with timestamp queries. A fresh
// browser profile starts on the light quality tier (100,000 particles, no timestamp request), so the bench failed
// its own scene checks until it pinned the full tier and asked for timestamps itself.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyQualityTier, QUALITY_PRESETS } from '../packages/quality/dist/index.js';

const bench = readFileSync(new URL('../scripts/benchmark-vfx-island.js', import.meta.url), 'utf8');

test('the island bench pins the full tier, whose VFX keeps the 1,000,000 default', () => {
  assert.match(bench, /capacity = 1_000_000/);
  assert.match(bench, /127\.0\.0\.1:5199\/\?quality=high/);
  assert.equal(applyQualityTier({ search: '?quality=high', page: '/', storage: null, session: null, userAgent: '' }), 'high');
  assert.equal(QUALITY_PRESETS.high.vfx?.capacity, undefined);
  assert.equal(applyQualityTier({ search: '', page: '/', storage: null, session: null, userAgent: '' }), 'light');
  assert.equal(QUALITY_PRESETS.light.vfx.capacity, 100_000);
});

test('the island bench requests timestamp queries when the adapter has them', () => {
  assert.match(bench, /requiredFeatures: \[\.\.\.wanted, 'timestamp-query'\]/);
});
