// The desktop demo check asserts the full tier (DPR 1 backing, 4x MSAA) but opened pages without a tier, and a fresh
// profile starts on the light tier, so every demo failed its DPR and MSAA checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { desktopTierURL } from '../scripts/support/desktop-tier.mjs';

test('desktopTierURL pins the full quality tier and keeps the query', () => {
  assert.equal(desktopTierURL('/demos/citadel/?seed=2', 'http://127.0.0.1:4173'), 'http://127.0.0.1:4173/demos/citadel/?seed=2&quality=high');
  assert.equal(desktopTierURL('/x/?quality=light', 'http://h/'), 'http://h/x/?quality=high');
});

test('the desktop demo check opens every demo on the pinned tier', () => {
  const source = readFileSync(new URL('../scripts/desktop-demo-tests.js', import.meta.url), 'utf8');
  assert.match(source, /url: desktopTierURL\(demo\.path, baseUrl\)/);
});

test('the pinned URL gives the full tier on a fresh profile, the bare URL the light tier', async () => {
  const { applyQualityTier } = await import('../packages/quality/dist/index.js');
  const fresh = { getItem: () => null, setItem() {} };
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const base = 'http://127.0.0.1:4173';
  const pinned = new URL(desktopTierURL('/demos/citadel/', base));
  assert.equal(applyQualityTier({ search: pinned.search, page: pinned.pathname, storage: fresh, session: fresh, userAgent }), 'high');
  assert.equal(applyQualityTier({ search: '', page: '/demos/citadel/', storage: fresh, session: fresh, userAgent }), 'light');
});
