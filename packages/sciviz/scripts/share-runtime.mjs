// The offline application chooses its fallback. The library never imports a backend.
import { startStandalone as start } from '@margoengine/sciviz/share';
export * from '@margoengine/sciviz/share';
export function startStandalone(options = {}) {
  return start({
    prepareBackend: async (options) => {
      options.signal?.throwIfAborted();
      const { install } = await import('@margoengine/webgl2-compat');
      options.signal?.throwIfAborted();
      return install(options);
    },
    ...options,
  });
}
