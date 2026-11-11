// The desktop demo check measures the full quality tier. @margoengine/quality starts an unmeasured page on the light
// tier, and `?quality=high` pins the full tier (packages/quality, applyQualityTier).
export function desktopTierURL(path, base) {
  const url = new URL(path, base);
  url.searchParams.set('quality', 'high');
  return url.href;
}
