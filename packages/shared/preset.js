// Tier presets contract: @margoengine/quality's applyQualityTier() sets `globalThis.margoPreset` (one plain object per
// feature key, values named exactly like that feature's options). Feature packages never import the quality package;
// they read this global once, when an effect is constructed. Tests: packages/quality/test/quality.test.js (writer) and
// tests/quality-presets.test.js (every reader).
/** `options` with every value the app left undefined filled from the tier preset for `key`. Without a preset it returns
 * `options` itself, so apps that do not use @margoengine/quality run exactly as before. Explicit options always win. */
export function preset(key, options) {
  const values = globalThis.margoPreset?.[key];
  if (!values) return options;
  const out = { ...options };
  for (const name in values) out[name] ??= values[name];
  return out;
}
