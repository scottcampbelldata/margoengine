// Page side of the traced effects' GPU legs (rt-gi-browser.mjs, rt-reflections-browser.mjs), run before Engine.create:
// - 'half-float' or 'ldr': the WebGL2 layer on that tier (/tiers, its float targets masked);
// - 'compatibility': native WebGPU at the compatibility feature level, with the adapter's limits;
// - 'short': the same level with one storage buffer fewer in a fragment shader than the traced pass binds (`need`); the
//   level's default, 4, is the least a browser gives, so only a `need` of at least 5 (RTGI) can be short.
// Collects console.warn calls into the returned array.
export async function tracedDevice(mode, need) {
  const warnings = [],
    warn = console.warn;
  console.warn = (...args) => {
    warnings.push(args[0]);
    warn.apply(console, args);
  };
  if (mode === 'half-float' || mode === 'ldr') {
    const { maskTier } = await import('/packages/webgl2-compat/test/support/mask-tier.js'),
      { installTiers } = await import('/packages/webgl2-compat/dist/tiers.js'),
      result = await installTiers({
        force: true,
        createContext: (attributes) => maskTier(new OffscreenCanvas(1, 1).getContext('webgl2', attributes), mode),
      });
    if (!result.installed) throw Error(`tiers did not install: ${result.reason}`);
  } else if (mode === 'compatibility' || mode === 'short') {
    const { allowCompatibilityAdapters } = await import('/packages/webgl2-compat/dist/adapter.js');
    allowCompatibilityAdapters({ force: true });
    if (mode === 'short') {
      const gpu = navigator.gpu,
        requestAdapter = gpu.requestAdapter;
      gpu.requestAdapter = async (options) => {
        const adapter = await requestAdapter.call(gpu, options),
          requestDevice = adapter.requestDevice;
        adapter.requestDevice = (descriptor) =>
          requestDevice.call(adapter, {
            ...descriptor,
            requiredLimits: { ...descriptor?.requiredLimits, maxStorageBuffersInFragmentStage: need - 1 },
          });
        return adapter;
      };
    }
  }
  return warnings;
}

/** What device a leg ran on, for its report. */
export function legDevice(engine) {
  const device = engine.gpu,
    tier = device.adapter?.capabilities?.tier;
  if (tier || globalThis.__margoCompat) return `webgl2-layer${tier ? ` (${tier})` : ''}`;
  if (!device.features.has('core-features-and-limits'))
    return `webgpu compatibility level (fragment storage buffers ${device.limits.maxStorageBuffersInFragmentStage})`;
  return 'webgpu';
}
